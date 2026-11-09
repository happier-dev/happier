import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';

/** Pushed facts for an Agent's existing Account settings surface; never credentials or paths. */
export const PluginAgentSettingsLaunchInputV1Schema = lazyZodSchema(() => z.strictObject({
  agentId: z.string(),
  account: z.strictObject({
    values: z.record(z.string(), PluginUiJsonValueV1Schema),
    revision: z.nullable(z.string()),
    ready: z.boolean(),
    loading: z.boolean(),
    writePending: z.boolean(),
    error: z.boolean(),
  }),
  machines: z.array(z.strictObject({
    id: z.string(),
    displayName: z.string(),
    online: z.boolean(),
    pid: z.nullable(z.number()),
    startedAt: z.nullable(z.number()),
    cliVersion: z.nullable(z.string()),
    source: PluginUiJsonValueV1Schema,
    report: PluginUiJsonValueV1Schema,
  })),
}));
export type PluginAgentSettingsLaunchInputV1 = z.infer<typeof PluginAgentSettingsLaunchInputV1Schema>;
