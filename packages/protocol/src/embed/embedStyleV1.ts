import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const EmbedRadiusStepV1Schema = lazyZodSchema(() => z.enum(['sm', 'md', 'lg', 'xl', 'xxl', 'modalCard']));
export type EmbedRadiusStepV1 = z.infer<typeof EmbedRadiusStepV1Schema>;

const SurfaceFinishV1Schema = lazyZodSchema(() => z.enum(['flat', 'soft']));
const PartV1Schema = lazyZodSchema(() => z.strictObject({ radius: z.optional(EmbedRadiusStepV1Schema), finish: z.optional(SurfaceFinishV1Schema) }));

/** Color token names are resolved by the app theme owner. */
export const EmbedStyleV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  mode: z.optional(z.enum(['light', 'dark', 'system'])),
  preset: z.optional(z.string()),
  colors: z.optional(z.strictObject({
    light: z.optional(z.record(z.string(), z.string())),
    dark: z.optional(z.record(z.string(), z.string())),
  })),
  typography: z.optional(z.strictObject({
    fontFamily: z.optional(z.string()),
    monoFontFamily: z.optional(z.string()),
    fontUrl: z.optional(z.string()),
    scale: z.optional(z.enum(['compact', 'default', 'large'])),
  })),
  radius: z.optional(z.enum(['sharp', 'soft', 'round'])),
  density: z.optional(z.enum(['compact', 'comfortable'])),
  finish: z.optional(SurfaceFinishV1Schema),
  parts: z.optional(z.strictObject({
    userBubble: z.optional(PartV1Schema),
    composer: z.optional(PartV1Schema),
    toolCard: z.optional(PartV1Schema),
    approvalCard: z.optional(PartV1Schema),
    codeBlock: z.optional(PartV1Schema),
    card: z.optional(PartV1Schema),
    floating: z.optional(PartV1Schema),
    primaryButton: z.optional(PartV1Schema),
    secondaryButton: z.optional(PartV1Schema),
  })),
}));
export type EmbedStyleV1 = z.infer<typeof EmbedStyleV1Schema>;
