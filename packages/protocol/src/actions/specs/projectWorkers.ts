import { z } from 'zod';

import { lazyZodSchema } from '../../lazyZodSchema.js';
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
import { ProjectWorkerNoAcceptanceFailureDetailsV1Schema } from '../projectWorkerRefusal.js';
import { PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1, PROJECT_SERVICE_PLACEMENT_ACTION_SPECS,
  ProjectServicePlacementActionInputSchemasV1, ProjectServicePlacementActionOutputSchemasV1 } from './projectServicePlacement.js';

export const PROJECT_WORKER_ACTION_IDS_V1 = [
  'projects.worker.preferences.get', 'projects.worker.preferences.set', 'projects.worker.preferences.reset',
  'machines.worker.policy.get', 'machines.worker.policy.set',
  'projects.worker.status', 'projects.worker.copy.retire',
  ...PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1,
] as const;
export type ProjectWorkerActionIdV1 = typeof PROJECT_WORKER_ACTION_IDS_V1[number];
export const ProjectWorkerActionIdV1Schema = lazyZodSchema(() => z.enum(PROJECT_WORKER_ACTION_IDS_V1));

export const WorkspaceWorkerPreferenceGetInputV1Schema = lazyZodSchema(() => z.object({
  workspace: WorkspaceExecutionConfigAddressV1Schema,
}).strict());
export const WorkspaceWorkerPreferenceResetInputV1Schema = lazyZodSchema(() => WorkspaceWorkerPreferenceGetInputV1Schema.extend({
  expectedRevision: WorkspaceExecutionConfigRevisionV1Schema,
  expected: WorkspaceWorkerPreferenceExpectationV1Schema,
}).strict());
export const WorkspaceWorkerPreferenceSetInputV1Schema = lazyZodSchema(() => WorkspaceWorkerPreferenceResetInputV1Schema.extend({
  next: WorkspaceWorkerPreferenceV1Schema,
}).strict());
export const MachineWorkerPolicyGetInputV1Schema = lazyZodSchema(() => z.object({
  serverId: z.string().trim().min(1), machineId: z.string().trim().min(1),
}).strict());
export const MachineWorkerPolicySetInputV1Schema = lazyZodSchema(() => MachineFinitePolicyMutationV1Schema.extend(
  MachineWorkerPolicyGetInputV1Schema.shape,
).strict());

export const ProjectWorkerStatusInputV1Schema = lazyZodSchema(() => z.object({
  workspace: WorkspaceExecutionConfigAddressV1Schema,
  // Pool resolution belongs to the incumbent pool caller, never this exact daemon read.
  destination: WorkerDestinationV1Schema.options[0],
  purpose: z.enum(['finite', 'service-start']),
  memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
}).strict());
/** Load is advisory; eligibility comes from current capability/access/policy/drain observations. */
export const ProjectWorkerStatusResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('eligible', [
  z.object({ eligible: z.literal(true), load: WorkerLoadObservationV1Schema,
    observedMemory: ProjectWorkerMemoryObservationV1Schema.optional(),
    lastCleanSyncAtMs: WorkspaceSyncStatusV1Schema.shape.lastCleanSyncAtMs,
    candidate: MachineWorkerPolicyGetInputV1Schema,
    explanation: z.enum(['eligible', 'load_unknown']) }).strict(),
  z.object({ eligible: z.literal(false), load: WorkerLoadObservationV1Schema, candidate: z.null(),
    observedMemory: ProjectWorkerMemoryObservationV1Schema.optional(),
    lastCleanSyncAtMs: WorkspaceSyncStatusV1Schema.shape.lastCleanSyncAtMs,
    explanation: z.enum(['not_accepting', 'draining', 'policy_unavailable', 'unsupported', 'forbidden',
      'workspace_unavailable', 'worker_copy_missing', 'unavailable', 'capability_unknown', 'memory_insufficient', 'memory_unavailable']),
    workerCopy: ProjectWorkerNoAcceptanceFailureDetailsV1Schema.shape.workerCopy,
  }).strict().refine(value => (value.explanation === 'worker_copy_missing') === (value.workerCopy !== undefined)),
]));
export type ProjectWorkerStatusInputV1 = z.infer<typeof ProjectWorkerStatusInputV1Schema>;
export type ProjectWorkerStatusResultV1 = z.infer<typeof ProjectWorkerStatusResultV1Schema>;

export const ProjectWorkerCopyRetireInputV1Schema = lazyZodSchema(() => z.object({
  workspace: WorkspaceExecutionConfigAddressV1Schema,
  machineId: z.string().trim().min(1),
  expectedRelationship: WorkspaceSyncRelationshipV1Schema,
  removeTargetCopy: z.object({
    workspaceRefId: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.targetWorkspaceRefId,
    rootFingerprint: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.rootFingerprint,
  }).strict().optional(),
}).strict().superRefine((input, context) => {
  if (input.removeTargetCopy && input.removeTargetCopy.workspaceRefId !== input.expectedRelationship.alphaWorkspaceRefId
    && input.removeTargetCopy.workspaceRefId !== input.expectedRelationship.betaWorkspaceRefId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['removeTargetCopy', 'workspaceRefId'],
      message: 'copy removal must name an endpoint of the reviewed relationship' });
  }
}));
/** Only emitted after confirmed Sync reconciliation and any separately requested removal. */
export const ProjectWorkerCopyRetireResultV1Schema = lazyZodSchema(() => z.object({ status: z.literal('retired') }).strict());
export type ProjectWorkerCopyRetireInputV1 = z.infer<typeof ProjectWorkerCopyRetireInputV1Schema>;
export type ProjectWorkerCopyRetireResultV1 = z.infer<typeof ProjectWorkerCopyRetireResultV1Schema>;

export const ProjectWorkerActionInputSchemasV1 = {
  ...ProjectServicePlacementActionInputSchemasV1,
  'projects.worker.preferences.get': WorkspaceWorkerPreferenceGetInputV1Schema,
  'projects.worker.preferences.set': WorkspaceWorkerPreferenceSetInputV1Schema,
  'projects.worker.preferences.reset': WorkspaceWorkerPreferenceResetInputV1Schema,
  'machines.worker.policy.get': MachineWorkerPolicyGetInputV1Schema,
  'machines.worker.policy.set': MachineWorkerPolicySetInputV1Schema,
  'projects.worker.status': ProjectWorkerStatusInputV1Schema,
  'projects.worker.copy.retire': ProjectWorkerCopyRetireInputV1Schema,
} as const satisfies Record<ProjectWorkerActionIdV1, z.ZodTypeAny>;
export const ProjectWorkerActionOutputSchemasV1 = {
  ...ProjectServicePlacementActionOutputSchemasV1,
  'projects.worker.preferences.get': WorkspaceWorkerPreferenceReadResultV1Schema,
  'projects.worker.preferences.set': WorkspaceWorkerPreferenceMutationResultV1Schema,
  'projects.worker.preferences.reset': WorkspaceWorkerPreferenceMutationResultV1Schema,
  'machines.worker.policy.get': MachineFinitePolicyGetResultV1Schema,
  'machines.worker.policy.set': MachineFinitePolicyMutationResultV1Schema,
  'projects.worker.status': ProjectWorkerStatusResultV1Schema,
  'projects.worker.copy.retire': ProjectWorkerCopyRetireResultV1Schema,
} as const satisfies Record<ProjectWorkerActionIdV1, z.ZodTypeAny>;
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
  'projects.worker.copy.retire': 'Retire worker copy',
};
const exampleWorkspace = { serverId: 'home', refId: 'checkout' };
const examplePreference = { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} } as const;
const exampleContentPolicy = { v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] } as const;
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
  'projects.worker.copy.retire': { workspace: exampleWorkspace, machineId: 'controller', expectedRelationship: {
    v: 1, relationshipId: 'copy-link', controllerMachineId: 'controller', alphaWorkspaceRefId: 'checkout', betaWorkspaceRefId: 'copy',
    mode: 'keep_synced', enabled: true, contentPolicy: { ...exampleContentPolicy,
      policyDigest: computeWorkspaceSyncPolicyDigest(exampleContentPolicy) }, createdAtMs: 1, updatedAtMs: 2,
  } },
} satisfies { [Id in keyof typeof titles]: ProjectWorkerActionInputV1<Id> };
export const PROJECT_WORKER_ACTION_SPECS = [...PROJECT_SERVICE_PLACEMENT_ACTION_SPECS,
  ...(Object.keys(titles) as (keyof typeof titles)[]).map((id): PreNormalizedActionSpec => {
  const read = id.endsWith('.get') || id === 'projects.worker.status';
  return {
    id, title: titles[id], description: id === 'projects.worker.copy.retire'
      ? 'Retire the reviewed personal copy relationship, optionally removing its separately reviewed root-custodied copy.'
      : read ? 'Read current worker settings or advisory status without waking a Machine or starting work.'
      : 'Change future Project work preferences or admission without cancelling or retargeting accepted work.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write',
    // Policy writes are Account-side key-holder operations; an offline guest is not their authority.
    executionPlacement: id === 'projects.worker.status' || id === 'projects.worker.copy.retire' ? 'machine' : 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true,
      rpc: id === 'projects.worker.status' || id === 'projects.worker.copy.retire' },
    bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_'),
      ...(id === 'projects.worker.status' || id === 'projects.worker.copy.retire' ? { rpcMethod: id } : {}) },
    cli: { commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    inputHints: { title: titles[id], fields: [] },
    examples: { voice: { argsExample: JSON.stringify(voiceInputs[id]) } },
    inputSchema: ProjectWorkerActionInputSchemasV1[id], outputSchema: ProjectWorkerActionOutputSchemasV1[id],
  };
})];
