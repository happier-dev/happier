import * as React from 'react';
import type { ReviewEngineInventory, ReviewEngineScope } from '@happier-dev/protocol/reviews/reviewEngines';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

import { listReviewEngines } from '@/sync/ops/reviews/reviewWalkthrough';
import { captureMachineContributionRegistryProjectionScope } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

type InventoryState =
    | Readonly<{ status: 'idle' | 'loading' }>
    | Readonly<{ status: 'ready'; inventory: ReviewEngineInventory }>
    | Readonly<{ status: 'error'; error: string; failure?: ActionExecuteFailure }>;

/** Subscribe only while editing a Review draft; a changed target retires the previous read. */
export function useReviewEngineInventory(params: Readonly<{
    enabled: boolean;
    scope?: ReviewEngineScope;
    sessionId: string | null;
    machineId?: string;
    serverId: string | null;
    accountBinding: ServerCredentialAccountScopeBinding | null;
}>) {
    const { enabled, scope, sessionId, machineId, serverId, accountBinding } = params;
    const targetKey = enabled && machineId && accountBinding
        ? JSON.stringify([serverId, machineId, sessionId, scope, accountBinding.accountId, accountBinding.revision]) : null;
    const [state, setState] = React.useState<Readonly<{ targetKey: string; result: InventoryState }> | null>(null);
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    const projection = React.useMemo(() => targetKey && machineId
        ? captureMachineContributionRegistryProjectionScope({ serverId, machineId }) : null,
    [targetKey, serverId, machineId]);
    const subscribeProjection = React.useCallback((listener: () => void) => projection?.subscribe(listener) ?? (() => {}), [projection]);
    const readProjectionRevision = React.useCallback(() => projection?.readRevision() ?? 0, [projection]);
    const projectionRevision = React.useSyncExternalStore(subscribeProjection, readProjectionRevision, readProjectionRevision);
    React.useEffect(() => {
        if (!targetKey || !accountBinding) return;
        const controller = new AbortController();
        const retirement = accountBinding.onRetire(() => {
            controller.abort();
            setState(null);
        });
        setState({ targetKey, result: { status: 'loading' } });
        void listReviewEngines({ scope, includeDisabled: true, sessionId, machineId, serverId, expectedAccountId: accountBinding.accountId, signal: controller.signal }).then(result => {
            if (controller.signal.aborted) return;
            setState({ targetKey, result: result.ok ? { status: 'ready', inventory: result.inventory }
                : { status: 'error', error: result.error, failure: readActionFailureEnvelope(result) ?? undefined } });
        }, cause => {
            if (controller.signal.aborted) return;
            const failure = { ok: false as const, ...normalizeActionExecutorThrownError(cause, 'review.engines.list') };
            setState({ targetKey, result: { status: 'error', error: failure.error, failure } });
        });
        return () => {
            retirement?.dispose();
            controller.abort();
        };
    }, [accountBinding, machineId, projectionRevision, revision, scope, serverId, sessionId, targetKey]);
    const result: InventoryState = state && state.targetKey === targetKey ? state.result
        : { status: enabled ? 'loading' : 'idle' };
    return { ...result, refresh };
}
