import { z } from '../zodRuntimePolicy.js';

import { parseQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmCredentialFreeRepositorySelectorV1Schema } from '../scm/repositoryClone.js';
import { ScmBranchSourceRefSchema } from '../scm/remoteNormalization.js';
import { WorkspaceContentPolicyV1Schema, WorkspaceSyncPersistentModeV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { QualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';

/** Project content intent; credentials are acquired by SCM, never retained here. */
export const SessionProjectFilesV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('copy_once'), contentPolicy: z.optional(WorkspaceContentPolicyV1Schema) }),
  z.strictObject({ kind: z.literal('git_clone'), source: ScmCredentialFreeRepositorySelectorV1Schema,
    branch: ScmBranchSourceRefSchema, gitAccount: z.optional(asProtocolZod(QualifiedConnectedAccountRefSchema)) }),
  // Project files offers Replica and Editable copy, not exact-mirror deletion.
  z.strictObject({ kind: z.literal('sync'), mode: z.enum(
    WorkspaceSyncPersistentModeV1Schema.options.filter(mode => mode !== 'mirror_exactly'),
  ), contentPolicy: z.optional(WorkspaceContentPolicyV1Schema) }),
]));
export type SessionProjectFilesV1 = z.infer<typeof SessionProjectFilesV1Schema>;

/** Provider-authored creation provenance, recorded once on the enrolled Machine. */
export const MachineIsolationV1Schema = z.strictObject({
  environment: z.literal('managed-guest'),
  provisionerId: z.string().check(z.refine(value => parseQualifiedPluginContributionKey(value) !== null)),
});
export type MachineIsolationV1 = z.infer<typeof MachineIsolationV1Schema>;
const storedMachineIsolationV1Schema = createStoredReadSchema(MachineIsolationV1Schema);

/** Absent or unreadable provenance never weakens a host's sandbox default. */
export function readMachineIsolationV1(openedMetadata: unknown): MachineIsolationV1 | null {
  if (!openedMetadata || typeof openedMetadata !== 'object' || Array.isArray(openedMetadata)) return null;
  const parsed = storedMachineIsolationV1Schema.safeParse(Reflect.get(openedMetadata, 'isolationV1'));
  return parsed.success ? parsed.data : null;
}

const policyId = () => z.string().check(z.trim(), z.minLength(1));
export const MachineIsolationSandboxWorkChoiceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('sandbox'), configuredSandboxId: policyId(), lifecycle: z.enum(['fresh', 'shared-kept']),
}));
export const MachineIsolationConfiguredSandboxV1Schema = lazyZodSchema(() => z.strictObject({
  provisioner: asProtocolZod(PluginContributionIdentityV1Schema), presetId: policyId(),
}));
export const MachineIsolationWorkChoiceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('directly') }),
  MachineIsolationSandboxWorkChoiceV1Schema,
]));
export type MachineIsolationWorkChoiceV1 = z.infer<typeof MachineIsolationWorkChoiceV1Schema>;

export const MachineIsolationPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  configuredSandboxes: z.record(policyId(), MachineIsolationConfiguredSandboxV1Schema),
  workKinds: z.strictObject({
    sessions: MachineIsolationWorkChoiceV1Schema,
    botsChannels: MachineIsolationWorkChoiceV1Schema,
    automationsWorkflows: MachineIsolationWorkChoiceV1Schema,
  }),
  agentNativeSandboxEnabled: z.optional(z.boolean()),
}));
export type MachineIsolationPolicyV1 = z.infer<typeof MachineIsolationPolicyV1Schema>;
const storedMachineIsolationPolicyV1Schema = createStoredReadSchema(MachineIsolationPolicyV1Schema);
const isolationMetadataSchema = lazyZodSchema(() => z.object({ isolationPolicyV1: z.optional(storedMachineIsolationPolicyV1Schema) }));

/** Only absence means Directly; malformed present metadata must reach typed-unavailable handling. */
export function readMachineIsolationPolicyV1(openedMetadata: unknown): MachineIsolationPolicyV1 | null {
  return isolationMetadataSchema.parse(openedMetadata).isolationPolicyV1 ?? null;
}

export function readMachineAgentNativeSandboxEnabledV1(openedMetadata: unknown): boolean {
  return readMachineIsolationPolicyV1(openedMetadata)?.agentNativeSandboxEnabled === true;
}
