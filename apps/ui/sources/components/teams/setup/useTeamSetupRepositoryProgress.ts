import * as React from 'react';
import { OpenProjectResultV1Schema, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';

import { useProjectSetupRun } from '@/components/projects/projectSetup/projectScriptRuns';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { ActionOperationProjectSourceQuery } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { useActionOperation, useProjectOpenActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type TeamSetupRepositoryProgress = Readonly<{
    openOperation: ActionOperationProjection | null;
    result: OpenProjectResultV1 | null;
    setupOperation: ActionOperationProjection | null;
}>;

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
