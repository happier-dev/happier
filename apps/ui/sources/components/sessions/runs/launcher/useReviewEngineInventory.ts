import * as React from 'react';
import type { ReviewEngineInventory } from '@happier-dev/protocol/reviews/reviewEngines';

import { listReviewEngines } from '@/sync/ops/reviews/reviewWalkthrough';
import { t } from '@/text';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

type InventoryState =
    | Readonly<{ status: 'idle' | 'loading' }>
    | Readonly<{ status: 'ready'; inventory: ReviewEngineInventory }>
    | Readonly<{ status: 'error'; error: string }>;

/** Subscribe only while editing a Review draft; a changed target retires the previous read. */
export function useReviewEngineInventory(params: Readonly<{
    enabled: boolean;
    sessionId: string | null;
    machineId?: string;
    serverId: string | null;
    accountBinding: ServerCredentialAccountScopeBinding | null;
}>) {
    const { enabled, sessionId, machineId, serverId, accountBinding } = params;
    const targetKey = enabled && machineId && accountBinding
        ? JSON.stringify([serverId, machineId, sessionId, accountBinding.accountId, accountBinding.revision]) : null;
    const [state, setState] = React.useState<Readonly<{ targetKey: string; result: InventoryState }> | null>(null);
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!targetKey || !accountBinding) return;
        const controller = new AbortController();
        const retirement = accountBinding.onRetire(() => {
            controller.abort();
            setState(null);
        });
        setState({ targetKey, result: { status: 'loading' } });
        void listReviewEngines({ sessionId, machineId, serverId, expectedAccountId: accountBinding.accountId, signal: controller.signal }).then(result => {
            if (controller.signal.aborted) return;
            setState({ targetKey, result: result.ok ? { status: 'ready', inventory: result.inventory }
                : { status: 'error', error: result.error } });
        }, () => {
            if (!controller.signal.aborted) setState({ targetKey, result: { status: 'error', error: t('common.unavailable') } });
        });
        return () => {
            retirement?.dispose();
            controller.abort();
        };
    }, [accountBinding, machineId, revision, serverId, sessionId, targetKey]);
    const result: InventoryState = state && state.targetKey === targetKey ? state.result
        : { status: enabled ? 'loading' : 'idle' };
    return { ...result, refresh };
}
