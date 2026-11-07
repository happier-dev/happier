import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { getWorkspaceSyncWorkerCopyV1, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

export function workerCopyStatusKey(sourceWorkspaceRefId: string, machineId: string): string {
    return JSON.stringify([sourceWorkspaceRefId, machineId]);
}

type CopyRows = Readonly<{
    scope: Readonly<{ serverId: string }>;
    workspaceRefs: readonly WorkspaceRefV1[];
    relationships: readonly WorkspaceSyncRelationshipV1[];
    workerCopyStatusRevisions?: Readonly<Record<string, number>>;
}>;
const EMPTY_REVISIONS: Readonly<Record<string, number>> = Object.freeze({});

/** Reconcile exact source/target invalidations once where the pushed graph is admitted. */
export function advanceWorkerCopyStatusRevisions(previous: CopyRows, next: CopyRows): Readonly<Record<string, number>> {
    const revisions = previous.workerCopyStatusRevisions ?? EMPTY_REVISIONS;
    if (previous.workspaceRefs === next.workspaceRefs && previous.relationships === next.relationships) return revisions;
    const refs = (rows: CopyRows) => new Map(rows.workspaceRefs.filter(ref => ref.serverId === rows.scope.serverId).map(ref => [ref.id, ref]));
    const beforeRefs = refs(previous);
    const afterRefs = refs(next);
    const beforeRelationships = new Map(previous.relationships.map(relationship => [relationship.relationshipId, relationship]));
    const afterRelationships = new Map(next.relationships.map(relationship => [relationship.relationshipId, relationship]));
    const affected = new Set<string>();
    const changed = (before: WorkspaceSyncRelationshipV1 | undefined, after: WorkspaceSyncRelationshipV1 | undefined) => {
        const oldCopy = before && getWorkspaceSyncWorkerCopyV1(before);
        const newCopy = after && getWorkspaceSyncWorkerCopyV1(after);
        const oldTarget = oldCopy && beforeRefs.get(oldCopy.targetWorkspaceRefId);
        const newTarget = newCopy && afterRefs.get(newCopy.targetWorkspaceRefId);
        if (before === after && oldTarget?.id === newTarget?.id && oldTarget?.machineId === newTarget?.machineId && oldTarget?.rootPath === newTarget?.rootPath) return;
        if (oldCopy && oldTarget) affected.add(workerCopyStatusKey(oldCopy.sourceWorkspaceRefId, oldTarget.machineId));
        if (newCopy && newTarget) affected.add(workerCopyStatusKey(newCopy.sourceWorkspaceRefId, newTarget.machineId));
    };
    beforeRelationships.forEach((relationship, id) => changed(relationship, afterRelationships.get(id)));
    afterRelationships.forEach((relationship, id) => { if (!beforeRelationships.has(id)) changed(undefined, relationship); });
    if (affected.size === 0) return revisions;
    const updated = { ...revisions };
    for (const key of affected) updated[key] = (revisions[key] ?? 0) + 1;
    return updated;
}
