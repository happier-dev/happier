import { PET_ANIMATION_ROWS_V1, PET_ATLAS_V1 } from './constants.js';

export type PetAtlasRgbaPixelInspectionV1 = Readonly<{
  hasOpaqueBackground: boolean;
  hasTransparentBackground: boolean;
  hasVisibleUsedCells: boolean;
  hasTransparentUnusedCells: boolean;
}>;

function cellKey(row: number, frame: number): string {
  return `${row}:${frame}`;
}

const usedCellKeys = new Set<string>(
  PET_ANIMATION_ROWS_V1.flatMap((row) => Array.from({ length: row.frames }, (_value, frame) => cellKey(row.row, frame))),
);

export function inspectPetAtlasRgbaPixelsV1(input: Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}>): PetAtlasRgbaPixelInspectionV1 {
  const visibleUsedCells = new Set<string>();
  let hasOpaqueBackground = false;
  let hasTransparentUnusedCells = true;
  let hasTransparentCellCorners = true;

  if (
    input.width !== PET_ATLAS_V1.width
    || input.height !== PET_ATLAS_V1.height
    || input.channels < 4
    || input.data.byteLength < input.width * input.height * input.channels
  ) {
    return {
      hasOpaqueBackground: true,
      hasTransparentBackground: false,
      hasVisibleUsedCells: false,
      hasTransparentUnusedCells: false,
    };
  }

  for (let y = 0; y < input.height; y += 1) {
    const row = Math.floor(y / PET_ATLAS_V1.cellHeight);
    const localY = y % PET_ATLAS_V1.cellHeight;
    for (let x = 0; x < input.width; x += 1) {
      const frame = Math.floor(x / PET_ATLAS_V1.cellWidth);
      const key = cellKey(row, frame);
      const alpha = input.data[(y * input.width + x) * input.channels + 3] ?? 255;
      const isUsedCell = usedCellKeys.has(key);
      if (isUsedCell && alpha > 0) {
        visibleUsedCells.add(key);
      }
      if (!isUsedCell && alpha > 0) {
        hasTransparentUnusedCells = false;
        hasOpaqueBackground = true;
      }
      const localX = x % PET_ATLAS_V1.cellWidth;
      if ((localX === 0 || localX === PET_ATLAS_V1.cellWidth - 1) && (localY === 0 || localY === PET_ATLAS_V1.cellHeight - 1) && alpha > 0) {
        hasTransparentCellCorners = false;
        hasOpaqueBackground = true;
      }
    }
  }

  return {
    hasOpaqueBackground,
    hasTransparentBackground: hasTransparentUnusedCells && hasTransparentCellCorners,
    hasVisibleUsedCells: visibleUsedCells.size === usedCellKeys.size,
    hasTransparentUnusedCells,
  };
}
