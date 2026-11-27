import * as React from 'react';
import type { HomeAccountDetailV1 } from '@happier-dev/protocol/home/governance';

import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { homeAccountDetailRead } from '@/sync/engine/home/governance/homeAdministrationReads';
import { useHomeAdministrationRead } from './useHomeAdministrationRead';

export type HomeAccountDetailState = Readonly<{
    /** Last detail, retained through transient refresh failures; withdrawn on authoritative denial/missing. */
    detail: HomeAccountDetailV1 | null;
    status: 'loading' | 'ready' | 'error';
    error: HomeDomainFailure | null;
    reload: () => void;
}>;

/** Reads the target person through the exact viewer scope's retained administration snapshot. */
export function useHomeAccountDetail(
    scope: ServerAccountScope | null,
    targetAccountId: string,
    enabled: boolean,
): HomeAccountDetailState {
    const { snapshot, refresh } = useHomeAdministrationRead(
        homeAccountDetailRead, enabled && targetAccountId ? scope : null, targetAccountId,
    );
    return React.useMemo(() => ({
        detail: snapshot?.data ?? null,
        status: snapshot?.failure ? 'error' : snapshot?.data ? 'ready' : 'loading',
        error: snapshot?.failure ?? null,
        reload: refresh,
    }), [snapshot, refresh]);
}
