import type { PetCellBoundsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import { PET_ATLAS_V1, PET_ATLAS_V2 } from '@happier-dev/protocol/pets/constants';

/**
 * Fit a pet into a square box (a Bot's face): the opaque bounds (or the whole cell, without them) scaled to fit the box,
 * proportions kept, centred. The bounds cover every used cell, so no frame is ever cropped and the pet never jumps.
 */
export type PetSpriteFit = Readonly<{
  box: number;
  bounds?: PetCellBoundsV1 | null;
}>;

export type PetSpriteCell = Readonly<{ row: number; frame: number }>;

export type PetSpriteLayout = Readonly<{
  /** The sprite's own box. */
  width: number;
  height: number;
  /** The window inside the box that shows one cell's bounds. */
  clip: Readonly<{ left: number; top: number; width: number; height: number }>;
  /** The whole atlas, drawn at the sprite's scale. */
  atlasWidth: number;
  atlasHeight: number;
  /** Where the atlas sits behind the window for a cell, whole device pixels, so every frame samples alike. */
  offset: (cell: PetSpriteCell) => Readonly<{ x: number; y: number }>;
}>;

/** The one geometry of a pet sprite: the companion's scaled cell, or a face's fitted box. */
export function petSpriteLayout(
  input: Readonly<{
    cellWidth: number;
    cellHeight: number;
    spriteVersionNumber?: 1 | 2;
    scale?: number;
    fit?: PetSpriteFit;
    dpr: number;
  }>,
): PetSpriteLayout {
  const { cellWidth, cellHeight, fit } = input;
  const atlas = input.spriteVersionNumber === 2 ? PET_ATLAS_V2 : PET_ATLAS_V1;
  const bounds =
    fit?.bounds && fit.bounds.width > 0 && fit.bounds.height > 0
      ? fit.bounds
      : { x: 0, y: 0, width: cellWidth, height: cellHeight };
  const k = fit
    ? Math.min(fit.box / bounds.width, fit.box / bounds.height)
    : positive(input.scale);
  const clipWidth = bounds.width * k;
  const clipHeight = bounds.height * k;
  const width = fit ? fit.box : cellWidth * k;
  const height = fit ? fit.box : cellHeight * k;
  const dpr = input.dpr > 0 ? input.dpr : 1;
  const snap = (v: number) => Math.round(v * dpr) / dpr + 0;
  return {
    width,
    height,
    clip: {
      left: snap((width - clipWidth) / 2),
      top: snap((height - clipHeight) / 2),
      width: clipWidth,
      height: clipHeight,
    },
    atlasWidth: atlas.width * k,
    atlasHeight: atlas.height * k,
    offset: (cell) => ({
      x: snap(-(cell.frame * cellWidth + bounds.x) * k),
      y: snap(-(cell.row * cellHeight + bounds.y) * k),
    }),
  };
}

function positive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 1;
}
