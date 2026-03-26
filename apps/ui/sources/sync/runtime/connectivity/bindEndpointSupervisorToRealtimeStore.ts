import type { ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';

import { storage } from '@/sync/domains/state/storage';
import type { PauseController } from '@/utils/timing/pauseController';

import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';

export function bindEndpointSupervisorToRealtimeStore(params: Readonly<{
    supervisor: ManagedEndpointSupervisor;
    pause?: PauseController;
    pauseReason?: string;
    onEndpointOnline?: () => void;
}>): () => void {
    const pause = params.pause;
    const onEndpointOnline = params.onEndpointOnline;
    let sawOfflineLike = false;

    return params.supervisor.subscribe((state) => {
        const lastErrorMessage = sanitizeEndpointErrorMessage(state.lastErrorMessage);
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
        storage.getState().setEndpointConnectivity({
            status: state.phase,
            reason: state.reason,
            attempt: state.attempt,
            nextRetryAt: state.nextRetryAt,
            lastConnectedAt: state.lastConnectedAt,
            lastDisconnectedAt: state.lastDisconnectedAt,
            lastErrorMessage,
        });
    });
}
