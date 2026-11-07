import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Launch occurs before Session advertisement, so argv values are fixed native ids. */
export const PluginAgentAcpPermissionModeArgvMappingV2Schema = lazyZodSchema(() => z.strictObject({
  default: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  'read-only': z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  'safe-yolo': z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  yolo: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  plan: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
}));

const NativeModeSelectionSchema = lazyZodSchema(() => z.nullable(z.union([
  z.string().check(z.trim(), z.minLength(1)),
  z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
])));

/** Candidate lists select the first advertised id; absent or null grants no enforcement support. */
export const PluginAgentAcpPermissionModeMappingV2Schema = lazyZodSchema(() => z.strictObject({
  default: z.optional(NativeModeSelectionSchema),
  'read-only': z.optional(NativeModeSelectionSchema),
  'safe-yolo': z.optional(NativeModeSelectionSchema),
  yolo: z.optional(NativeModeSelectionSchema),
  plan: z.optional(NativeModeSelectionSchema),
}));
