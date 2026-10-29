import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { readMachineMetadataFieldV1, type MachineMetadataFieldDefinitionV1 } from './machineMetadataFieldV1.js';

const id = z.string().check(z.trim(), z.minLength(1));
const version = z.number().check(z.int(), z.nonnegative());

export const MachineAgentIsolationPolicyV1Schema = lazyZodSchema(() => z.strictObject({ enabled: z.boolean() }));
export type MachineAgentIsolationPolicyV1 = z.infer<typeof MachineAgentIsolationPolicyV1Schema>;
export const MachineAgentIsolationPolicyV1StoredSchema = createStoredReadSchema(MachineAgentIsolationPolicyV1Schema);
export const agentIsolationMetadataFieldV1 = {
  field: 'agentIsolation', storedSchema: MachineAgentIsolationPolicyV1StoredSchema,
  defaultValue: (): MachineAgentIsolationPolicyV1 => ({ enabled: false }),
  equal: (left: MachineAgentIsolationPolicyV1, right: MachineAgentIsolationPolicyV1) => left.enabled === right.enabled,
} satisfies MachineMetadataFieldDefinitionV1<MachineAgentIsolationPolicyV1>;
export function readMachineAgentIsolationPolicyV1(metadata: unknown) {
  return readMachineMetadataFieldV1(metadata, agentIsolationMetadataFieldV1);
}

export const MachineAgentIsolationUnavailableStatusV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('unavailable'),
  code: z.enum(['unsupported_platform', 'sudo_unavailable', 'sudoers_invalid', 'agent_user_missing',
    'workspace_not_ready', 'payload_not_accessible', 'workspace_ancestor_not_traversable',
    'agent_launch_kind_unavailable', 'provisioning_unavailable', 'launch_probe_failed',
    'mcp_socket_access_unavailable', 'local_admin_api_accessible', 'metadata_unavailable']),
}));
export const MachineAgentIsolationStatusV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('effective'), platform: z.literal('linux'), agentUser: z.literal('happier-agent') }),
  z.strictObject({ kind: z.literal('disabled') }),
  z.strictObject({ kind: z.literal('enable_required'), reason: z.literal('existing_machine_workspace_migration') }),
  z.strictObject({ kind: z.literal('applying'), phase: z.enum(['account', 'sudoers', 'workspace', 'runtime_replacement']) }),
  MachineAgentIsolationUnavailableStatusV1Schema,
]));
export type MachineAgentIsolationStatusV1 = z.infer<typeof MachineAgentIsolationStatusV1Schema>;

export const AgentIsolationEffectPlanV1Schema = lazyZodSchema(() => z.strictObject({
  roots: z.array(z.strictObject({ rootId: id, path: id,
    changes: z.array(z.enum(['group', 'setgid', 'mode', 'gitShared', 'safeDirectory'])) })),
  ancestorAcls: z.array(z.strictObject({ path: id, add: z.literal('x') })),
  sessionsToReplace: version, requiresAdmin: z.boolean(), planDigest: id,
}));
export type AgentIsolationEffectPlanV1 = z.infer<typeof AgentIsolationEffectPlanV1Schema>;
const previewInput = { serverId: z.optional(id), machineId: id, enabled: z.boolean() };
export const MachineAgentIsolationPreviewInputV1Schema = lazyZodSchema(() => z.strictObject(previewInput));
export type MachineAgentIsolationPreviewInputV1 = z.infer<typeof MachineAgentIsolationPreviewInputV1Schema>;
export const MachineAgentIsolationReadyPreviewV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('ready'), plan: AgentIsolationEffectPlanV1Schema, policy: MachineAgentIsolationPolicyV1Schema,
  metadataVersion: version, status: MachineAgentIsolationStatusV1Schema,
}));
export const MachineAgentIsolationPreviewResultV1Schema = lazyZodSchema(() => z.union([
  MachineAgentIsolationReadyPreviewV1Schema,
  z.strictObject({ kind: z.literal('unavailable'), status: MachineAgentIsolationUnavailableStatusV1Schema }),
]));
export type MachineAgentIsolationPreviewResultV1 = z.infer<typeof MachineAgentIsolationPreviewResultV1Schema>;
export const MachineAgentIsolationSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...previewInput, expectedMetadataVersion: version, expectedPolicy: MachineAgentIsolationPolicyV1Schema, expectedPlanDigest: id,
}));
export type MachineAgentIsolationSetInputV1 = z.infer<typeof MachineAgentIsolationSetInputV1Schema>;
export const MachineAgentIsolationSetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('accepted'), operationId: id, metadataVersion: version, status: MachineAgentIsolationStatusV1Schema }),
  z.strictObject({ kind: z.literal('unchanged'), metadataVersion: version, status: MachineAgentIsolationStatusV1Schema }),
  z.strictObject({ kind: z.literal('plan_changed'), current: MachineAgentIsolationReadyPreviewV1Schema,
    operationId: z.optional(id) }),
  z.strictObject({ kind: z.literal('conflict'), policy: MachineAgentIsolationPolicyV1Schema, metadataVersion: version }),
  z.strictObject({ kind: z.literal('failed'), operationId: z.optional(id), code: z.enum(['cancelled', 'denied', 'locked', 'invalid', 'unavailable', 'outcome_unknown']) }),
]));
export type MachineAgentIsolationSetResultV1 = z.infer<typeof MachineAgentIsolationSetResultV1Schema>;
