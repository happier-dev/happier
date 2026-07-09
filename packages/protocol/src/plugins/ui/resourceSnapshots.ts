import { z } from 'zod';

import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { PluginSessionResourceTargetV1Schema } from '../contributions/ui/resources.js';

export const PluginUiResourceRequestV1Schema = z.object({
  resource: PluginSessionResourceTargetV1Schema,
  selector: z.string().trim().min(1).optional(),
}).strict();
export type PluginUiResourceRequestV1 =
  z.infer<typeof PluginUiResourceRequestV1Schema>;

export const PluginUiResourceSnapshotV1Schema = z.object({
  resource: PluginSessionResourceTargetV1Schema,
  state: z.enum(['available', 'unavailable', 'stale']),
  capturedAtMs: z.number().int().nonnegative(),
  payload: PluginUiJsonValueV1Schema.optional(),
  diagnostics: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginUiResourceSnapshotV1 =
  z.infer<typeof PluginUiResourceSnapshotV1Schema>;
