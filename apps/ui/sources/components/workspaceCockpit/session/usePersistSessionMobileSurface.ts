import * as React from 'react';

import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';

import type { SessionMobileSurface } from './sessionCockpitState';

export function usePersistSessionMobileSurface(params: Readonly<{
    sessionId: string | null;
    surface: SessionMobileSurface | null;
    enabled?: boolean;
}>): void {
    const lastMobileSurfaceBySessionId = useLocalSetting('sessionLastMobileSurfaceBySessionId');
    const [, setLastMobileSurfaceBySessionId] = useLocalSettingMutable('sessionLastMobileSurfaceBySessionId');

    React.useEffect(() => {
        if (params.enabled === false) return;
        if (!params.sessionId || !params.surface) return;
        if (lastMobileSurfaceBySessionId?.[params.sessionId] === params.surface) return;

        setLastMobileSurfaceBySessionId({
            ...(lastMobileSurfaceBySessionId ?? {}),
            [params.sessionId]: params.surface,
        });
    }, [
        lastMobileSurfaceBySessionId,
        params.enabled,
        params.sessionId,
        params.surface,
        setLastMobileSurfaceBySessionId,
    ]);
}
