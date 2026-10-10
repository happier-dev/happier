import { z } from 'zod';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { DaemonLocalServiceLauncherSnapshotRequestV1Schema, DaemonLocalServiceLauncherSnapshotResponseV1Schema,
  LocalServiceLaunchTargetV1Schema, type DaemonLocalServiceLauncherSnapshotRequestV1 } from '../local/services/launcher/v1.js';
import type { WorkspaceSyncRelationshipV1 } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import type { WorkspaceRefV1 } from './workspaceRefV1.js';
import { deriveWorkspaceSyncTopology, resolveWorkspaceSyncEndpoint, type WorkspaceSyncChildMachineFacts } from './workspaceSyncTopology.js';
import { resolveWorkspaceRefV1, type WorkspaceRefResolutionContextV1 } from './workspaceRefResolutionV1.js';
import { createProjectServiceDeclarationTargetIdV1 } from '../local/services/actions/v1.js';
import { ProjectExecutionChoiceV1Schema, WorkspaceExecutionConfigAddressV1Schema,
  WorkspaceExecutionConfigRevisionV1Schema, createDefaultWorkspaceExecutionSettingsV1,
  projectExecutionChoicesEqualV1,
  type WorkspaceExecutionSettingsV1 } from './projectWorkerPreferencesV1.js';

/** Desired service placement; actual native service custody belongs to Local Services. */
export const ProjectServicePlacementV1Schema = lazyZodSchema(() => z.object({
  runsOn: ProjectExecutionChoiceV1Schema,
  unavailable: z.enum(['primary', 'fail']),
}).strict());
export type ProjectServicePlacementV1 = z.infer<typeof ProjectServicePlacementV1Schema>;
export const ProjectServicePlacementV1StoredSchema = createStoredReadSchema(ProjectServicePlacementV1Schema);

export const ProjectServicePlacementExpectationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('value'), value: ProjectServicePlacementV1Schema }).strict(),
]));
export type ProjectServicePlacementExpectationV1 = z.infer<typeof ProjectServicePlacementExpectationV1Schema>;
export const ProjectServicePlacementGetV1Schema = lazyZodSchema(() => z.object({
  workspace: WorkspaceExecutionConfigAddressV1Schema, serviceName: z.string().min(1),
}).strict());
export type ProjectServicePlacementGetV1 = z.infer<typeof ProjectServicePlacementGetV1Schema>;
export const ProjectServicePlacementSetV1Schema = lazyZodSchema(() => ProjectServicePlacementGetV1Schema.extend({
  expectedRevision: WorkspaceExecutionConfigRevisionV1Schema,
  expected: ProjectServicePlacementExpectationV1Schema, value: ProjectServicePlacementV1Schema,
}).strict());
export type ProjectServicePlacementSetV1 = z.infer<typeof ProjectServicePlacementSetV1Schema>;
const ObservationSchema = lazyZodSchema(() => z.object({
  placement: ProjectServicePlacementV1Schema, revision: WorkspaceExecutionConfigRevisionV1Schema,
  provenance: z.enum(['default', 'saved']),
}));
export const ProjectServicePlacementReadResultV1Schema = lazyZodSchema(() => z.union([
  ObservationSchema.extend({ status: z.literal('ready') }).strict(),
  z.object({ status: z.enum(['locked', 'invalid', 'unavailable']) }).strict(),
]));
export type ProjectServicePlacementReadResultV1 = z.infer<typeof ProjectServicePlacementReadResultV1Schema>;
// Reuse Local Services' observation, while refusing an inert suggestion as native custody.
const ObservedManagedTargetSchema = lazyZodSchema(() => LocalServiceLaunchTargetV1Schema.refine(target =>
  target.source === 'managed_service' && target.sourceClass?.kind === 'managed_service'
  && target.workspace !== undefined && target.workspaceId === target.workspace.workspaceId
  && target.machineId === target.workspace.machineId && target.declaration !== undefined
  && target.declaration.workspaceRefId === target.workspaceId && target.cwd !== undefined
  && target.serviceState !== undefined, 'A current native binding requires exact managed provenance'));
export const ProjectServicePlacementGetResultV1Schema = lazyZodSchema(() => z.union([
  ObservationSchema.extend({ status: z.literal('ready'), actual: z.union([
    z.object({ status: z.literal('present'), target: ObservedManagedTargetSchema }).strict(),
    z.object({ status: z.literal('ambiguous'), targets: z.array(ObservedManagedTargetSchema).min(2) }).strict(),
    z.object({ status: z.enum(['absent', 'unavailable']) }).strict(),
  ]) }).strict(),
  z.object({ status: z.enum(['locked', 'invalid', 'unavailable']) }).strict(),
]));
export type ProjectServicePlacementGetResultV1 = z.infer<typeof ProjectServicePlacementGetResultV1Schema>;
export const ProjectServicePlacementMutationResultV1Schema = lazyZodSchema(() => z.union([
  ObservationSchema.extend({ status: z.enum(['applied', 'satisfied', 'unchanged', 'conflict']) }).strict(),
  z.object({ status: z.enum(['outcomeUnknown', 'cancelled', 'locked', 'invalid', 'unavailable']) }).strict(),
]));
export type ProjectServicePlacementMutationResultV1 = z.infer<typeof ProjectServicePlacementMutationResultV1Schema>;

export function createDefaultProjectServicePlacementV1(): ProjectServicePlacementV1 {
  return { runsOn: { kind: 'primary' }, unavailable: 'fail' };
}
export function projectServicePlacementsEqualV1(left: ProjectServicePlacementV1, right: ProjectServicePlacementV1): boolean {
  return left.unavailable === right.unavailable && projectExecutionChoicesEqualV1(left.runsOn, right.runsOn);
}
export function readProjectServicePlacementEntryV1(current: WorkspaceExecutionSettingsV1 | null, serviceName: string): ProjectServicePlacementV1 | null {
  return current && Object.hasOwn(current.services, serviceName) ? current.services[serviceName] ?? null : null;
}
/** This semantic writer owns one service entry; finite preferences and other service intents are preserved. */
export function compareProjectServicePlacementMutationV1(input: Readonly<{
  current: WorkspaceExecutionSettingsV1 | null; serviceName: string;
  expected: ProjectServicePlacementExpectationV1; value: ProjectServicePlacementV1;
}>): Readonly<{ status: 'apply'; value: WorkspaceExecutionSettingsV1 }>
  | Readonly<{ status: 'unchanged' | 'satisfied' | 'conflict'; value: WorkspaceExecutionSettingsV1 | null }> {
  const entry = readProjectServicePlacementEntryV1(input.current, input.serviceName);
  const matches = input.expected.kind === 'absent' ? entry === null
    : entry !== null && projectServicePlacementsEqualV1(entry, input.expected.value);
  // Persisting an explicit primary/fail choice still creates an entry; its absence remains a distinct CAS expectation.
  if (entry !== null && projectServicePlacementsEqualV1(entry, input.value)) return { status: matches ? 'unchanged' : 'satisfied', value: input.current };
  if (!matches) return { status: 'conflict', value: input.current };
  return { status: 'apply', value: { ...(input.current ?? createDefaultWorkspaceExecutionSettingsV1()),
    services: { ...input.current?.services, [input.serviceName]: input.value } } };
}

/** Per-read projection over accepted Sync endpoints and the existing exact native owners. */
export async function observeProjectServicePlacementActualV1(input: Readonly<{
  workspace: ProjectServicePlacementGetV1['workspace']; serviceName: string;
  workspaceRefs: readonly WorkspaceRefV1[]; relationships: readonly WorkspaceSyncRelationshipV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
  context?: WorkspaceRefResolutionContextV1;
  readSnapshot(request: DaemonLocalServiceLauncherSnapshotRequestV1): Promise<unknown>;
  isCurrent(): boolean | Promise<boolean>;
}>): Promise<Extract<ProjectServicePlacementGetResultV1, { status: 'ready' }>['actual']> {
  const unavailable = { status: 'unavailable' } as const;
  if (!await input.isCurrent()) return unavailable;
  const source = resolveWorkspaceRefV1(input.workspaceRefs, { serverId: input.workspace.serverId, id: input.workspace.refId }, input.context);
  if (source.kind !== 'resolved') return unavailable;
  const sourceEndpoint = resolveWorkspaceSyncEndpoint({ ...input, workspace: source.ref, purpose: 'admitted_mapping' });
  if (!sourceEndpoint.ok) return unavailable;
  const incidentIds = new Set(input.relationships.filter(edge => edge.alphaWorkspaceRefId === sourceEndpoint.endpoint.id
    || edge.betaWorkspaceRefId === sourceEndpoint.endpoint.id).map(edge => edge.relationshipId));
  const topology = deriveWorkspaceSyncTopology({ serverId: input.workspace.serverId, context: input.context,
    workspaceRefs: input.workspaceRefs, relationships: input.relationships });
  if (topology.issues.some(issue => issue.workspaceRefIds.includes(sourceEndpoint.endpoint.id)
    || issue.relationshipIds.some(id => incidentIds.has(id)))) return unavailable;
  const component = topology.sets.find(set => set.relationships.some(edge => incidentIds.has(edge.relationshipId)));
  // Paused and one-way links still qualify an existing native occurrence for observation.
  const physicalIds = new Set([sourceEndpoint.endpoint.id,
    ...(component?.relationships.flatMap(edge => [edge.alphaWorkspaceRefId, edge.betaWorkspaceRefId]) ?? [])]);
  const ids = new Set<string>();
  for (const workspace of input.workspaceRefs) {
    if (workspace.serverId !== input.workspace.serverId) continue;
    const endpoint = resolveWorkspaceSyncEndpoint({ ...input, workspace, purpose: 'admitted_mapping' });
    if (!endpoint.ok) return unavailable;
    if (physicalIds.has(endpoint.endpoint.id)) ids.add(workspace.id);
  }
  const targets: z.infer<typeof LocalServiceLaunchTargetV1Schema>[] = [];
  try {
    for (const id of ids) {
      if (!await input.isCurrent()) return unavailable;
      const ref = resolveWorkspaceRefV1(input.workspaceRefs, { serverId: input.workspace.serverId, id }, input.context);
      if (ref.kind !== 'resolved') return unavailable;
      const request = DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse({ machineId: ref.ref.machineId,
        scope: 'workspace', workspaceRoot: ref.ref.rootPath, projection: 'managed_bindings' });
      const response = DaemonLocalServiceLauncherSnapshotResponseV1Schema.safeParse(await input.readSnapshot(request));
      if (!await input.isCurrent() || !response.success || response.data.snapshot.machineId !== ref.ref.machineId) return unavailable;
      for (const value of response.data.snapshot.targets) {
        const observed = ObservedManagedTargetSchema.safeParse(value);
        if (!observed.success) return unavailable;
        const target = observed.data;
        if (target.workspaceId !== ref.ref.id) continue;
        if (!target.workspace || resolveWorkspaceRefV1([ref.ref], target.workspace, input.context).kind !== 'resolved') return unavailable;
        const selection = target.declaration?.selection;
        if (selection?.kind === 'manifest' ? selection.name === input.serviceName
          : selection && createProjectServiceDeclarationTargetIdV1(source.ref, selection) === input.serviceName) targets.push(target);
      }
    }
    if (!await input.isCurrent()) return unavailable;
    return targets.length === 0 ? { status: 'absent' } : targets.length === 1
      ? { status: 'present', target: targets[0]! } : { status: 'ambiguous', targets };
  } catch { return unavailable; }
}
