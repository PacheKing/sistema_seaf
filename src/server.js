const express = require('express');
const mysql = require('mysql2');
const http = require('http');
const { Server } = require('socket.io'); 
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('Error crítico de conexión a la Base de Datos en Docker:', err.message);
        return;
    }
    console.log('Conexión exitosa a MySQL en el contenedor Docker (Sistema SEAF).');
});

io.on('connection', (socket) => {
    console.log(`Dispositivo conectado al ecosistema SEAF en Tiempo Real (ID: ${socket.id})`);
    
    // Escuchar reconexiones de terminales que estuvieron offline por fallas de Wi-Fi
    socket.on('rf-recuperar-senal', (datosSincronizados) => {
        console.log(`[Resiliencia Wi-Fi] Terminal recobró señal. Sincronizando cola de datos pendientes...`);
        // Emitir de inmediato al panel central las actualizaciones encoladas de manera asíncrona
        io.emit('notificacion-stock-masiva', datosSincronizados);
    });

    socket.on('disconnect', () => {
        console.log(`Dispositivo desconectado del tiempo real: ${socket.id}`);
    });
});

// --- ENDPOINTS CORE ---

app.get('/', (req, res) => {
    res.json({
        proyecto: "Sistema de Entrega y Almacenamiento Facilitador (SEAF)",
        estado: "Servidor de Pruebas Activo - Segunda Fase Completa",
        status: "OK"
    });
});

/**
 * ACUERDO 4: Escaneo RF con validaciones estrictas anti-caracteres erróneos y vacíos
 */
app.post('/api/inventario/escanear', (req, res) => {
    const { codigo_barras, cantidad_cambio, ubicacion } = req.body;

    // 1. Validación de campos vacíos o nulos
    if (!codigo_barras || cantidad_cambio === undefined || !ubicacion) {
        return res.status(400).json({ error: "Estructura rechazada: Los campos 'codigo_barras', 'cantidad_cambio' y 'ubicacion' no pueden estar vacíos." });
    }

    // 2. Expresión regular para bloquear caracteres especiales maliciosos o lecturas corruptas de la RF
    // Solo permite letras, números, espacios y guiones medios/bajos básicos
    const regexEstructuraValida = /^[a-zA-Z0-9_\-\s]+$/;

    if (!regexEstructuraValida.test(codigo_barras) || !regexEstructuraValida.test(ubicacion)) {
        return res.status(400).json({ 
            error: "Formato erróneo detectado: Se bloquearon caracteres especiales corruptos o no permitidos provenientes de la terminal RF." 
        });
    }

    // 3. Validar si el producto existe en la BD
    db.query('SELECT producto_id, nombre_producto FROM productos WHERE codigo_barras = ?', [codigo_barras], (err, productRes) => {
        if (err) return res.status(500).json({ error: err.message });
        if (productRes.length === 0) return res.status(404).json({ error: "El código de barras escaneado no existe en el catálogo maestro." });

        const productoId = productRes[0].producto_id;
        const nombreProducto = productRes[0].nombre_producto;

        const updateQuery = `
            INSERT INTO inventario_stock (producto_id, cantidad, ubicacion_almacen)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad);
        `;

        db.query(updateQuery, [productoId, cantidad_cambio, ubicacion], (err, updateRes) => {
            if (err) {
                if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
                    return res.status(400).json({ error: "Operación rechazada: El stock resultante no puede ser menor a cero unidades." });
                }
                return res.status(500).json({ error: err.message });
            }

            // Transmisión en tiempo real inferior a 1 segundo al panel administrativo
            io.emit('notificacion-stock', {
                evento: "ACTUALIZACION_STOCK",
                producto: nombreProducto,
                codigo: codigo_barras,
                cambio: cantidad_cambio,
                ubicacion: ubicacion,
                fecha: new Date()
            });

            res.json({
                status: "Éxito",
                mensaje: `Inventario de '${nombreProducto}' actualizado correctamente. Canal WebSocket emitido.`
            });
        });
    });
});

/**
 * ACUERDO 3: Endpoint de Resiliencia Inalámbrica (Modo Offline Temporal)
 * Recibe ráfagas de escaneos acumulados de manera asíncrona cuando la RF pierde Wi-Fi en pasillos profundos
 */
app.post('/api/inventario/sincronizar-offline', (req, res) => {
    const { terminal_id, ráfaga_movimientos } = req.body;

    if (!terminal_id || !Array.isArray(ráfaga_movimientos) || ráfaga_movimientos.length === 0) {
        return res.status(400).json({ error: "Cola de sincronización vacía o estructura de ráfaga inválida." });
    }

    console.log(`[Resiliencia Wi-Fi] Procesando ráfaga asíncrona de ${ráfaga_movimientos.length} escaneos acumulados por la Terminal RF #${terminal_id}`);

    // Iteración lógica de la cola de transacciones guardada localmente por el dispositivo portante
    ráfaga_movimientos.forEach((movimiento) => {
        const { codigo_barras, cantidad_cambio, ubicacion } = movimiento;
        
        // Ejecución de inserciones en lote directo a MySQL
        const syncQuery = `
            INSERT INTO inventario_stock (producto_id, cantidad, ubicacion_almacen)
            SELECT producto_id, ?, ? FROM productos WHERE codigo_barras = ?
            ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad);
        `;
        db.query(syncQuery, [cantidad_cambio, ubicacion, codigo_barras]);
    });

    // Avisar en tiempo real a las PC de monitoreo central la actualización masiva de la red distribuida
    io.emit('notificacion-masiva-wi-fi', {
        terminal: terminal_id,
        total_sincronizado: ráfaga_movimientos.length,
        timestamp: new Date()
    });

    res.json({
        status: "Sincronizado",
        mensaje: `Resiliencia de Red Exitosa: Se añadiran los datos una vez se conecte a la red nuevamente ${ráfaga_movimientos.length} movimientos acumulados offline.`
    });
});

// Endpoint de Geolocalización (Módulo Transporte)
app.post('/api/transporte/tracking', (req, res) => {
    const { usuario_id, latitud, longitud, orden_id } = req.body;

    if (!usuario_id || !latitud || !longitud || !orden_id) {
        return res.status(400).json({ error: "Datos de geolocalización incompletos." });
    }

    console.log(`[API Google Maps] Ubicación Chofer ID ${usuario_id}: Lat: ${latitud}, Lng: ${longitud}`);

    io.emit('rastreo-chofer', {
        orden: orden_id,
        chofer: usuario_id,
        coordenadas: { lat: latitud, lng: longitude = longitud },
        actualizado: new Date()
    });

    res.json({
        status: "Sincronizado",
        mensaje: "Coordenadas GPS procesadas e integradas al mapa de última milla con éxito."
    });
});

server.listen(PORT, () => {
    console.log(`Servidor interconectado corriendo con éxito en http://localhost:${PORT}`);
});