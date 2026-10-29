import { UPDATES_ACTION_IDS } from './updatesActionIdsV1.js';
export { UPDATES_ACTION_IDS } from './updatesActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { InstallableCapabilityIdSchema } from '../installables/descriptor.js';
export type UpdatesActionId = typeof UPDATES_ACTION_IDS[number];
export function isUpdatesActionId(value: string): value is UpdatesActionId {
  return (UPDATES_ACTION_IDS as readonly string[]).includes(value);
}
const id = z.string().check(z.trim(), z.minLength(1));
const EmptyInputSchema = lazyZodSchema(() => z.strictObject({}));
export const UpdateItemStateSchema = lazyZodSchema(() => z.enum([
  'unchecked', 'checking', 'upToDate', 'available', 'required', 'running', 'ready', 'failed', 'unknown', 'offline',
]));
export type UpdateItemState = z.infer<typeof UpdateItemStateSchema>;
export const UpdateItemActionVerbSchema = lazyZodSchema(() => z.enum(['update', 'retry', 'restart', 'reload', 'store']));
export type UpdateItemActionVerb = z.infer<typeof UpdateItemActionVerbSchema>;
export const UpdateSubjectSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('app') }), z.strictObject({ kind: z.literal('happier-cli') }),
  z.strictObject({ kind: z.literal('agent-cli'), agentId: id }),
  z.strictObject({ kind: z.literal('installable'), key: id }),
]));
export type UpdateSubject = Readonly<z.infer<typeof UpdateSubjectSchema>>;
export const UpdatesActionInputSchemas = {
  'updates.get': EmptyInputSchema,
  'machines.cli.update': lazyZodSchema(() => z.strictObject({ target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('local') }),
    z.strictObject({ kind: z.literal('machine'), machineId: id }),
  ]) })),
  'updates.check': EmptyInputSchema,
  'updates.batch.start': lazyZodSchema(() => z.strictObject({ groupId: z.nullable(id), itemIds: z.array(id).check(z.minLength(1), z.refine(items => new Set(items).size === items.length)) })),
  'updates.batch.stop': EmptyInputSchema,
} as const;
const OperationResultSchema = lazyZodSchema(() => z.strictObject({ status: z.literal('requested') }));
export const UpdatesSnapshotResultSchema = lazyZodSchema(() => z.strictObject({
  groups: z.array(z.strictObject({
    groupId: id, machineName: z.nullable(z.string()), online: z.boolean(),
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('app') }), z.strictObject({ kind: z.literal('local') }),
      z.strictObject({ kind: z.literal('machine'), machineId: id }),
    ]),
    items: z.array(z.strictObject({
      itemId: id, title: z.string(), subject: UpdateSubjectSchema, state: UpdateItemStateSchema,
      currentVersion: z.nullable(z.string()), latestVersion: z.nullable(z.string()),
      managedBy: z.enum(['happier', 'user']), action: z.nullable(UpdateItemActionVerbSchema), batchEligible: z.boolean(),
      capabilityId: z.nullable(InstallableCapabilityIdSchema), manualCommand: z.nullable(z.string()), logPath: z.nullable(z.string()),
    })),
  })),
  batch: z.nullable(z.strictObject({ done: z.number().check(z.int(), z.nonnegative()), total: z.number().check(z.int(), z.nonnegative()), stopping: z.boolean() })),
}));
export const UpdatesActionOutputSchemas = {
  'updates.get': UpdatesSnapshotResultSchema,
  'machines.cli.update': OperationResultSchema, 'updates.check': OperationResultSchema,
  'updates.batch.start': OperationResultSchema, 'updates.batch.stop': OperationResultSchema,
} as const;
export const UPDATES_ACTION_SPECS = UPDATES_ACTION_IDS.map((actionId): PreNormalizedActionSpec => ({
  ...(actionId === 'machines.cli.update' || actionId === 'updates.batch.start'
    ? { confirmVerb: { key: 'common.update', fallback: 'Update' } } : {}),
  id: actionId, approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'policy' }, title: {
    'updates.get': 'Get current update targets',
    'machines.cli.update': 'Update managed Happier CLI', 'updates.check': 'Check for updates',
    'updates.batch.start': 'Update selected items', 'updates.batch.stop': 'Stop after current updates',
  }[actionId],
  description: actionId === 'updates.batch.stop'
    ? 'Stops the current Account’s existing Updates batch after its current item; closing the Updates detail surface does not prevent Stop.'
    : 'Requires the answering app’s Updates detail surface to be mounted. Read updates.get for exact group/item ids and supported targets; an unavailable owner returns a typed refusal. Updates install latest through existing owners; displayed versions and manual commands never authorize another updater recipe.',
  safety: actionId === 'machines.cli.update' || actionId === 'updates.batch.start' ? 'danger' : 'safe',
  sideEffectClass: actionId === 'updates.get' ? 'read' : actionId === 'machines.cli.update' || actionId === 'updates.batch.start' ? 'danger' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  bindings: { mcpToolName: actionId.replace(/[.]/g, '_') },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  cli: { acceptsServerId: true, commands: [] },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: UpdatesActionInputSchemas[actionId], outputSchema: UpdatesActionOutputSchemas[actionId],
  inputHints: { fields: [] },
}));
