import type { ManagedConnectionState, ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';

import { storage } from '@/sync/domains/state/storage';
import type { PauseController } from '@/utils/timing/pauseController';

import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';

type EndpointConnectivityStateLike = Pick<
    ManagedConnectionState,
    'phase' | 'reason' | 'attempt' | 'nextRetryAt' | 'lastConnectedAt' | 'lastDisconnectedAt' | 'lastErrorMessage'
>;

type EndpointConnectivityStateSubscription = (listener: (state: EndpointConnectivityStateLike) => void) => () => void;

export function applyEndpointConnectivityStateToRealtimeStore(state: EndpointConnectivityStateLike): void {
    storage.getState().setEndpointConnectivity({
        status: state.phase,
        reason: state.reason,
        attempt: state.attempt,
        nextRetryAt: state.nextRetryAt,
        lastConnectedAt: state.lastConnectedAt,
        lastDisconnectedAt: state.lastDisconnectedAt,
        lastErrorMessage: sanitizeEndpointErrorMessage(state.lastErrorMessage),
    });
}

export function bindEndpointConnectivityStateToRealtimeStore(params: Readonly<{
    subscribe: EndpointConnectivityStateSubscription;
    pause?: PauseController;
    onEndpointOnline?: () => void;
}>): () => void {
    const pause = params.pause;
    const onEndpointOnline = params.onEndpointOnline;
    let sawOfflineLike = false;

    return params.subscribe((state) => {
        if (pause) {
            if (state.phase === 'online') {
                pause.resume();
            } else {
                pause.pause();
            }
        }
        if (state.phase === 'offline' || state.phase === 'auth_failed' || state.phase === 'shutting_down') {
            sawOfflineLike = true;
        } else if (state.phase === 'online' && sawOfflineLike) {
            sawOfflineLike = false;
            try {
                onEndpointOnline?.();
            } catch {
                // ignore
            }
        }
        applyEndpointConnectivityStateToRealtimeStore(state);
    });
}

export function bindEndpointSupervisorToRealtimeStore(params: Readonly<{
    supervisor: ManagedEndpointSupervisor;
    pause?: PauseController;
    pauseReason?: string;
    onEndpointOnline?: () => void;
}>): () => void {
    return bindEndpointConnectivityStateToRealtimeStore({
        subscribe: (listener) => params.supervisor.subscribe(listener),
        pause: params.pause,
        onEndpointOnline: params.onEndpointOnline,
    });
}
