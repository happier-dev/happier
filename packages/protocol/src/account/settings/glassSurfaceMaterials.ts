import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/** Account preference: one closed table, not a second material mode. */
export const GlassSurfaceMaterialSchema = lazyZodSchema(() => z.object({
  blur: z.enum(['off', 'light', 'regular', 'strong']),
  opacity: z.number().min(0).max(1),
}).strict());

export const GlassSurfaceMaterialsSchema = lazyZodSchema(() => z.object({
  chrome: GlassSurfaceMaterialSchema,
  sidebar: GlassSurfaceMaterialSchema,
  content: GlassSurfaceMaterialSchema,
  floating: GlassSurfaceMaterialSchema,
}).strict());

export type GlassSurfaceMaterial = z.infer<typeof GlassSurfaceMaterialSchema>;
export type GlassSurfaceMaterials = z.infer<typeof GlassSurfaceMaterialsSchema>;
export type GlassSurfaceGroup = keyof GlassSurfaceMaterials;
export type GlassBlurStep = GlassSurfaceMaterial['blur'];
