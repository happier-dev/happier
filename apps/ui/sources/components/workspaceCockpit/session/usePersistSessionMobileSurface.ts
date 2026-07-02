import * as React from 'react';

import { usePersistSessionLastMobileSurface } from '@/sync/domains/state/storage';

import type { SessionMobileSurface } from './sessionCockpitState';

export function usePersistSessionMobileSurface(params: Readonly<{
    sessionId: string | null;
    surface: SessionMobileSurface | null;
    enabled?: boolean;
}>): void {
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();

    React.useEffect(() => {
        if (params.enabled === false) return;
        if (!params.sessionId || !params.surface) return;
        persistSessionLastMobileSurface(params.sessionId, params.surface);
    }, [
        params.enabled,
        params.sessionId,
        params.surface,
        persistSessionLastMobileSurface,
    ]);
}
