import { describe, expect, it } from 'vitest';

import {
  resolveNotchBodySize,
  resolveNotchCameraOffset,
  resolveNotchCameraSeamStops,
  resolveNotchExtent,
  resolveNotchFootFinish,
  resolveNotchMaterialRect,
  resolveNotchShoulder,
  resolveNotchStatusRowShift,
  type NotchMetrics,
} from './notchShapeGeometry';

const metrics: NotchMetrics = {
  thickness: 32,
  openWidth: 464,
  shoulder: 8,
  tipShoulder: 4,
  corner: 14,
  openCorner: 18,
  tipLength: 48,
  tipThickness: 6,
};

describe('notch shape geometry', () => {
  it('frames a docked island with its shoulders along the edge and a floating one without', () => {
    const content = { width: 220, height: 32 };
    const top = resolveNotchBodySize({
      form: 'standard',
      dock: 'top',
      metrics,
      camera: null,
      content,
      panelHeight: 0,
      maxPanelHeight: null,
    });
    expect(
      resolveNotchExtent(
        'top',
        top,
        resolveNotchShoulder('standard', 'top', metrics),
      ),
    ).toEqual({ width: 236, height: 32 });
    expect(
      resolveNotchExtent(
        'floating',
        top,
        resolveNotchShoulder('standard', 'floating', metrics),
      ),
    ).toEqual({ width: 220, height: 32 });

    const strip = { width: 32, height: 120 };
    const left = resolveNotchBodySize({
      form: 'standard',
      dock: 'left',
      metrics,
      camera: null,
      content: strip,
      panelHeight: 0,
      maxPanelHeight: null,
    });
    expect(
      resolveNotchExtent(
        'left',
        left,
        resolveNotchShoulder('standard', 'left', metrics),
      ),
    ).toEqual({ width: 32, height: 136 });
  });

  it('rests as a sliver of the island on its edge, or as the camera block on the camera notch', () => {
    const content = { width: 220, height: 32 };
    expect(
      resolveNotchBodySize({
        form: 'tip',
        dock: 'right',
        metrics,
        camera: null,
        content,
        panelHeight: 0,
        maxPanelHeight: null,
      }),
    ).toEqual({ width: 6, height: 48 });
    expect(
      resolveNotchBodySize({
        form: 'tip',
        dock: 'top',
        metrics,
        camera: { width: 184, height: 32 },
        content,
        panelHeight: 0,
        maxPanelHeight: null,
      }),
    ).toEqual({ width: 184, height: 32 });
  });

  it('opens to the dialog width and never taller than the window native clamped', () => {
    const content = { width: 220, height: 32 };
    expect(
      resolveNotchBodySize({
        form: 'open',
        dock: 'left',
        metrics,
        camera: null,
        content,
        panelHeight: 900,
        maxPanelHeight: 600,
      }),
    ).toEqual({ width: 464, height: 600 });
  });

  it('leans the standard island toward its wider wing on the camera notch and centres the open panel', () => {
    const camera = { width: 184, height: 32 };
    // Lab R2: four faces (142) on the left, the word (83) on the right.
    expect(
      resolveNotchCameraOffset({
        form: 'standard',
        camera,
        leadingWing: 142,
        trailingWing: 83,
      }),
    ).toBe(-29.5);
    expect(
      resolveNotchCameraOffset({
        form: 'open',
        camera,
        leadingWing: 142,
        trailingWing: 83,
      }),
    ).toBe(0);
    expect(
      resolveNotchCameraOffset({
        form: 'standard',
        camera: null,
        leadingWing: 142,
        trailingWing: 83,
      }),
    ).toBe(0);
  });

  it('keeps the camera-notch status row on the camera when the island opens around it', () => {
    const camera = { width: 184, height: 32 };
    // Three faces on the left (112), the word on the right (83): both fit their half of the open panel.
    const leadingWing = 112;
    const trailingWing = 83;
    const restWidth = leadingWing + camera.width + trailingWing;
    const restCameraOffset = resolveNotchCameraOffset({ form: 'standard', camera, leadingWing, trailingWing });
    const shift = (open: boolean, width: number) =>
      resolveNotchStatusRowShift({ growthX: null, width, openWidth: 464, restWidth, anchorX: 0, centreX: 0, restCameraOffset, open });
    // At rest native places the window so the block lands on the camera: the row fills the body.
    expect(shift(false, restWidth)).toBe(0);
    // Open, the panel is centred on the camera, so the row's camera gap sits at the panel's centre.
    const openWidth = 464;
    expect(shift(true, openWidth) + leadingWing + camera.width / 2).toBe(openWidth / 2);
  });

  it('keeps a crowded camera-notch status row inside the open panel rather than clipping its faces', () => {
    const camera = { width: 184, height: 32 };
    // Four faces and "+1" make the faces wing wider than its half of the open panel.
    const leadingWing = 156;
    const trailingWing = 83;
    const restWidth = leadingWing + camera.width + trailingWing;
    const restCameraOffset = resolveNotchCameraOffset({ form: 'standard', camera, leadingWing, trailingWing });
    const openWidth = 464;
    const shift = resolveNotchStatusRowShift({
      growthX: null, width: openWidth, openWidth, restWidth, anchorX: 0, centreX: 0, restCameraOffset, open: true,
    });
    expect(shift).toBeGreaterThanOrEqual(0);
    expect(shift + restWidth).toBeLessThanOrEqual(openWidth);
  });

  it('holds the camera-notch status row still while the panel springs open around it', () => {
    const camera = { width: 184, height: 32 };
    const restCameraOffset = resolveNotchCameraOffset({ form: 'standard', camera, leadingWing: 156, trailingWing: 83 });
    const restWidth = 156 + camera.width + 83;
    // The body grows about the camera, so a row that stays still keeps one distance from the body's centre.
    const fromCentre = (width: number) =>
      resolveNotchStatusRowShift({ growthX: null, width, openWidth: 464, restWidth, anchorX: 0, centreX: 0, restCameraOffset, open: true }) - width / 2;
    expect(fromCentre(restWidth)).toBe(fromCentre(464));
    expect(fromCentre(440)).toBe(fromCentre(464));
  });
});

describe('notch material', () => {
  const body = { width: 464, height: 300 };

  it('stands under the body alone, running past the screen edge so only free corners round', () => {
    expect(resolveNotchMaterialRect('top', body, { width: 480, height: 300 }, 8, 18))
      .toEqual({ x: 8, y: -18, width: 464, height: 318, radius: 18 });
    expect(resolveNotchMaterialRect('left', body, { width: 544, height: 316 }, 8, 18))
      .toEqual({ x: -18, y: 8, width: 482, height: 300, radius: 18 });
    expect(resolveNotchMaterialRect('right', body, { width: 544, height: 316 }, 8, 18))
      .toEqual({ x: 80, y: 8, width: 482, height: 300, radius: 18 });
    expect(resolveNotchMaterialRect('floating', body, body, 0, 18))
      .toEqual({ x: 0, y: 0, width: 464, height: 300, radius: 18 });
  });

  it('holds the black row at the hardware, then eases it away with no step', () => {
    const { height, stops } = resolveNotchCameraSeamStops(32);
    expect(height).toBe(96);
    expect(stops.filter((stop) => stop.alpha === 1).at(-1)?.offset).toBeCloseTo(1 / 3);
    expect(stops.at(-1)).toEqual({ offset: 1, alpha: 0 });
    for (let index = 1; index < stops.length; index++) {
      expect(stops[index]!.alpha).toBeLessThanOrEqual(stops[index - 1]!.alpha);
      expect(stops[index - 1]!.alpha - stops[index]!.alpha).toBeLessThan(0.2);
    }
  });

  it('moves the dark finish to the foot at its own height and ink', () => {
    const finish = {
      colors: ['rgba(1,1,1,0.025)', 'rgba(1,1,1,0)'] as const,
      locations: [0, 1] as const,
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
      band: { edge: 'top' as const, height: 32 },
    };
    expect(resolveNotchFootFinish(finish)).toEqual({
      ...finish,
      colors: ['rgba(1,1,1,0)', 'rgba(1,1,1,0.025)'],
      band: { edge: 'bottom', height: 32 },
    });
    expect(resolveNotchFootFinish(null)).toBeNull();
  });
});
