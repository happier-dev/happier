import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const APP_UPDATE_ACTION_IDS = ['app.updates.get', 'app.updates.check', 'app.updates.update',
  'app.updates.retry', 'app.updates.restart', 'app.updates.skip'] as const;
export type AppUpdateActionId = typeof APP_UPDATE_ACTION_IDS[number];
export function isAppUpdateActionId(value: string): value is AppUpdateActionId {
  return (APP_UPDATE_ACTION_IDS as readonly string[]).includes(value);
}
const EmptyInputSchema = lazyZodSchema(() => z.object({}).strict());
export const AppUpdateActionInputSchemas = {
  'app.updates.get': EmptyInputSchema, 'app.updates.check': EmptyInputSchema,
  'app.updates.update': EmptyInputSchema, 'app.updates.retry': EmptyInputSchema, 'app.updates.restart': EmptyInputSchema,
  'app.updates.skip': z.object({ version: z.string().trim().min(1) }).strict(),
} as const;
export const AppUpdateStatusResultSchema = lazyZodSchema(() => z.object({
  channel: z.enum(['desktop', 'native-store', 'web-ui', 'ota', 'none']),
  state: z.enum(['unchecked', 'checking', 'upToDate', 'available', 'required', 'running', 'ready', 'failed', 'unknown', 'offline']),
  currentVersion: z.string().nullable(), latestVersion: z.string().nullable(), checkedAt: z.number().nullable(),
  action: z.enum(['update', 'retry', 'restart', 'reload', 'store']).nullable(), skipped: z.boolean(), canSkip: z.boolean(),
}).strict());
const OperationResultSchema = lazyZodSchema(() => z.object({ status: z.literal('requested') }).strict());
export const AppUpdateActionOutputSchemas = {
  'app.updates.get': AppUpdateStatusResultSchema,
  'app.updates.check': OperationResultSchema, 'app.updates.update': OperationResultSchema,
  'app.updates.retry': OperationResultSchema, 'app.updates.restart': OperationResultSchema, 'app.updates.skip': OperationResultSchema,
} as const;
export const APP_UPDATE_ACTION_SPECS = APP_UPDATE_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
  id, title: {
    'app.updates.get': 'Get app update status', 'app.updates.check': 'Check for app updates',
    'app.updates.update': 'Update this app', 'app.updates.retry': 'Retry app update',
    'app.updates.restart': 'Restart to update this app', 'app.updates.skip': 'Skip this app version',
  }[id],
  description: 'Use the answering app’s current platform update owner. Unsupported or unavailable operations are refused.',
  safety: id === 'app.updates.update' || id === 'app.updates.retry' || id === 'app.updates.restart' ? 'danger' : 'safe',
  sideEffectClass: id === 'app.updates.get' ? 'read' : id === 'app.updates.update' || id === 'app.updates.retry' || id === 'app.updates.restart' ? 'danger' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  bindings: { mcpToolName: id.replace(/[.]/g, '_') },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: AppUpdateActionInputSchemas[id], outputSchema: AppUpdateActionOutputSchemas[id],
  inputHints: { fields: id === 'app.updates.skip' ? [{ path: 'version', title: 'Offered version', widget: 'text', required: true }] : [] },
}));
