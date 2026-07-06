# Alerta Caudal

Simulador interactivo de zonas de inundación por crecida de ríos, con análisis de impacto en infraestructura crítica. Permite explorar cualquier comuna de Chile filtrando por región, provincia y comuna, seleccionar un cauce específico y visualizar el área afectada según distintos niveles de crecida.

---

## Qué hace

- Filtra por **Región → Provincia → Comuna** y carga automáticamente la hidrografía de esa zona desde OpenStreetMap
- Muestra solo los ríos, esteros y canales que están **dentro del límite administrativo** de la comuna seleccionada
- Permite seleccionar un cauce específico o trabajar con todos a la vez
- Dibuja una **zona de inundación** (buffer) alrededor del cauce según el nivel de alerta
- Identifica y destaca la **infraestructura en riesgo**: hospitales, escuelas, cuarteles de bomberos, carabineros y puentes
- Muestra un **panel de impacto** con el porcentaje de cada tipo de infraestructura afectada

---

## Niveles de alerta

| Nivel   | Radio por defecto | Color    | Significado                        |
|---------|-------------------|----------|------------------------------------|
| Bajo    | 100 m             | Amarillo | Crecida leve, zona de precaución   |
| Medio   | 250 m             | Naranja  | Posible desborde, zona de alerta   |
| Alto    | 500 m             | Rojo     | Desborde probable, evacuación      |
| Crítico | 800 m             | Rojo oscuro | Desborde severo, zona catastrófica |

El slider de ajuste fino permite definir cualquier radio entre 10 m y 1.000 m.

---

## Cobertura administrativa

Incluye la jerarquía completa de Chile:

- **16 regiones** (desde Arica y Parinacota hasta Magallanes)
- **~56 provincias**
- **~346 comunas**

Los datos administrativos están en `data/chile.json` y pueden actualizarse si se crean nuevas comunas.

---

## Fuentes de datos

| Dato | Fuente | Método |
|------|--------|--------|
| Hidrografía (ríos, esteros, canales) | OpenStreetMap vía Overpass API | Tiempo real, límite comunal exacto |
| Infraestructura crítica | OpenStreetMap vía Overpass API | Tiempo real, bbox comunal |
| Límite administrativo | OpenStreetMap (admin_level=8) | Tiempo real via Overpass area |
| Geocodificación de comunas | Nominatim (OSM) | Tiempo real |
| Capa de mapa base | OpenStreetMap, CartoDB, Esri | CDN |

---

## Lógica de consulta

### Hidrografía

Se usa el filtro `area` de Overpass para obtener exactamente lo que está dentro de la comuna:

```
area["name"="X"]["admin_level"="8"]["boundary"="administrative"]->.a;
(
  way["waterway"~"^(river|stream|canal)$"](area.a);
  rel["waterway"~"^(river|canal)$"](area.a)->.rels;
  way(r.rels)(area.a);
);
```

Incluye tanto `way` con tag directo (quebradas, canales menores) como `way` miembros de relaciones (ríos principales como el Maule o el Biobío, que en OSM están modelados como relaciones de múltiples tramos).

### Buffer de inundación

Se calcula con **Turf.js** sobre el cauce seleccionado:

1. Se simplifica la geometría (`turf.simplify`) para mejorar el rendimiento
2. Se genera el polígono de buffer (`turf.buffer`) a la distancia indicada
3. Se verifica cada punto de infraestructura con `turf.booleanPointInPolygon`

### Capas z-order (Leaflet panes)

| Pane    | z-index | Contenido                  |
|---------|---------|----------------------------|
| buffers | 400     | Polígono de zona inundable |
| rivers  | 450     | Líneas de ríos             |
| infra   | 500     | Marcadores de infraestructura |

Esto garantiza que los ríos siempre sean visibles sobre el buffer y que la infraestructura quede encima de todo.

---

## Tecnologías

| Herramienta | Uso |
|-------------|-----|
| [Leaflet.js](https://leafletjs.com) v1.9.4 | Mapa interactivo y control de capas |
| [Turf.js](https://turfjs.org) v6 | Buffer geoespacial y análisis de puntos |
| [Overpass API](https://overpass-api.de) | Hidrografía e infraestructura desde OSM |
| [Nominatim](https://nominatim.openstreetmap.org) | Geocodificación de comunas |
| [CartoDB Basemaps](https://carto.com/basemaps/) | Capas de mapa claro y oscuro |
| [Esri World Imagery](https://www.esri.com) | Capa de satélite |
| HTML + CSS + JS vanilla | Sin frameworks, sin build tools |

---

## Despliegue

Proyecto completamente estático. No requiere backend ni API keys.

```bash
# Netlify Drop
# Arrastra la carpeta a netlify.com/drop

# GitHub Pages
# Activa Pages en Settings → Pages → Deploy from branch (main)

# Vercel
vercel --prod
```

---

## Extensibilidad

- **Agregar país**: reemplazar `data/chile.json` con la jerarquía administrativa del país y ajustar `admin_level` en las queries de Overpass (varía por país)
- **Nuevos tipos de infraestructura**: agregar una entrada al objeto `INFRA` en `app.js` y el tag OSM correspondiente en `fetchInfraBbox`
- **Nuevas variables de análisis**: el buffer es un GeoJSON estándar — cualquier análisis adicional con Turf.js se puede encadenar sobre `bufferedPolygon`
