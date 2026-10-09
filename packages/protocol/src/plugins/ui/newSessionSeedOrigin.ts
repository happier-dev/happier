import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';

/** Original destination, independent of the editable execution placement. */
export const PluginUiNewSessionSeedOriginV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('project'),
  accountId: z.string().trim().min(1),
  workspace: WorkspaceAddressV1Schema,
  page: z.enum(['scripts', 'changes']),
  comparisonId: z.string().trim().min(1).optional(),
}).strict());
export type PluginUiNewSessionSeedOriginV1 = z.infer<typeof PluginUiNewSessionSeedOriginV1Schema>;
export const StoredPluginUiNewSessionSeedOriginV1Schema = createStoredReadSchema(PluginUiNewSessionSeedOriginV1Schema);
