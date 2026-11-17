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
): TeamSetupRepositoryProgress {
    const selected = useProjectOpenActionOperation({ ...query,
        serverId: query.serverId ? resolveServerProfileScopeIdForIdentifier(query.serverId) : null });
    const openOperation = useActionOperation(selected ? {
        serverId: selected.serverId, operationId: selected.snapshot.operationId,
    } : null, selected && query.machineId ? { machineId: query.machineId, actionId: 'projects.open', lifetime } : undefined);
    const rawResult = openOperation?.snapshot.result;
    const result = React.useMemo(() => {
        const parsed = OpenProjectResultV1Schema.safeParse(rawResult);
        return parsed.success ? parsed.data : null;
    }, [rawResult]);
    const workspace = result?.kind === 'opened' && 'machineId' in result.workspace ? result.workspace : null;
    const setupOperation = useProjectSetupRun(workspace, query.accountId);
    return React.useMemo(() => ({ openOperation, result, setupOperation }), [openOperation, result, setupOperation]);
}
