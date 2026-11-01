import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

import type { EndpointConnectivitySnapshot, EndpointConnectivityStatus } from '@/sync/store/domains/realtime';
import type { PauseController } from '@/utils/timing/pauseController';

import { isRetryOfKnownFailure } from './isRetryOfKnownFailure';
import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';

export type ManagedConnectionStateSubscription = (
    listener: (state: ManagedConnectionState) => void,
) => () => void;

/**
 * `shutting_down` is the supervisor's own teardown phase: it is published whenever WE stop supervision —
 * backgrounding, a server switch, or the stop/start pair inside an explicit invalidation. It is never
 * evidence about the server, so it must not reach the user-visible connection state, where it would render
 * as "Disconnected" on every resume. A teardown therefore publishes no new claim: an already-diagnosed
 * problem (offline / auth_failed) stays visible, and anything else becomes `connecting`, which is what the
 * app is actually doing next.
 */
function resolveEndpointConnectivityStatus(
    phase: ManagedConnectionState['phase'],
    previous: EndpointConnectivityStatus | null,
): EndpointConnectivityStatus {
    if (phase !== 'shutting_down') {
        return phase;
    }
    if (previous === 'offline' || previous === 'auth_failed') {
        return previous;
    }
    return 'connecting';
}

function mapManagedConnectionStateToEndpointConnectivitySnapshot(
    state: ManagedConnectionState,
    previousStatus: EndpointConnectivityStatus | null,
): EndpointConnectivitySnapshot {
    return {
        status: resolveEndpointConnectivityStatus(state.phase, previousStatus),
        reason: state.reason,
        attempt: state.attempt,
        nextRetryAt: state.nextRetryAt,
        lastConnectedAt: state.lastConnectedAt,
        lastDisconnectedAt: state.lastDisconnectedAt,
        lastErrorMessage: sanitizeEndpointErrorMessage(state.lastErrorMessage),
    };
}

function isOfflineLikeManagedConnectionState(state: ManagedConnectionState): boolean {
    return state.phase === 'offline' || state.phase === 'auth_failed' || state.phase === 'shutting_down';
}

export function bindManagedConnectionStateToRealtimeStore(params: Readonly<{
    subscribe: ManagedConnectionStateSubscription;
    setEndpointConnectivity: (snapshot: EndpointConnectivitySnapshot) => void;
    pause?: PauseController;
    onOnline?: () => void;
}>): () => void {
    const pause = params.pause;
    const onOnline = params.onOnline;
    let sawOfflineLike = false;
    let publishedStatus: EndpointConnectivityStatus | null = null;

    return params.subscribe((state) => {
        if (pause) {
            if (state.phase === 'online') {
                pause.resume();
            } else {
                pause.pause();
            }
        }

        if (isOfflineLikeManagedConnectionState(state)) {
            sawOfflineLike = true;
        } else if (state.phase === 'online' && sawOfflineLike) {
            sawOfflineLike = false;
            try {
                onOnline?.();
            } catch {
                // ignore listener failures; store updates must continue
            }
        }

        if (isRetryOfKnownFailure(state, publishedStatus === 'offline')) {
            return;
        }

        const snapshot = mapManagedConnectionStateToEndpointConnectivitySnapshot(state, publishedStatus);
        publishedStatus = snapshot.status;
        params.setEndpointConnectivity(snapshot);
    });
}
