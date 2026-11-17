import { PET_ANIMATION_ROWS_V1, PET_ATLAS_V1, PET_ATLAS_V2, PET_LOOK_TRACK_V2, getPetAtlasForDimensionsV1 } from './constants.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const PetCellBoundsV1Schema = lazyZodSchema(() => z.strictObject({
  x: z.number().check(z.int(), z.minimum(0)),
  y: z.number().check(z.int(), z.minimum(0)),
  width: z.number().check(z.int(), z.minimum(1)),
  height: z.number().check(z.int(), z.minimum(1)),
}).check(z.refine((bounds) => bounds.x + bounds.width <= PET_ATLAS_V1.cellWidth
  && bounds.y + bounds.height <= PET_ATLAS_V1.cellHeight)));

export type PetCellBoundsV1 = z.infer<typeof PetCellBoundsV1Schema>;

export type PetAtlasRgbaPixelInspectionV1 = Readonly<{
  hasOpaqueBackground: boolean;
  hasTransparentBackground: boolean;
  hasVisibleUsedCells: boolean;
  hasTransparentUnusedCells: boolean;
  opaqueBounds: PetCellBoundsV1 | null;
  hasNeutralLookCell?: boolean;
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
  let minX: number = PET_ATLAS_V1.cellWidth;
  let minY: number = PET_ATLAS_V1.cellHeight;
  let maxX = -1;
  let maxY = -1;
  const atlas = getPetAtlasForDimensionsV1(input.width, input.height);
  const isV2 = atlas === PET_ATLAS_V2;
  let hasNeutralLookCell = false;

  if (
    !atlas
    || input.channels < 4
    || input.data.byteLength < input.width * input.height * input.channels
  ) {
    return {
      hasOpaqueBackground: true,
      hasTransparentBackground: false,
      hasVisibleUsedCells: false,
      hasTransparentUnusedCells: false,
      opaqueBounds: null,
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
      const isNeutralLookCell = row === PET_LOOK_TRACK_V2.neutral.row && frame === PET_LOOK_TRACK_V2.neutral.frame;
      const isLookCell = isV2 && (row >= PET_LOOK_TRACK_V2.firstDirectionRow || isNeutralLookCell);
      const localX = x % PET_ATLAS_V1.cellWidth;
      if (isUsedCell && alpha > 0) {
        visibleUsedCells.add(key);
      }
      if (isV2 && isNeutralLookCell && alpha > 0) hasNeutralLookCell = true;
      if ((isUsedCell || isLookCell) && alpha > 24) {
        minX = Math.min(minX, localX);
        minY = Math.min(minY, localY);
        maxX = Math.max(maxX, localX);
        maxY = Math.max(maxY, localY);
      }
      if (!isUsedCell && !isLookCell && alpha > 0) {
        hasTransparentUnusedCells = false;
        hasOpaqueBackground = true;
      }
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
    opaqueBounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    ...(isV2 ? { hasNeutralLookCell } : {}),
  };
}
