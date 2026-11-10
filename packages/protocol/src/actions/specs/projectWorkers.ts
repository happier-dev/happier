import { lazyActionSpecArray , type ActionSpecArrayConcat } from '../lazyActionSpecValue.js';
import { PROJECT_WORKER_ACTION_IDS_V1, isProjectWorkerCopyInspectActionIdV1 } from './projectWorkersActionIdsV1.js';
export { PROJECT_WORKER_ACTION_IDS_V1 } from './projectWorkersActionIdsV1.js';
import { z } from '../../zodRuntimePolicy.js';

import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineFinitePolicyGetResultV1Schema, MachineFinitePolicyMutationResultV1Schema,
  MachineFinitePolicyMutationV1Schema } from '../../machines/machineFinitePolicyV1.js';
import { WorkspaceExecutionConfigAddressV1Schema, WorkspaceExecutionConfigRevisionV1Schema,
  WorkspaceWorkerPreferenceExpectationV1Schema, WorkspaceWorkerPreferenceMutationResultV1Schema,
  WorkspaceWorkerPreferenceReadResultV1Schema, WorkspaceWorkerPreferenceV1Schema } from '../../workspaces/projectWorkerPreferencesV1.js';
import { WorkerDestinationV1Schema } from '../../workspaces/projectWorkerPreferencesV1.js';
import { ProjectMemoryDemandV1Schema } from '../../workspaces/projectSetup/projectMemoryDemandV1.js';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema, WorkspaceSyncStatusV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema } from '../../sessions/control/handoff/workspaceSyncSchemas.js';
import { ProjectWorkerMemoryObservationV1Schema, WorkerLoadObservationV1Schema } from '../../workspaces/projectWorkerExecutionV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import type { ActionInputFieldHint } from '../actionInputHintsRuntime.js';
import { ProjectWorkerNoAcceptanceFailureDetailsV1Schema } from '../projectWorkerRefusal.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { projectZodProtocolSchema } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { WorkspaceSyncCommittedCopyPreviewV1Schema, WorkspaceSyncCommittedCopyPreviewResultV1Schema } from '../../sessions/control/handoff/workspaceSyncCommittedCopyV1.js';
import { PROJECT_SERVICE_PLACEMENT_ACTION_SPECS, ProjectServicePlacementActionInputSchemasV1, ProjectServicePlacementActionOutputSchemasV1 } from './projectServicePlacement.js';
export type ProjectWorkerActionIdV1 = typeof PROJECT_WORKER_ACTION_IDS_V1[number];
export const ProjectWorkerActionIdV1Schema = lazyZodSchema(() => z.enum(PROJECT_WORKER_ACTION_IDS_V1));

export const WorkspaceWorkerPreferenceGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: WorkspaceExecutionConfigAddressV1Schema,
}));
export const WorkspaceWorkerPreferenceResetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkspaceWorkerPreferenceGetInputV1Schema, {
  expectedRevision: WorkspaceExecutionConfigRevisionV1Schema,
  expected: WorkspaceWorkerPreferenceExpectationV1Schema,
})));
export const WorkspaceWorkerPreferenceSetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkspaceWorkerPreferenceResetInputV1Schema, {
  next: WorkspaceWorkerPreferenceV1Schema,
})));
export const WorkspaceWorkerPreferenceSetInputV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(WorkspaceWorkerPreferenceSetInputV1Schema));
export const MachineWorkerPolicyGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)), machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export const MachineWorkerPolicySetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineFinitePolicyMutationV1Schema, MachineWorkerPolicyGetInputV1Schema.shape)));

export const ProjectWorkerStatusInputV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: WorkspaceExecutionConfigAddressV1Schema,
  // Pool resolution belongs to the incumbent pool caller, never this exact daemon read.
  destination: WorkerDestinationV1Schema._zod.def.options[0],
  purpose: z.enum(['finite', 'service-start']),
  memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
}));
/** Load is advisory; eligibility comes from current capability/access/policy/drain observations. */
export const ProjectWorkerStatusResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('eligible', [
  z.strictObject({ eligible: z.literal(true), load: WorkerLoadObservationV1Schema,
    observedMemory: z.optional(ProjectWorkerMemoryObservationV1Schema),
    lastCleanSyncAtMs: WorkspaceSyncStatusV1Schema.shape.lastCleanSyncAtMs,
    candidate: MachineWorkerPolicyGetInputV1Schema,
    explanation: z.enum(['eligible', 'load_unknown']) }),
  z.strictObject({ eligible: z.literal(false), load: WorkerLoadObservationV1Schema, candidate: z.null(),
    observedMemory: z.optional(ProjectWorkerMemoryObservationV1Schema),
    lastCleanSyncAtMs: WorkspaceSyncStatusV1Schema.shape.lastCleanSyncAtMs,
    explanation: z.enum(['not_accepting', 'draining', 'policy_unavailable', 'unsupported', 'forbidden',
      'workspace_unavailable', 'worker_copy_missing', 'unavailable', 'capability_unknown', 'memory_insufficient', 'memory_unavailable']),
    workerCopy: ProjectWorkerNoAcceptanceFailureDetailsV1Schema.shape.workerCopy,
  }).check(z.refine(value => (value.explanation === 'worker_copy_missing') === (value.workerCopy !== undefined))),
]));
export type ProjectWorkerStatusInputV1 = z.infer<typeof ProjectWorkerStatusInputV1Schema>;
export type ProjectWorkerStatusResultV1 = z.infer<typeof ProjectWorkerStatusResultV1Schema>;

/** The incumbent Sync owner supplies the review identity; this read grants no removal authority. */
export const ProjectWorkerCopyInspectInputV1Schema = lazyZodSchema(() => WorkspaceSyncCommittedCopyPreviewV1Schema);
export const ProjectWorkerCopyInspectResultV1Schema = lazyZodSchema(() => WorkspaceSyncCommittedCopyPreviewResultV1Schema);
export type ProjectWorkerCopyInspectInputV1 = z.infer<typeof ProjectWorkerCopyInspectInputV1Schema>;
export type ProjectWorkerCopyInspectResultV1 = z.infer<typeof ProjectWorkerCopyInspectResultV1Schema>;

export const ProjectWorkerCopyRetireInputV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: WorkspaceExecutionConfigAddressV1Schema,
  machineId: z.string().check(z.trim(), z.minLength(1)),
  expectedRelationship: WorkspaceSyncRelationshipV1Schema,
  removeTargetCopy: z.optional(z.strictObject({
    workspaceRefId: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.targetWorkspaceRefId,
    rootFingerprint: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.rootFingerprint,
  })),
}).check(z.superRefine((input, context) => {
  if (input.removeTargetCopy && input.removeTargetCopy.workspaceRefId !== input.expectedRelationship.alphaWorkspaceRefId
    && input.removeTargetCopy.workspaceRefId !== input.expectedRelationship.betaWorkspaceRefId) {
    context.addIssue({ code: "custom", path: ['removeTargetCopy', 'workspaceRefId'],
      message: 'copy removal must name an endpoint of the reviewed relationship' });
  }
})));
/** Only emitted after confirmed Sync reconciliation and any separately requested removal. */
export const ProjectWorkerCopyRetireResultV1Schema = lazyZodSchema(() => z.strictObject({ status: z.literal('retired') }));
export type ProjectWorkerCopyRetireInputV1 = z.infer<typeof ProjectWorkerCopyRetireInputV1Schema>;
export type ProjectWorkerCopyRetireResultV1 = z.infer<typeof ProjectWorkerCopyRetireResultV1Schema>;

// Preferences and service placement can enter Actions before their own exports
// initialize. Defer both imported schemas and map spreads until consumption.
export const ProjectWorkerActionInputSchemasV1 = lazyDefinition(() => ({
  ...ProjectServicePlacementActionInputSchemasV1,
  'projects.worker.preferences.get': WorkspaceWorkerPreferenceGetInputV1Schema,
  'projects.worker.preferences.set': WorkspaceWorkerPreferenceSetInputV1Schema,
  'projects.worker.preferences.reset': WorkspaceWorkerPreferenceResetInputV1Schema,
  'machines.worker.policy.get': MachineWorkerPolicyGetInputV1Schema,
  'machines.worker.policy.set': MachineWorkerPolicySetInputV1Schema,
  'projects.worker.status': ProjectWorkerStatusInputV1Schema,
  'projects.worker.copy.inspect': ProjectWorkerCopyInspectInputV1Schema,
  'projects.worker.copy.retire': ProjectWorkerCopyRetireInputV1Schema,
} as const satisfies Record<ProjectWorkerActionIdV1, z.ZodMiniType>));
export const ProjectWorkerActionOutputSchemasV1 = lazyDefinition(() => ({
  ...ProjectServicePlacementActionOutputSchemasV1,
  'projects.worker.preferences.get': WorkspaceWorkerPreferenceReadResultV1Schema,
  'projects.worker.preferences.set': WorkspaceWorkerPreferenceMutationResultV1Schema,
  'projects.worker.preferences.reset': WorkspaceWorkerPreferenceMutationResultV1Schema,
  'machines.worker.policy.get': MachineFinitePolicyGetResultV1Schema,
  'machines.worker.policy.set': MachineFinitePolicyMutationResultV1Schema,
  'projects.worker.status': ProjectWorkerStatusResultV1Schema,
  'projects.worker.copy.inspect': ProjectWorkerCopyInspectResultV1Schema,
  'projects.worker.copy.retire': ProjectWorkerCopyRetireResultV1Schema,
} as const satisfies Record<ProjectWorkerActionIdV1, z.ZodMiniType>));
export type ProjectWorkerActionInputV1<TActionId extends ProjectWorkerActionIdV1 = ProjectWorkerActionIdV1> =
  z.infer<typeof ProjectWorkerActionInputSchemasV1[TActionId]>;
export type ProjectWorkerActionOutputV1<TActionId extends ProjectWorkerActionIdV1 = ProjectWorkerActionIdV1> =
  z.infer<typeof ProjectWorkerActionOutputSchemasV1[TActionId]>;

const titles = {
  'projects.worker.preferences.get': 'Read worker preferences',
  'projects.worker.preferences.set': 'Set worker preferences',
  'projects.worker.preferences.reset': 'Reset worker preferences',
  'machines.worker.policy.get': 'Read Machine work policy',
  'machines.worker.policy.set': 'Set Machine work policy',
  'projects.worker.status': 'Read worker status',
  'projects.worker.copy.inspect': 'Review worker copy',
  'projects.worker.copy.retire': 'Retire worker copy',
};
const workspaceField = { path: 'workspace', title: 'Workspace', widget: 'json', required: true } as const;
const machineFields = [
  { path: 'serverId', title: 'Home', widget: 'text', required: true },
  { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
] satisfies ActionInputFieldHint[];
const preferenceExpectationFields = [workspaceField,
  { path: 'expectedRevision', title: 'Expected revision', widget: 'json', required: true },
  { path: 'expected', title: 'Reviewed worker preferences', widget: 'json', required: true },
] satisfies ActionInputFieldHint[];
const copyFields = [workspaceField,
  { path: 'machineId', title: 'Controller machine id', widget: 'text', required: true },
  { path: 'expectedRelationship', title: 'Reviewed copy relationship', widget: 'json', required: true },
] satisfies ActionInputFieldHint[];
// Structured operands retain their complete reviewed union arm, without asking
// for destinations or values that the admitted arm deliberately omits.
const inputFields = {
  'projects.worker.preferences.get': [workspaceField],
  'projects.worker.preferences.set': [...preferenceExpectationFields,
    { path: 'next', title: 'New worker preferences', widget: 'json', required: true }],
  'projects.worker.preferences.reset': preferenceExpectationFields,
  'machines.worker.policy.get': machineFields,
  'machines.worker.policy.set': [...machineFields,
    { path: 'expectedMetadataVersion', title: 'Expected metadata version', widget: 'integer', required: true },
    { path: 'expectedPolicy', title: 'Reviewed work policy', widget: 'json', required: true },
    { path: 'policy', title: 'New work policy', widget: 'json', required: true }],
  'projects.worker.status': [workspaceField,
    { path: 'destination', title: 'Worker destination', widget: 'json', required: true },
    { path: 'purpose', title: 'Execution purpose', widget: 'text', required: true },
    { path: 'memoryDemand', title: 'Reviewed memory demand', widget: 'json' }],
  'projects.worker.copy.inspect': [
    { path: 'kind', title: 'Review kind', widget: 'text', required: true }, ...copyFields,
    { path: 'targetMachineId', title: 'Target machine id', widget: 'text', required: true },
    { path: 'targetWorkspaceRefId', title: 'Target workspace id', widget: 'text', required: true }],
  'projects.worker.copy.retire': [...copyFields,
    { path: 'removeTargetCopy', title: 'Reviewed copy removal', widget: 'json' }],
} satisfies Record<keyof typeof titles, ActionInputFieldHint[]>;
const exampleWorkspace = { serverId: 'home', refId: 'checkout' };
const examplePreference = { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} } as const;
const exampleContentPolicy = { v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] } as const;
const exampleRelationship = {
  v: 1, relationshipId: 'copy-link', controllerMachineId: 'controller', alphaWorkspaceRefId: 'checkout', betaWorkspaceRefId: 'copy',
  mode: 'keep_synced', enabled: true, contentPolicy: { ...exampleContentPolicy,
    policyDigest: computeWorkspaceSyncPolicyDigest(exampleContentPolicy) }, createdAtMs: 1, updatedAtMs: 2,
} satisfies z.infer<typeof WorkspaceSyncRelationshipV1Schema>;
const voiceInputs = {
  'projects.worker.preferences.get': { workspace: exampleWorkspace },
  'projects.worker.preferences.set': { workspace: exampleWorkspace, expectedRevision: 'absent',
    expected: { kind: 'absent' }, next: { ...examplePreference, allowAdHoc: true } },
  'projects.worker.preferences.reset': { workspace: exampleWorkspace, expectedRevision: 1,
    expected: { kind: 'value', value: examplePreference } },
  'machines.worker.policy.get': { serverId: 'home', machineId: 'worker' },
  'machines.worker.policy.set': { serverId: 'home', machineId: 'worker', expectedMetadataVersion: 1,
    expectedPolicy: { accepting: true, runAtMost: null }, policy: { accepting: true, runAtMost: 2 } },
  'projects.worker.status': { workspace: exampleWorkspace, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite' },
  'projects.worker.copy.inspect': { kind: 'preview', workspace: exampleWorkspace, machineId: 'controller',
    expectedRelationship: exampleRelationship, targetMachineId: 'worker', targetWorkspaceRefId: 'copy' },
  'projects.worker.copy.retire': { workspace: exampleWorkspace, machineId: 'controller', expectedRelationship: exampleRelationship },
} satisfies { [Id in keyof typeof titles]: ProjectWorkerActionInputV1<Id> };
export const PROJECT_WORKER_ACTION_SPECS: ActionSpecArrayConcat<readonly [
  typeof PROJECT_SERVICE_PLACEMENT_ACTION_SPECS,
  PreNormalizedActionSpec[],
]> = lazyActionSpecArray(() => [...PROJECT_SERVICE_PLACEMENT_ACTION_SPECS,
  ...(Object.keys(titles) as (keyof typeof titles)[]).map((id): PreNormalizedActionSpec => {
  const read = id.endsWith('.get') || id === 'projects.worker.status' || id === 'projects.worker.copy.inspect';
  const machine = id === 'projects.worker.status' || id === 'projects.worker.copy.inspect' || id === 'projects.worker.copy.retire';
  return {
    id, approval: read ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
    approvalPolicy: { uiConfirmation: id === 'projects.worker.copy.retire' ? 'policy' : 'direct' }, title: titles[id], description: id === 'projects.worker.preferences.get'
      ? 'Read current worker preferences for this exact Home/checkout. Ready values describe the saved destination, per-script overrides, fallback and explicit ad-hoc opt-in; locked, invalid or unavailable is not disabled or primary. After projects.inspect, use these facts to explain the effective default without overriding a primary-only declaration. Observe an exact Machine with projects.worker.status; for a pool use machines.pools.resolve with purpose finite and this workspace. Reads and saved choices do not accept work or grant Action approval.'
      : id === 'projects.worker.status'
      ? 'Read current eligibility, refusal reasons and known or unknown load for an exact Machine without waking it, copying files or accepting work. Use purpose finite for Scripts and pass any reviewed memory demand. Unknown load is not zero, and a full eligible worker queues accepted work. A worker_copy_missing refusal identifies the exact source and target for explicit workspace.sync.relationship.create with purpose worker_clean_copy and a user-chosen target path; after setup require a new explicit Run. Status is advisory, not accepted placement or consent.'
      : id === 'projects.worker.copy.inspect'
      ? 'Read the current committed worker-copy review identity for the exact Home, relationship and target. Sync checks personal Machine admission, current rows and physical-root custody and supplies rootFingerprint; no caller path, approval or deletion authority is accepted. Use a fresh result for separately reviewed projects.worker.copy.retire removal; not-owned and unavailable are not empty copies.'
      : id === 'projects.worker.copy.retire'
      ? 'Retire the reviewed personal copy relationship, optionally removing its separately reviewed root-custodied copy.'
      : read ? 'Read current worker settings or advisory status without waking a Machine or starting work.'
      : 'Change future Project work preferences or admission without cancelling or retargeting accepted work.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write',
    // Policy writes are Account-side key-holder operations; an offline guest is not their authority.
    executionPlacement: machine ? 'machine' : 'account', placements: [],
    ...(id === 'projects.worker.copy.retire' || isProjectWorkerCopyInspectActionIdV1(id) ? {
      originalExecution: { accountRoot: 'allowed', requesterCredentials: 'none',
        ...(id === 'projects.worker.copy.retire' ? { daemonIngressSurfaces: ['cli'] } : {}) },
    } : {}),
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true,
      rpc: machine },
    bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_'),
      ...(machine ? { rpcMethod: id === 'projects.worker.copy.inspect' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT : id } : {}) },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    inputHints: { title: titles[id], fields: inputFields[id] },
    examples: { voice: { argsExample: JSON.stringify(voiceInputs[id]) } },
    inputSchema: ProjectWorkerActionInputSchemasV1[id], outputSchema: ProjectWorkerActionOutputSchemasV1[id],
  };
})]);
