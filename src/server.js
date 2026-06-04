const express = require('express');
const mysql = require('mysql2');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;


const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});


db.connect((err) => {
    if (err) {
        console.error('❌ Error crítico de conexión a la Base de Datos en Docker:', err.message);
        return;
    }
    console.log('✅ Conexión exitosa a MySQL en el contenedor Docker (Sistema SEAF).');
});


app.get('/', (req, res) => {
    res.json({
        proyecto: "Sistema de Entrega y Almacenamiento Facilitador (SEAF)",
        estado: "Servidor de Pruebas Activo",
        entorno: "Local - Desarrollo",
        status: "OK"
    });
});


app.get('/api/prueba-stock', (req, res) => {
    
    const query = `
        SELECT 
            i.stock_id, 
            p.nombre_producto, 
            p.codigo_barras, 
            i.cantidad, 
            i.ubicacion_almacen 
        FROM inventario_stock i
        INNER JOIN productos p ON i.producto_id = p.producto_id;
    `;

    db.query(query, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({
            mensaje: "Lectura exitosa desde el contenedor local (Esquema Real SEAF)",
            data: results
        });
    });
});


app.listen(PORT, () => {
    console.log(`🚀 Servidor interconectado corriendo con éxito en http://localhost:${PORT}`);
});