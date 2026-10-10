import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const EmbedRadiusStepV1Schema = lazyZodSchema(() => z.enum(['sm', 'md', 'lg', 'xl', 'xxl', 'modalCard']));
export type EmbedRadiusStepV1 = z.infer<typeof EmbedRadiusStepV1Schema>;

const SurfaceFinishV1Schema = lazyZodSchema(() => z.enum(['flat', 'soft']));
const PartV1Schema = lazyZodSchema(() => z.object({ radius: EmbedRadiusStepV1Schema.optional(), finish: SurfaceFinishV1Schema.optional() }).strict());

/** Color token names are resolved by the app theme owner. */
export const EmbedStyleV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  mode: z.enum(['light', 'dark', 'system']).optional(),
  preset: z.string().optional(),
  colors: z.object({
    light: z.record(z.string(), z.string()).optional(),
    dark: z.record(z.string(), z.string()).optional(),
  }).strict().optional(),
  typography: z.object({
    fontFamily: z.string().optional(),
    monoFontFamily: z.string().optional(),
    fontUrl: z.string().optional(),
    scale: z.enum(['compact', 'default', 'large']).optional(),
  }).strict().optional(),
  radius: z.enum(['sharp', 'soft', 'round']).optional(),
  density: z.enum(['compact', 'comfortable']).optional(),
  finish: SurfaceFinishV1Schema.optional(),
  parts: z.object({
    userBubble: PartV1Schema.optional(),
    composer: PartV1Schema.optional(),
    toolCard: PartV1Schema.optional(),
    approvalCard: PartV1Schema.optional(),
    codeBlock: PartV1Schema.optional(),
    card: PartV1Schema.optional(),
    floating: PartV1Schema.optional(),
    primaryButton: PartV1Schema.optional(),
    secondaryButton: PartV1Schema.optional(),
  }).strict().optional(),
}).strict());
export type EmbedStyleV1 = z.infer<typeof EmbedStyleV1Schema>;
