import * as React from 'react';
import { Platform } from 'react-native';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    reduceUiDeploymentFreshness,
    type UiDeploymentFreshnessState,
} from './uiDeploymentFreshness';

const INITIAL_STATE: UiDeploymentFreshnessState = {
    baselineId: null,
    updateAvailable: false,
};

async function fetchCurrentUiDeploymentId(): Promise<unknown> {
    const response = await globalThis.fetch('/.well-known/happier-ui-deployment', {
        cache: 'no-store',
        credentials: 'same-origin',
    });
    if (!response.ok || response.status === 204) return null;
    const payload = await response.json() as { deploymentId?: unknown };
    return payload?.deploymentId;
}

export function useWebUiDeploymentFreshness(): Readonly<{
    updateAvailable: boolean;
    reload: () => void;
}> {
    const [state, setState] = React.useState<UiDeploymentFreshnessState>(INITIAL_STATE);

    const check = React.useCallback(async () => {
        if (Platform.OS !== 'web' || typeof globalThis.fetch !== 'function') return;
        try {
            const observedId = await fetchCurrentUiDeploymentId();
            setState((current) => reduceUiDeploymentFreshness(current, observedId));
        } catch {
            // Missing, malformed, and temporarily unavailable identities are intentionally silent.
        }
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        void check();
        const unsubscribeReconnect = apiSocket.onReconnected(() => {
            void check();
        });
        const doc = (globalThis as { document?: Document }).document;
        const onVisibilityChange = () => {
            if (!doc || doc.visibilityState === 'visible') void check();
        };
        doc?.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            unsubscribeReconnect();
            doc?.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [check]);

    const reload = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        (globalThis as { location?: { reload?: () => void } }).location?.reload?.();
    }, []);

    return { updateAvailable: state.updateAvailable, reload };
}
