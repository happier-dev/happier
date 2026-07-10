import type {
    ConnectionRuntimeServiceV1,
    ConnectionStateV1,
} from '@happier-dev/plugin-sdk';
import { logger } from '@/ui/logger';
import {
    readPluginDaemonConnectionStateSource,
    type PluginDaemonConnectionStateSource,
} from '../../pluginConnectionStateSource';
import { isRecord } from './values';

const IDLE_DAEMON_CONNECTION_STATE: ConnectionStateV1 = Object.freeze({
    phase: 'idle',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
});

function readNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readConnectionPhase(value: unknown): ConnectionStateV1['phase'] {
    switch (value) {
        case 'idle':
        case 'connecting':
        case 'online':
        case 'offline':
        case 'auth_failed':
        case 'shutting_down':
            return value;
        default:
            return 'idle';
    }
}

function projectConnectionStateV1(state: unknown): ConnectionStateV1 {
    if (!isRecord(state)) {
        return IDLE_DAEMON_CONNECTION_STATE;
    }
    const projected = {
        phase: readConnectionPhase(state.phase),
        reason: typeof state.reason === 'string' ? state.reason : null,
        attempt: typeof state.attempt === 'number' && Number.isFinite(state.attempt) ? state.attempt : 0,
        nextRetryAt: readNumberOrNull(state.nextRetryAt),
        lastConnectedAt: readNumberOrNull(state.lastConnectedAt),
        lastDisconnectedAt: readNumberOrNull(state.lastDisconnectedAt),
        lastErrorMessage: typeof state.lastErrorMessage === 'string' ? state.lastErrorMessage : null,
    } satisfies ConnectionStateV1;
    return Object.freeze(projected);
}

function createIdleConnectionStateSource(): PluginDaemonConnectionStateSource {
    return Object.freeze({
        onConnectionStateChange(listener: (state: unknown) => void) {
            listener(IDLE_DAEMON_CONNECTION_STATE);
            return () => undefined;
        },
    });
}

export function createConnectionRuntimeService(params?: Readonly<{
    source?: PluginDaemonConnectionStateSource | null;
}>): ConnectionRuntimeServiceV1 {
    const resolveSource = (): PluginDaemonConnectionStateSource => (
        params?.source
        ?? readPluginDaemonConnectionStateSource()
        ?? createIdleConnectionStateSource()
    );
    const readCurrentState = (): ConnectionStateV1 => {
        let current = IDLE_DAEMON_CONNECTION_STATE;
        const source = resolveSource();
        const unsubscribe = source.onConnectionStateChange((state) => {
            current = projectConnectionStateV1(state);
        });
        unsubscribe();
        return current;
    };

    const service: ConnectionRuntimeServiceV1 = Object.freeze({
        getDaemonLinkState: readCurrentState,
        watchDaemonLink(listener: Parameters<ConnectionRuntimeServiceV1['watchDaemonLink']>[0]) {
            let unsubscribed = false;
            const source = resolveSource();
            const unsubscribeSource = source.onConnectionStateChange((state) => {
                if (unsubscribed) {
                    return;
                }
                const projected = projectConnectionStateV1(state);
                try {
                    listener(projected);
                } catch (error) {
                    logger.warn('[PluginContextV1] ctx.connection watcher failed (ignored)', {
                        error,
                    });
                }
            });
            return Object.freeze({
                unsubscribe: () => {
                    if (unsubscribed) {
                        return;
                    }
                    unsubscribed = true;
                    unsubscribeSource();
                },
            });
        },
        isDaemonOnline: () => readCurrentState().phase === 'online',
    });
    return service;
}
