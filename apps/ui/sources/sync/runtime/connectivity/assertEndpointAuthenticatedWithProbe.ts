import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';

import { acquireEndpointSupervisor, getEndpointSupervisorForServer } from '@/sync/runtime/connectivity/endpointSupervisorPool';

import { createNotAuthenticatedError } from './authErrors';
import { assertServerReachabilityAuthenticated } from './serverReachabilitySupervisorPool';

const STATIC_EXPO_PUBLIC_HAPPIER_USER_SEND_NO_ACK_AUTH_PROBE_TIMEOUT_MS =
    process.env.EXPO_PUBLIC_HAPPIER_USER_SEND_NO_ACK_AUTH_PROBE_TIMEOUT_MS;

function readEndpointAuthProbeTimeoutMs(): number {
    const raw = String(STATIC_EXPO_PUBLIC_HAPPIER_USER_SEND_NO_ACK_AUTH_PROBE_TIMEOUT_MS ?? '').trim();
    if (!raw) return 750;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 750;
    return Math.max(0, Math.min(5_000, parsed));
}

async function waitForEndpointProbeToSettle(
    supervisor: ManagedEndpointSupervisor,
    timeoutMs: number,
): Promise<ManagedEndpointSupervisorState> {
    const current = supervisor.getState();
    if (current.phase !== 'connecting' || timeoutMs <= 0) {
        return current;
    }

    return await new Promise<ManagedEndpointSupervisorState>((resolve) => {
        let unsubscribe: (() => void) | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let cleanupBeforeSubscribeReturned = false;
        const cleanup = (): void => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
                return;
            }
            cleanupBeforeSubscribeReturned = true;
        };

        timeout = setTimeout(() => {
            cleanup();
            resolve(supervisor.getState());
        }, Math.max(0, timeoutMs));

        unsubscribe = supervisor.subscribe((state) => {
            if (state.phase === 'connecting') {
                return;
            }
            cleanup();
            resolve(state);
        });
        if (cleanupBeforeSubscribeReturned && unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
    });
}

export async function assertEndpointAuthenticatedWithProbe(params: Readonly<{
    serverId: string;
    serverUrl: string;
    forceProbe?: boolean;
    timeoutMs?: number;
}>): Promise<void> {
    const serverId = String(params.serverId ?? '').trim();
    const serverUrl = String(params.serverUrl ?? '').trim();
    if (!serverId || !serverUrl) {
        return;
    }

    assertServerReachabilityAuthenticated(serverUrl);

    const existingSupervisor = getEndpointSupervisorForServer({ serverId, serverUrl });
    if (existingSupervisor?.getState().phase === 'auth_failed') {
        throw createNotAuthenticatedError();
    }
    if (params.forceProbe !== true) {
        return;
    }

    const acquiredHandle = existingSupervisor
        ? null
        : await acquireEndpointSupervisor({ serverId, endpoint: serverUrl });
    const supervisor = existingSupervisor ?? acquiredHandle!.supervisor;

    try {
        const current = supervisor.getState();
        if (current.phase === 'auth_failed') {
            throw createNotAuthenticatedError();
        }
        if (current.phase === 'online') {
            supervisor.invalidate();
            const next = await waitForEndpointProbeToSettle(
                supervisor,
                typeof params.timeoutMs === 'number' ? params.timeoutMs : readEndpointAuthProbeTimeoutMs(),
            );
            if (next.phase === 'auth_failed') {
                throw createNotAuthenticatedError();
            }
            return;
        }
        if (current.phase === 'connecting') {
            const next = await waitForEndpointProbeToSettle(
                supervisor,
                typeof params.timeoutMs === 'number' ? params.timeoutMs : readEndpointAuthProbeTimeoutMs(),
            );
            if (next.phase === 'auth_failed') {
                throw createNotAuthenticatedError();
            }
        }
    } finally {
        await acquiredHandle?.release().catch(() => {});
    }
}
