import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { OpenProjectResultV1Schema, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { useProjectSetupRun } from '@/components/projects/projectSetup/projectScriptRuns';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { ActionOperationProjectSourceQuery } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { useActionOperation, useProjectHeldSetupReviewOperations, useProjectOpenActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';

export type TeamSetupRepositoryProgress = Readonly<{
    openOperation: ActionOperationProjection | null;
    result: OpenProjectResultV1 | null;
    setupOperation: ActionOperationProjection | null;
}>;

/** Connect an existing Project hold to the Team Source through its registered checkout. */
export function useTeamSetupHeldReviews(
    scope: ServerAccountScope,
    sources: readonly ProjectSourceV1[],
    preview: boolean,
): ReadonlyMap<string, ActionOperationProjection> {
    const sourceIds = React.useMemo(() => new Set(preview ? [] : sources.map(source => source.id)), [preview, sources]);
    const serverId = resolveServerProfileScopeIdForIdentifier(scope.serverId);
    const checkouts = useProjectAccountRows(useShallow(rows =>
        rows && areServerAccountScopesEqual(rows.scope, scope)
            ? rows.workspaceRefs.filter(ref => 'machineId' in ref && ref.source && sourceIds.has(ref.source.sourceId)
                && resolveServerProfileScopeIdForIdentifier(ref.serverId) === serverId)
            : []), sourceIds.size > 0);
    const workspaces = React.useMemo(() => checkouts.map(ref =>
        workspaceAddressFromRefV1({ ...ref, serverId })), [checkouts, serverId]);
    const reviews = useProjectHeldSetupReviewOperations(scope.accountId, workspaces);
    return React.useMemo(() => {
        const byWorkspace = new Map(checkouts.map(ref => [ref.id, ref.source?.sourceId]));
        const bySource = new Map<string, ActionOperationProjection>();
        for (const review of reviews) {
            const project = review.snapshot.domainRef;
            const workspaceId = project?.kind === 'projectCommand' ? project.sourceWorkspace?.workspaceId : undefined;
            const sourceId = workspaceId ? byWorkspace.get(workspaceId) : undefined;
            if (sourceId && !bySource.has(sourceId)) bySource.set(sourceId, review);
        }
        return bySource;
    }, [checkouts, reviews]);
}

/** D composes the Project owners; a prepared Open result is not setup completion. */
export function useTeamSetupRepositoryProgress(
    query: ActionOperationProjectSourceQuery,
    lifetime: ServerAccountScopeLifetime | null,
    acceptedOpen: Extract<OpenProjectResultV1, { kind: 'opened' }> | null = null,
): TeamSetupRepositoryProgress {
    const serverId = query.serverId ? resolveServerProfileScopeIdForIdentifier(query.serverId) : null;
    const selected = useProjectOpenActionOperation({ ...query, serverId });
    const openOperation = useActionOperation(selected ? {
        serverId: selected.serverId, operationId: selected.snapshot.operationId,
    } : null, query.machineId && (selected || query.requestId) ? {
        machineId: query.machineId, actionId: 'projects.open', lifetime, requestId: query.requestId,
    } : undefined);
    const rawResult = openOperation?.snapshot.result;
    const result = React.useMemo(() => {
        const parsed = OpenProjectResultV1Schema.safeParse(rawResult);
        return parsed.success ? parsed.data : null;
    }, [rawResult]);
    const opened = result ?? acceptedOpen;
    const workspace = opened?.kind === 'opened' && 'machineId' in opened.workspace ? opened.workspace : null;
    const latestSetup = useProjectSetupRun(workspace, query.accountId, lifetime);
    const settledAt = latestSetup?.snapshot.settledAt;
    // The current native Open already accounts for matching past completion. An older
    // settlement on the same source Machine cannot settle this selected request.
    const setupOperation = query.requestId && openOperation && settledAt !== undefined && settledAt <= openOperation.snapshot.createdAt
        ? null : latestSetup;
    return React.useMemo(() => ({ openOperation, result, setupOperation }), [openOperation, result, setupOperation]);
}
