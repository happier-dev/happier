import * as React from 'react';
import type { HomeAccountDetailV1 } from '@happier-dev/protocol/home/governance';

import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getHomeAccount } from '@/sync/ops/home/homeGovernanceOperations';
import {
    isHomeAdministrationAccountChange,
    subscribeHomeAccountChange,
} from '@/sync/runtime/orchestration/homeAccountChange';

export type HomeAccountDetailState = Readonly<{
    /** Last detail, retained through transient refresh failures; withdrawn on authoritative denial/missing. */
    detail: HomeAccountDetailV1 | null;
    status: 'loading' | 'ready' | 'error';
    error: HomeDomainFailure | null;
    reload: () => void;
}>;

type State = Readonly<{
    detail: HomeAccountDetailV1 | null;
    status: HomeAccountDetailState['status'];
    error: HomeDomainFailure | null;
}>;

const INITIAL: State = Object.freeze({ detail: null, status: 'loading' as const, error: null });

/**
 * One person as Home administration sees them, read in one request (`home.accounts.get`).
 *
 * It re-reads when the caller asks and when the Home wakes its administrators (a role, status or
 * policy change landed), and it keeps the last good answer on screen meanwhile. Answers for a
 * superseded Home, Account or person are dropped.
 */
export function useHomeAccountDetail(
    scope: ServerAccountScope | null,
    targetAccountId: string,
    enabled: boolean,
): HomeAccountDetailState {
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const [state, setState] = React.useState<State>(INITIAL);
    const generation = React.useRef(0);

    const load = React.useCallback((mode: 'reset' | 'refresh') => {
        if (!enabled || !serverId || !accountId || !targetAccountId) return;
        const current = (generation.current += 1);
        setState((previous) => (mode === 'reset'
            ? INITIAL
            : { ...previous, status: previous.detail ? previous.status : 'loading' }));
        void (async () => {
            const outcome = await getHomeAccount({ scope: { serverId, accountId }, accountId: targetAccountId });
            if (current !== generation.current) return;
            setState((previous) => (outcome.kind === 'failed'
                ? {
                    detail: outcome.failure.code === 'home_account_not_found'
                        || outcome.failure.kind === 'forbidden'
                        || outcome.failure.kind === 'unauthorized'
                        ? null : previous.detail,
                    status: 'error',
                    error: outcome.failure,
                }
                : { detail: outcome.value, status: 'ready', error: null }));
        })();
    }, [enabled, serverId, accountId, targetAccountId]);

    React.useEffect(() => {
        if (!enabled || !serverId || !accountId || !targetAccountId) {
            generation.current += 1;
            setState(INITIAL);
            return;
        }
        load('reset');
    }, [enabled, serverId, accountId, targetAccountId, load]);

    React.useEffect(() => {
        if (!enabled || !serverId || !accountId) return;
        return subscribeHomeAccountChange((event) => {
            if (event.serverId === serverId && isHomeAdministrationAccountChange(event)) load('refresh');
        });
    }, [enabled, serverId, accountId, load]);

    const reload = React.useCallback(() => { load('refresh'); }, [load]);

    return React.useMemo(() => Object.freeze({
        detail: state.detail,
        status: state.status,
        error: state.error,
        reload,
    }), [state, reload]);
}
