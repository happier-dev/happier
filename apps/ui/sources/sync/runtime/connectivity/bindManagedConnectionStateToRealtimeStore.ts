import { isRetryOfKnownFailure, type ManagedConnectionState } from '@happier-dev/connection-supervisor';

import { storage } from '@/sync/domains/state/storage';
import type { EndpointConnectivitySnapshot, EndpointConnectivityStatus } from '@/sync/store/domains/realtime';
import type { PauseController } from '@/utils/timing/pauseController';

import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';
import { log } from '@/log';

type EndpointConnectivityStateLike = Pick<
    ManagedConnectionState,
    'phase' | 'reason' | 'attempt' | 'nextRetryAt' | 'lastConnectedAt' | 'lastDisconnectedAt' | 'lastErrorMessage'
>;

type EndpointConnectivityStateSubscription = (listener: (state: EndpointConnectivityStateLike) => void) => () => void;

/**
 * `shutting_down` is the supervisor's own teardown phase: it is published whenever WE stop supervision —
 * backgrounding, a server switch, or the stop/start pair inside an explicit invalidation. It is never evidence
 * about the server, so it must not reach the user-visible connection state, where `resolveConnectionHealth`
 * would render it as a red "Disconnected" on every resume. A teardown therefore publishes no new claim: an
 * already-diagnosed problem (offline / auth_failed) stays visible, and anything else becomes `connecting`, which
 * is what the app is actually doing next.
 */
function resolveEndpointConnectivityStatus(
    phase: EndpointConnectivityStateLike['phase'],
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

function isOfflineLikeConnectivityState(state: EndpointConnectivityStateLike): boolean {
    return state.phase === 'offline' || state.phase === 'auth_failed' || state.phase === 'shutting_down';
}

export function bindEndpointConnectivityStateToRealtimeStore(params: Readonly<{
    subscribe: EndpointConnectivityStateSubscription;
    pause?: PauseController;
    onEndpointOnline?: () => void;
}>): () => void {
    const pause = params.pause;
    const onEndpointOnline = params.onEndpointOnline;
    let sawOfflineLike = false;
    let publishedStatus: EndpointConnectivityStatus | null = null;
    let onlineRetained = false;

    return params.subscribe((state) => {
        if (pause) {
            if (state.phase === 'online') {
                pause.resume();
            } else {
                pause.pause();
            }
        }
        if (isOfflineLikeConnectivityState(state)) {
            sawOfflineLike = true;
        } else if (state.phase === 'online' && sawOfflineLike) {
            sawOfflineLike = false;
            try {
                onEndpointOnline?.();
            } catch (error) {
                // Store updates must continue; the failed listener stays visible.
                log.log(`[connectivity] endpoint-online listener failed reason=${error instanceof Error ? error.name : typeof error}`);
            }
        }

        // A timer-driven retry of an outage already shown is not news; its outcome is the next publication.
        if (isRetryOfKnownFailure(state, publishedStatus === 'offline')) return;

        // Our own teardown and its restart carry no evidence, so the last verdict (online) stands until the next one.
        onlineRetained = state.phase === 'shutting_down' ? publishedStatus === 'online' || onlineRetained
            : state.phase === 'connecting' && onlineRetained;
        const snapshot: EndpointConnectivitySnapshot = {
            status: resolveEndpointConnectivityStatus(state.phase, publishedStatus),
            onlineRetained,
            reason: state.reason,
            attempt: state.attempt,
            nextRetryAt: state.nextRetryAt,
            lastConnectedAt: state.lastConnectedAt,
            lastDisconnectedAt: state.lastDisconnectedAt,
            lastErrorMessage: sanitizeEndpointErrorMessage(state.lastErrorMessage),
        };
        publishedStatus = snapshot.status;
        storage.getState().setEndpointConnectivity(snapshot);
    });
}
