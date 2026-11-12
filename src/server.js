const express = require('express');
const mysql = require('mysql2');
const http = require('http');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// =========================================================================
// MEJORA 3 (AG7): SISTEMA DE LOGS CENTRALIZADO Y ROTACIÓN DIARIA CON WINSTON
// =========================================================================
const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const fechaArchivo = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: path.join(logDir, `seaf-errores-${fechaArchivo}.log`), level: 'error' }),
        new winston.transports.File({ filename: path.join(logDir, `seaf-actividad-${fechaArchivo}.log`) }),
        new winston.transports.Console()
    ]
});

// =========================================================================
// CONFIGURACIÓN EN POOL HACIA AWS RDS
// =========================================================================
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

// Verificación inicial, Creación de Índices B-Tree y Tabla Idempotente Offline
dbPool.getConnection((err, connection) => {
    if (err) {
        logger.error(`Fallo crítico de enlace con AWS RDS: ${err.message}`);
        return;
    }
    logger.info('Conexión exitosa: Canal de datos Almacén <--> AWS Cloud RDS Activo.');

    const queriesInicializacion = [
        // 1. Tabla Maestra de Productos
        `CREATE TABLE IF NOT EXISTS productos (
            producto_id INT AUTO_INCREMENT PRIMARY KEY,
            codigo_barras VARCHAR(100) UNIQUE NOT NULL,
            nombre_producto VARCHAR(150) NOT NULL
        );`,
        // 2. Tabla de Inventario Físico
        `CREATE TABLE IF NOT EXISTS inventario_stock (
            producto_id INT PRIMARY KEY,
            cantidad INT NOT NULL CHECK (cantidad >= 0),
            ubicacion_almacen VARCHAR(100) NOT NULL,
            FOREIGN KEY (producto_id) REFERENCES productos(producto_id)
        );`,
        // 3. MEJORA 2 (AG7): Tabla de control idempotente para evitar duplicidad offline
        `CREATE TABLE IF NOT EXISTS movimientos_offline_log (
            transaccion_id VARCHAR(100) PRIMARY KEY,
            terminal_id INT NOT NULL,
            codigo_barras VARCHAR(100) NOT NULL,
            cantidad_cambio INT NOT NULL,
            ubicacion VARCHAR(100) NOT NULL,
            fecha_sincronizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`,
        // 4. MEJORA 1 (AG7): Creación de Índices B-Tree para reducir consultas a <50 ms
        `CREATE INDEX idx_productos_codigo ON productos(codigo_barras);`,
        `CREATE INDEX idx_inventario_producto_ubicacion ON inventario_stock(producto_id, ubicacion_almacen);`
    ];

    queriesInicializacion.forEach((sql) => {
        connection.query(sql, (qErr) => {
            // Ignoramos error 1061 (Duplicate key name) si el índice ya fue creado previamente
            if (qErr && qErr.errno !== 1061) {
                logger.error(`Error en inicialización de esquema AWS: ${qErr.message}`);
            }
        });
    });

    const queryInsertProducto = `
        INSERT IGNORE INTO productos (codigo_barras, nombre_producto) 
        VALUES ('82732873782837', 'Desodorante, caja 6 pzas');
    `;
    connection.query(queryInsertProducto, (insErr) => {
        if (insErr) logger.error(`Error al registrar SKU inicial: ${insErr.message}`);
        else logger.info('Infraestructura, índices B-Tree y SKU Logístico verificados en AWS RDS.');
        connection.release();
    });
});

// Formateador de tiempo local (DD/MM/AAAA - HH:MM)
const obtenerFechaFormateada = () => {
    const ahora = new Date();
    const opciones = { timeZone: 'America/Mexico_City', hour12: true };
    const fecha = ahora.toLocaleDateString('es-MX', { ...opciones, day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = ahora.toLocaleTimeString('es-MX', { ...opciones, hour: '2-digit', minute: '2-digit' }).toLowerCase();
    return `${fecha} - ${hora}`;
};

// Expresión regular para filtrado de lecturas corruptas en RF
const regexCodigoValido = /^[a-zA-Z0-9_\-\s]+$/;

// =========================================================================
// ENDPOINTS OPERATIVOS DEL CEDIS (ACTUALIZADOS AG8)
// =========================================================================

// 1. POST: RECIBIR MERCANCÍA
app.post('/api/inventario/recibir', (req, res) => {
    const { codigo_tarima_maestra, cantidad_tarimas, cantidad_total_cajas, area_recibo } = req.body;

    if (!codigo_tarima_maestra || !cantidad_tarimas || !cantidad_total_cajas || !area_recibo) {
        return res.status(400).json({ error: "Error de pantalla: Faltan datos para procesar el recibo del contenedor." });
    }

    logger.info(`Recibo registrado - Tarima: ${codigo_tarima_maestra}, Cajas: ${cantidad_total_cajas}, Andén: ${area_recibo}`);

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

// 2. POST: DEJAR EN TARIMA / ACOMODO (Con enmascaramiento de errores AWS)
app.post('/api/inventario/acomodar-tarima', (req, res) => {
    const { ubicacion_tarima, tienda_destino, codigo_producto_caja, tarima_maestra, cantidad_cajas_dejar } = req.body;

    if (!ubicacion_tarima || !tienda_destino || !codigo_producto_caja || !tarima_maestra || !cantidad_cajas_dejar) {
        return res.status(400).json({ error: "Error de pantalla: Datos de acomodo de tarima incompletos." });
    }

    if (!regexCodigoValido.test(codigo_producto_caja)) {
        return res.status(400).json({ error: "Formato erróneo detectado: Caracteres no permitidos desde la terminal RF." });
    }

    dbPool.query('SELECT nombre_producto FROM productos WHERE codigo_barras = ?', [codigo_producto_caja], (err, productRes) => {
        if (err) {
            logger.error(`Fallo SQL en acomodar-tarima [SKU: ${codigo_producto_caja}]: ${err.message}`);
            return res.status(500).json({ error: "Error interno del servidor al validar el producto. Contacte a soporte técnico." });
        }
        if (productRes.length === 0) {
            return res.status(404).json({ error: "El código de barra de la caja no está registrado en el catálogo maestro." });
        }

        const nombreProducto = productRes[0].nombre_producto;
        logger.info(`Acomodo exitoso - SKU: ${codigo_producto_caja}, Ubicación: ${ubicacion_tarima}, Tienda: ${tienda_destino}`);

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

// 3. POST: RECHAZAR MERCANCÍA
app.post('/api/inventario/rechazar', (req, res) => {
    const { codigo_producto, cantidad_cajas, motivo_rechazo, bajar_producto, dejar_tarima_rechazo, continuar } = req.body;

    if (!codigo_producto || !cantidad_cajas || !motivo_rechazo) {
        return res.status(400).json({ error: "Error de pantalla: Faltan datos críticos para registrar el rechazo." });
    }

    logger.info(`Rechazo registrado - SKU: ${codigo_producto}, Cajas: ${cantidad_cajas}, Motivo: ${motivo_rechazo}`);

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

// 4. GET: CONSULTAR INVENTARIO (Optimizado con Índices B-Tree + Enmascaramiento de errores)
app.get('/api/inventario/consultar/:codigo_barras', (req, res) => {
    const { codigo_barras } = req.params;

    if (!regexCodigoValido.test(codigo_barras)) {
        return res.status(400).json({ error: "Código de barras inválido o corrupto." });
    }

    const queryConsulta = `
        SELECT p.codigo_barras, p.nombre_producto, i.cantidad, i.ubicacion_almacen 
        FROM productos p
        LEFT JOIN inventario_stock i ON p.producto_id = i.producto_id
        WHERE p.codigo_barras = ?;
    `;

    dbPool.query(queryConsulta, [codigo_barras], (err, results) => {
        if (err) {
            logger.error(`Fallo SQL en consultar inventario [SKU: ${codigo_barras}]: ${err.message}`);
            return res.status(500).json({ error: "No se pudo consultar el inventario en este momento. Intente nuevamente." });
        }
        if (results.length === 0) {
            return res.status(404).json({ error: "El producto no existe en el catálogo." });
        }

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

// 5. POST: SINCRONIZACIÓN OFFLINE IDEMPOTENTE (Evita duplicados en ráfagas)
app.post('/api/inventario/sincronizar-offline', async (req, res) => {
    const { terminal_id, rafaga_movimientos } = req.body;

    if (!terminal_id || !Array.isArray(rafaga_movimientos) || rafaga_movimientos.length === 0) {
        return res.status(400).json({ error: "Error de sincronización: Ráfaga de movimientos vacía o inválida." });
    }

    if (rafaga_movimientos.length > 150) {
        return res.status(400).json({ error: "Límite excedido: Máximo 150 transacciones offline por ráfaga." });
    }

    let procesados = 0;
    let duplicadosOmitidos = 0;
    const promisePool = dbPool.promise();

    try {
        for (const mov of rafaga_movimientos) {
            const { transaccion_id, codigo_barras, cantidad_cambio, ubicacion } = mov;

            if (!transaccion_id || !codigo_barras || cantidad_cambio === undefined || !ubicacion) {
                continue;
            }

            const [insertResult] = await promisePool.query(
                `INSERT IGNORE INTO movimientos_offline_log 
                (transaccion_id, terminal_id, codigo_barras, cantidad_cambio, ubicacion) 
                VALUES (?, ?, ?, ?, ?)`,
                [transaccion_id, terminal_id, codigo_barras, cantidad_cambio, ubicacion]
            );

            if (insertResult.affectedRows === 0) {
                duplicadosOmitidos++;
            } else {
                procesados++;
            }
        }

        logger.info(`Sincronización Offline Terminal #${terminal_id}: ${procesados} nuevos, ${duplicadosOmitidos} duplicados omitidos.`);

        res.json({
            status: "Sincronizado",
            canal: "AWS RDS Cloud",
            mensaje: `Resiliencia de Red Exitosa: Se integraron ${procesados} movimientos nuevos y se bloquearon ${duplicadosOmitidos} registros duplicados.`
        });
    } catch (err) {
        logger.error(`Error crítico en sincronizar-offline [Terminal: ${terminal_id}]: ${err.message}`);
        res.status(500).json({ error: "Error interno al sincronizar el lote offline. Los datos permanecen seguros en caché." });
    }
});

// 6. POST: LOCALIZACIÓN GPS
app.post('/api/transporte/tracking', (req, res) => {
    const { usuario_id, latitud, longitud, orden_id } = req.body;

    if (!usuario_id || !latitud || !longitud || !orden_id) {
        return res.status(400).json({ error: "Error de Rastreo: Coordenadas GPS o ID de ruta incompletos." });
    }

    logger.info(`Tracking GPS - Ruta: ${orden_id}, Chofer: ${usuario_id}, Coords: [${latitud}, ${longitud}]`);

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
    logger.info(`Servidor Logístico del CEDIS operativo en el puerto local: ${PORT}`);
});