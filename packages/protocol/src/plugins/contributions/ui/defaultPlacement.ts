import { z } from '../../../zodRuntimePolicy.js';

/** A contribution's initial placement; the person's saved choice takes precedence. */
export const PluginDefaultPlacementSchema = z.enum(['pinned', 'overflow']);
export type PluginDefaultPlacement = z.infer<typeof PluginDefaultPlacementSchema>;
