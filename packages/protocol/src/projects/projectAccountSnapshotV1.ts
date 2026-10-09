import * as z from 'zod/mini';

import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { lazyDefinition } from '../lazyZodSchema.js';
import {
  areWorkspaceSyncRelationshipDefinitionsEqual,
  areWorkspaceSyncWorkerCopyProvenancesEqual,
  WorkspaceSyncRelationshipV1Schema,
  type WorkspaceSyncRelationshipV1,
} from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { WorkspaceRefV1Schema, type WorkspaceRefV1 } from '../workspaces/workspaceRefV1.js';
import { resolveWorkspaceRefV1 } from '../workspaces/workspaceRefResolutionV1.js';
import { deriveWorkspaceSyncTopology } from '../workspaces/workspaceSyncTopology.js';

/** Opened Account-owned records. Physical revisions/envelopes belong to the row transport. */
export type ProjectAccountSnapshotV1 = Readonly<{
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
}>;

export const ProjectAccountSnapshotV1Schema = lazyDefinition(() => z.strictObject({
  workspaceRefs: z._default(z.array(WorkspaceRefV1Schema), []),
  relationships: z._default(z.array(WorkspaceSyncRelationshipV1Schema), []),
}).check(z.superRefine((snapshot, context) => {
  snapshot.workspaceRefs.forEach((ref, index) => {
    const resolution = resolveWorkspaceRefV1(snapshot.workspaceRefs, { id: ref.id, serverId: ref.serverId });
    if (resolution.kind !== 'resolved') {
      context.addIssue({ code: 'custom', path: ['workspaceRefs', index, 'id'], message: 'qualified workspace reference id must be unique' });
    }
  });
  const relationshipIds = new Set<string>();
  snapshot.relationships.forEach((relationship, index) => {
    if (relationshipIds.has(relationship.relationshipId)) {
      context.addIssue({ code: 'custom', path: ['relationships', index, 'relationshipId'], message: 'workspace relationship id must be unique' });
    }
    relationshipIds.add(relationship.relationshipId);
    const alpha = resolveWorkspaceRefV1(snapshot.workspaceRefs, { id: relationship.alphaWorkspaceRefId });
    const beta = resolveWorkspaceRefV1(snapshot.workspaceRefs, { id: relationship.betaWorkspaceRefId });
    for (const [field, resolution] of [['alphaWorkspaceRefId', alpha], ['betaWorkspaceRefId', beta]] as const) {
      if (resolution.kind !== 'resolved') {
        context.addIssue({ code: 'custom', path: ['relationships', index, field], message: 'workspace relationship reference must exist unambiguously' });
      }
    }
    if (alpha.kind === 'resolved' && beta.kind === 'resolved' && alpha.ref.serverId.trim() !== beta.ref.serverId.trim()) {
      context.addIssue({ code: 'custom', path: ['relationships', index], message: 'workspace relationship references must share a Home' });
    }
  });
})));

const StoredProjectAccountSnapshotV1Schema = lazyDefinition(() => createStoredReadSchema(ProjectAccountSnapshotV1Schema));

/** Malformed known records refuse; historical extras are projected away without choosing a duplicate. */
export function parseProjectAccountSnapshotV1(raw: unknown): ProjectAccountSnapshotV1 {
  return StoredProjectAccountSnapshotV1Schema.parse(raw);
}

/** Forget is metadata-only and idempotent; even paused links retain their endpoints. */
export function resolveProjectAccountWorkspaceRefRemovalV1(
  snapshot: Readonly<{ workspaceRefs: readonly WorkspaceRefV1[]; relationships: readonly Pick<WorkspaceSyncRelationshipV1,
    'relationshipId' | 'alphaWorkspaceRefId' | 'betaWorkspaceRefId'>[] }>,
  input: Readonly<{ serverId: string; workspaceRefId: string }>,
  context?: Parameters<typeof resolveWorkspaceRefV1>[2],
): readonly WorkspaceRefV1[] {
  const result = resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId: input.serverId.trim(), id: input.workspaceRefId.trim() }, context);
  if (result.kind === 'missing') return snapshot.workspaceRefs;
  if (result.kind !== 'resolved') throw Object.assign(new Error(`workspace_ref_${result.kind}`), { code: `workspace_ref_${result.kind}` });
  const relationshipIds = snapshot.relationships.filter(link => link.alphaWorkspaceRefId.trim() === result.ref.id.trim() || link.betaWorkspaceRefId.trim() === result.ref.id.trim())
    .map(link => link.relationshipId);
  if (relationshipIds.length > 0) throw Object.assign(new Error('workspace_ref_in_use'), { code: 'workspace_ref_in_use', relationshipIds });
  return snapshot.workspaceRefs.filter(ref => ref !== result.ref);
}

/** The sole opened-record identity/topology admission owner for UI and CLI semantic mutations. */
export function assertProjectAccountSnapshotTransition(
  previous: ProjectAccountSnapshotV1,
  next: ProjectAccountSnapshotV1,
): void {
  ProjectAccountSnapshotV1Schema.parse({ workspaceRefs: previous.workspaceRefs, relationships: previous.relationships });
  ProjectAccountSnapshotV1Schema.parse({ workspaceRefs: next.workspaceRefs, relationships: next.relationships });
  for (const previousRef of previous.workspaceRefs) {
    const nextResolution = resolveWorkspaceRefV1(next.workspaceRefs, { id: previousRef.id, serverId: previousRef.serverId });
    if (nextResolution.kind === 'resolved'
      && (nextResolution.ref.machineId !== previousRef.machineId
        || nextResolution.ref.rootPath !== previousRef.rootPath
        || (nextResolution.ref.projectKey ?? nextResolution.ref.id) !== (previousRef.projectKey ?? previousRef.id))) {
      throw Object.assign(new Error('Workspace identity cannot be rebound'), { code: 'workspace_ref_in_use' });
    }
  }
  const previousRelationships = new Map(previous.relationships.map((relationship) => [relationship.relationshipId, relationship] as const));
  for (const relationship of next.relationships) {
    const prior = previousRelationships.get(relationship.relationshipId);
    if (prior && (!areWorkspaceSyncRelationshipDefinitionsEqual(prior, relationship)
      || !areWorkspaceSyncWorkerCopyProvenancesEqual(prior, relationship))) {
      throw Object.assign(new Error('Workspace relationship immutable definition cannot change'), { code: 'relationship_definition_conflict' });
    }
    if (prior) {
      for (const refId of [prior.alphaWorkspaceRefId, prior.betaWorkspaceRefId]) {
        const previousResolution = resolveWorkspaceRefV1(previous.workspaceRefs, { id: refId });
        if (previousResolution.kind === 'resolved'
          && resolveWorkspaceRefV1(next.workspaceRefs, {
            id: previousResolution.ref.id, serverId: previousResolution.ref.serverId,
          }).kind !== 'resolved') {
          throw Object.assign(new Error('Workspace identity cannot be rebound'), { code: 'workspace_ref_in_use' });
        }
      }
    }
  }
  const requiringAdmission = next.relationships.filter((relationship) => {
    const prior = previousRelationships.get(relationship.relationshipId);
    return !prior || (!prior.enabled && relationship.enabled);
  });
  if (requiringAdmission.length === 0) return;

  const topology = deriveWorkspaceSyncTopology({
    workspaceRefs: next.workspaceRefs,
    relationships: next.relationships,
  });
  const nextByRef = new Map<string, Set<string>>();
  const nextByRelationship = new Map(next.relationships.map((relationship) => [relationship.relationshipId, relationship] as const));
  for (const relationship of next.relationships) {
    for (const refId of [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]) {
      const ids = nextByRef.get(refId) ?? new Set<string>();
      ids.add(relationship.relationshipId);
      nextByRef.set(refId, ids);
    }
  }
  const affected = new Set(requiringAdmission.map((relationship) => relationship.relationshipId));
  const pending = [...affected];
  for (let index = 0; index < pending.length; index += 1) {
    const relationship = nextByRelationship.get(pending[index]);
    if (!relationship) continue;
    for (const refId of [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]) {
      for (const adjacentId of nextByRef.get(refId) ?? []) {
        if (affected.has(adjacentId)) continue;
        affected.add(adjacentId);
        pending.push(adjacentId);
      }
    }
  }
  const issues = topology.issues.filter((issue) => issue.relationshipIds.some((id) => affected.has(id)));
  if (issues.length > 0) {
    throw Object.assign(new Error('Workspace sync topology is unsupported'), { code: 'workspace_sync_topology_invalid', issues });
  }
}
