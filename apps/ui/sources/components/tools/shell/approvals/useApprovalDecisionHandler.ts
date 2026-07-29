import * as React from 'react';

import type { ActionId } from '@happier-dev/protocol';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

type ApprovalDecisionArtifact = Pick<DecryptedArtifact, 'id' | 'header'>;

function readServerId(artifact: ApprovalDecisionArtifact, sessionId: string): string | null {
    const headerServerId = typeof artifact.header?.serverId === 'string' ? artifact.header.serverId.trim() : '';
    if (headerServerId.length > 0) return headerServerId;
    return resolvePreferredServerIdForSessionId(sessionId) ?? null;
}

export function useApprovalDecisionHandler(
    artifact: ApprovalDecisionArtifact,
    sessionId: string,
): (decision: 'approve' | 'reject') => Promise<boolean> {
    const executor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: (targetSessionId) => resolvePreferredServerIdForSessionId(targetSessionId) ?? null,
        }),
        [],
    );
    const serverId = React.useMemo(() => readServerId(artifact, sessionId), [artifact, sessionId]);

    return React.useCallback(async (decision: 'approve' | 'reject') => {
        const result = await executor.execute(
            'approval.request.decide' as ActionId,
            { artifactId: artifact.id, decision },
            { surface: 'ui', ...(serverId ? { serverId } : {}) },
        );
        return result.ok === true;
    }, [artifact.id, executor, serverId]);
}
