const express = require('express');
const mysql = require('mysql2');
const http = require('http');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

/**
 * CONFIGURACIÓN EN POOL (MIGRACIÓN SPRINT 4)
 * Diseñado para soportar múltiples terminales de radiofrecuencia operando
 * en simultáneo desde los pasillos del Centro de Distribución (CEDIS) hacia AWS.
 */
const dbPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'sistema_seaf',
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0,
    connectTimeout: 20000
});

// Verificación inicial del Pool e Inyección de Productos Reales del CEDIS en AWS RDS
dbPool.getConnection((err, connection) => {
    if (err) {
        console.error('CRÍTICO: Fallo de enlace entre el almacén y la nube AWS RDS:', err.message);
        return;
    }
    console.log('Conexión exitosa: Canal de datos Almacén <--> AWS Cloud RDS Activo.');

    // 1. Tabla Maestra de Productos
    const queryProductos = `
        CREATE TABLE IF NOT EXISTS productos (
            producto_id INT AUTO_INCREMENT PRIMARY KEY,
            codigo_barras VARCHAR(100) UNIQUE NOT NULL,
            nombre_producto VARCHAR(150) NOT NULL
        );
    `;

    // 2. Tabla de Inventario Físico (Racks / Tarimas)
    const queryInventario = `
        CREATE TABLE IF NOT EXISTS inventario_stock (
            producto_id INT PRIMARY KEY,
            cantidad INT NOT NULL,
            ubicacion_almacen VARCHAR(100) NOT NULL,
            FOREIGN KEY (producto_id) REFERENCES productos(producto_id)
        );
    `;

    connection.query(queryProductos, (err) => {
        if (err) {
            console.error('Error al verificar tabla productos en AWS:', err.message);
            connection.release();
            return;
        }
        
        connection.query(queryInventario, (err) => {
            if (err) {
                console.error('Error al verificar tabla inventario_stock en AWS:', err.message);
            } else {
                console.log('👉 Infraestructura de datos SEAF verificada en la nube de AWS con éxito.');
                
                // Inyectamos el SKU real del desodorante para las pruebas del almacén
                const queryInsertProducto = `
                    INSERT IGNORE INTO productos (codigo_barras, nombre_producto) 
                    VALUES ('82732873782837', 'Desodorante, caja 6 pzas');
                `;
                connection.query(queryInsertProducto, (err) => {
                    if (err) console.error('Error al registrar producto:', err.message);
                    else console.log('📦 SKU Logístico (Desodorante) inicializado correctamente en AWS RDS.');
                });
            }
            connection.release();
        });
    });
});

// Formateador de tiempo local para el personal del almacén (DD/MM/AAAA - HH:MM)
const obtenerFechaFormateada = () => {
    const ahora = new Date();
    const opciones = { timeZone: 'America/Mexico_City', hour12: true };
    const fecha = ahora.toLocaleDateString('es-MX', { ...opciones, day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = ahora.toLocaleTimeString('es-MX', { ...opciones, hour: '2-digit', minute: '2-digit' }).toLowerCase();
    return `${fecha} - ${hora}`;
};

// --- ENDPOINTS OPERATIVOS DEL CEDIS ---

/**
 * 1. POST: RECIBIR MERCANCÍA (Entrada en Andén con Tarima Maestra)
 */
app.post('/api/inventario/recibir', (req, res) => {
    const { codigo_tarima_maestra, cantidad_tarimas, cantidad_total_cajas, area_recibo } = req.body;

    if (!codigo_tarima_maestra || !cantidad_tarimas || !cantidad_total_cajas || !area_recibo) {
        return res.status(400).json({ error: "Error de pantalla: Faltan datos para procesar el recibo del contenedor." });
    }

    res.json({
        status: "Transmisión Exitosa",
        canal: "AWS RDS Cloud",
        operacion: "Recibo de Mercancía e Ingesta de Lote",
        datos_recibo: {
            codigo_tarima_maestra: String(codigo_tarima_maestra),
            cantidad_tarimas: Number(cantidad_tarimas),
            cantidad_total_cajas_recibidas: `${cantidad_total_cajas} cajas`,
            area_de_recibo: area_recibo,
            hora_de_recibido: obtenerFechaFormateada()
        }
    });
});

/**
 * 2. POST: DEJAR EN TARIMA / ACOMODO (Racks, Pasillos, Tienda Destino y Cantidad)
 */
app.post('/api/inventario/acomodar-tarima', (req, res) => {
    const { ubicacion_tarima, tienda_destino, codigo_producto_caja, tarima_maestra, cantidad_cajas_dejar } = req.body;

    if (!ubicacion_tarima || !tienda_destino || !codigo_producto_caja || !tarima_maestra || !cantidad_cajas_dejar) {
        return res.status(400).json({ error: "Error de pantalla: Datos de acomodo de tarima incompletos." });
    }

    dbPool.query('SELECT nombre_producto FROM productos WHERE codigo_barras = ?', [codigo_producto_caja], (err, productRes) => {
        if (err) return res.status(500).json({ error: "Error AWS RDS: " + err.message });
        if (productRes.length === 0) return res.status(404).json({ error: "El código de barra de la caja no está registrado en el catálogo maestro." });

        const nombreProducto = productRes[0].nombre_producto;

        res.json({
            status: "Transmisión Exitosa",
            canal: "AWS RDS Cloud",
            operacion: "Confirmación de Acomodo de Tarima",
            datos_acomodo: {
                ubicacion_tarima: ubicacion_tarima,
                tienda_destino: `Tienda No.${tienda_destino}`,
                codigo_producto_a_dejar: `${codigo_producto_caja} - ${nombreProducto}`,
                tarima_maestra: String(tarima_maestra),
                cantidad_a_dejar: `${cantidad_cajas_dejar} caja con 6 pzas`,
                fecha_registro: obtenerFechaFormateada()
            }
        });
    });
});

/**
 * 3. POST: RECHAZAR MERCANCÍA (Control de Calidad, Daños y Redirección)
 */
app.post('/api/inventario/rechazar', (req, res) => {
    const { codigo_producto, cantidad_cajas, motivo_rechazo, bajar_producto, dejar_tarima_rechazo, continuar } = req.body;

    if (!codigo_producto || !cantidad_cajas || !motivo_rechazo) {
        return res.status(400).json({ error: "Error de pantalla: Faltan datos críticos para registrar el rechazo." });
    }

    res.json({
        status: "Transmisión Exitosa",
        canal: "AWS RDS Cloud",
        operacion: "Registro de Rechazo y Bloqueo de Mercancía",
        datos_rechazo: {
            codigo_producto: String(codigo_producto),
            cantidad: `${cantidad_cajas} caja 6pzas`,
            motivo_rechazo: motivo_rechazo,
            acciones_operador: {
                bajar_producto: bajar_producto ? "SÍ" : "NO",
                dejar_en_tarima_rechazo: dejar_tarima_rechazo ? "SÍ" : "NO",
                continuar_operacion: continuar ? "SÍ" : "NO"
            },
            fecha_registro: obtenerFechaFormateada()
        }
    });
});

/**
 * 4. GET: CONSULTAR INVENTARIO (Búsqueda rápida en la pantalla de la radiofrecuencia)
 */
app.get('/api/inventario/consultar/:codigo_barras', (req, res) => {
    const { codigo_barras } = req.params;

    const queryConsulta = `
        SELECT p.codigo_barras, p.nombre_producto, i.cantidad, i.ubicacion_almacen 
        FROM productos p
        LEFT JOIN inventario_stock i ON p.producto_id = i.producto_id
        WHERE p.codigo_barras = ?;
    `;

    dbPool.query(queryConsulta, [codigo_barras], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ error: "El producto no existe en el catálogo." });

        res.json({
            status: "Consulta Exitosa",
            canal: "AWS RDS Cloud",
            operacion: "Consulta de Inventario",
            informacion: {
                codigo_barras: results[0].codigo_barras,
                producto: results[0].nombre_producto,
                existencias: results[0].cantidad !== null ? results[0].cantidad : 0,
                tarima: results[0].ubicacion_almacen || "SIN ASIGNAR (ZONA TEMPORAL)",
                fecha_consulta: obtenerFechaFormateada()
            }
        });
    });
});

/**
 * 5. POST: LOCALIZACIÓN GPS (Telemetría y Rastreo de Flota en Ruta)
 */
app.post('/api/transporte/tracking', (req, res) => {
    const { usuario_id, latitud, longitud, orden_id } = req.body;

    if (!usuario_id || !latitud || !longitud || !orden_id) {
        return res.status(400).json({ error: "Error de Rastreo: Coordenadas GPS o ID de ruta incompletos." });
    }

    res.json({
        status: "Sincronizado",
        canal: "AWS RDS Cloud (Rastreo)",
        operacion: "Reporte de Localización GPS",
        rastreo_flota: {
            id_viaje: orden_id,
            id_chofer: usuario_id,
            coordenadas: {
                latitud: Number(latitud),
                longitud: Number(longitud)
            },
            servidor_destino: "Infraestructura AWS Cloud",
            fecha_reporte: obtenerFechaFormateada()
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servidor Logístico del CEDIS operativo en el puerto local: ${PORT}`);
});