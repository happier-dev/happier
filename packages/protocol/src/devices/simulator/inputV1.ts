import { z } from 'zod';

const NormalizedCoordinateSchema = z.number().min(0).max(1);
const PositiveSizeSchema = z.number().positive();

export const SimulatorOrientationV1Schema = z.enum([
  'portrait',
  'portraitUpsideDown',
  'landscapeLeft',
  'landscapeRight',
]);

export const SimulatorPreviewRectV1Schema = z.object({
  x: z.number(),
  y: z.number(),
  width: PositiveSizeSchema,
  height: PositiveSizeSchema,
});

export type SimulatorOrientationV1 = z.infer<typeof SimulatorOrientationV1Schema>;
export type SimulatorPreviewRectV1 = z.infer<typeof SimulatorPreviewRectV1Schema>;

export function mapSimulatorPreviewPointToDeviceV1(input: Readonly<{
  x: number;
  y: number;
  orientation: SimulatorOrientationV1;
  viewport: Readonly<{ width: number; height: number }>;
  content: SimulatorPreviewRectV1;
}>): Readonly<
  | { ok: true; x: number; y: number }
  | { ok: false; reasonCode: 'invalid_geometry' | 'outside_device_frame' | 'invalid_point' }
> {
  if (
    !NormalizedCoordinateSchema.safeParse(input.x).success
    || !NormalizedCoordinateSchema.safeParse(input.y).success
  ) {
    return { ok: false, reasonCode: 'invalid_point' };
  }
  const content = SimulatorPreviewRectV1Schema.safeParse(input.content);
  if (!content.success || input.viewport.width <= 0 || input.viewport.height <= 0) {
    return { ok: false, reasonCode: 'invalid_geometry' };
  }

  const previewX = input.x * input.viewport.width;
  const previewY = input.y * input.viewport.height;
  const localX = (previewX - content.data.x) / content.data.width;
  const localY = (previewY - content.data.y) / content.data.height;

  if (localX < 0 || localX > 1 || localY < 0 || localY > 1) {
    return { ok: false, reasonCode: 'outside_device_frame' };
  }

  switch (input.orientation) {
    case 'portrait':
      return { ok: true, x: localX, y: localY };
    case 'portraitUpsideDown':
      return { ok: true, x: 1 - localX, y: 1 - localY };
    case 'landscapeLeft':
      return { ok: true, x: localY, y: 1 - localX };
    case 'landscapeRight':
      return { ok: true, x: 1 - localY, y: localX };
  }
}
