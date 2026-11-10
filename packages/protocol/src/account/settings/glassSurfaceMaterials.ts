import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/** Account preference: one closed table, not a second material mode. */
export const GlassSurfaceMaterialSchema = lazyZodSchema(() => z.strictObject({
  blur: z.enum(['off', 'light', 'regular', 'strong']),
  opacity: z.number().check(z.minimum(0), z.maximum(1)),
  /** An authored Elements value can equal the default coat but must not follow named Tint. */
  authoredOpacity: z.optional(z.literal(true)),
}));

export const GlassSurfaceMaterialsSchema = lazyZodSchema(() => z.strictObject({
  chrome: GlassSurfaceMaterialSchema,
  sidebar: GlassSurfaceMaterialSchema,
  content: GlassSurfaceMaterialSchema,
  card: GlassSurfaceMaterialSchema,
  floating: GlassSurfaceMaterialSchema,
}));

/** Retained four-layer preferences predate Elements; their coat is resolved by the preference owner. */
export const GlassSurfaceMaterialsStoredSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(z.partial(GlassSurfaceMaterialsSchema, { card: true })));

export type GlassSurfaceMaterial = z.infer<typeof GlassSurfaceMaterialSchema>;
export type GlassSurfaceMaterials = z.infer<typeof GlassSurfaceMaterialsSchema>;
export type GlassSurfaceGroup = keyof GlassSurfaceMaterials;
export type GlassBlurStep = GlassSurfaceMaterial['blur'];
