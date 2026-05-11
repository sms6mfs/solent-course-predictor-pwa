# Inshore Course Predictor PWA

Standalone browser prototype converted from the Excel race marks / polar calculator.

## Run locally

Open `index.html` directly, or serve the folder:

```bash
python -m http.server 8000
```

Then browse to `http://localhost:8000`.

## Included

- 175 marks extracted from the uploaded Excel `inputLATLON` sheet.
- Cape31 polar table extracted from the Excel `Polar` sheet.
- GPX waypoint upload to replace the mark list.
- CSV polar upload to replace the embedded polar.
- Manual target mode for upwind/reaching/downwind BSP/TWA.
- Wind/current inputs.
- Distance/bearing per leg.
- Upwind/downwind two-board tack split using along-track and cross-track vector balance.
- Leaflet map with course overlay.

## CSV polar format

First row is TWA headings. First column is TWS.

```csv
TWA/TWS,0,5,10,15,20,25,30,35,40,45,50,55,60
6,0.3,0.9,1.5,2.1,2.7,3.3,3.9,4.5,5.1,5.6,6.0,6.2,6.3
8,1.1,1.8,2.4,3.0,3.7,4.3,4.9,5.6,6.2,6.7,7.0,7.2,7.3
```

## Important modelling notes

The web version deliberately does not copy Excel's range/bearing matrix. It calculates distance and bearing dynamically from the selected marks.

The tack split is also rebuilt as vector math rather than a direct formula port. For upwind/downwind legs it solves port and starboard time so that cross-track displacement cancels and along-track displacement reaches the mark.

For reaching legs the first version assumes the boat sails the leg bearing through the water and current alters the ground speed. A later improvement should solve the heading needed to achieve the desired COG in current.

## Polar imports

The polar uploader now accepts `.csv`, `.txt`, and `.pol` files. It auto-detects:

1. Matrix/table polars, including common `TWA\TWS` / `TWA` / `Windspeed` headers.
2. Matrix tables where rows are TWA and columns are TWS; these are transposed internally.
3. Expedition/Deckman `.txt`/`.pol` pair format: first column is TWS, followed by repeating `TWA, BSP` pairs. Comment lines beginning with `!`, `#`, or `//` are ignored.

The internal app format is always `rows = TWS`, `columns = TWA`, with bilinear interpolation used by the solver.


## Custom start and finish

The course builder supports custom start and finish positions in addition to GPX/Excel marks.

- Type decimal latitude/longitude into the Start or Finish boxes, then press **Use as start** or **Use as finish**.
- Or press **Pick on chart**, then click the map to populate the coordinate boxes.
- Custom Start is inserted at the beginning of the course.
- Custom Finish is appended to the end of the course.
- Existing course marks can still be added between them from the mark list.


## Direction conventions

- True Wind Direction (TWD) is treated as the direction the wind is coming **FROM**. Example: TWD 000 means wind from north, blowing toward south.
- Current set is treated as the direction the water is going **TO**. Example: current set 000 means the water flows north.
- Internally, current is used directly as a TO vector. Wind is only converted to a TO vector where needed; TWA and leg classification use TWD as wind-FROM.
- A leg bearing close to TWD is classified as upwind. A leg bearing close to TWD + 180 is classified as downwind.
