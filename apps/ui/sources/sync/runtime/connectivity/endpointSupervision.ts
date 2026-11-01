import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState, ManagedProbeReportScope, ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { HappyError } from '@/utils/errors/errors';

import { buildRetryLaterProbeResultFromResponse, parseRetryAfterMs, readRetryLaterReason } from './retryLaterProbeResult';

export function shouldReportEndpointFailure(params: { init?: RequestInit; error: unknown }): boolean {
    if (params.init?.signal?.aborted) return false;
    return !(params.error instanceof Error && params.error.name === 'AbortError');
}

function readInitialSettleTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_ENDPOINT_SUPERVISOR_INITIAL_SETTLE_TIMEOUT_MS ?? '').trim();
    if (!raw) return 250;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 250;
    return Math.max(0, Math.min(5_000, parsed));
}

export async function waitForEndpointSupervisorToSettle(
    supervisor: ManagedEndpointSupervisor,
): Promise<ManagedEndpointSupervisorState> {
    const current = supervisor.getState();
    if (current.phase !== 'connecting' || current.lastProbe) return current;

    const timeoutMs = readInitialSettleTimeoutMs();
    if (timeoutMs <= 0) return current;

    return await new Promise<ManagedEndpointSupervisorState>((resolve) => {
        const timeoutId = setTimeout(() => {
            unsubscribe();
            resolve(supervisor.getState());
        }, timeoutMs);

        const unsubscribe = supervisor.subscribe((state) => {
            if (state.phase === 'connecting' && !state.lastProbe) {
                return;
            }
            clearTimeout(timeoutId);
            unsubscribe();
            resolve(state);
        });
    });
}

export function assertEndpointOnlineOrThrow(state: ManagedEndpointSupervisorState): void {
    if (state.phase === 'auth_failed') {
        throw new HappyError('Authentication required', false, { kind: 'auth', code: 'endpoint_auth_failed' });
    }
    if (state.phase !== 'online') {
        throw new HappyError('Server is currently unreachable', true, { kind: 'network', code: 'endpoint_offline' });
    }
}

export function assertEndpointReadyForRequestOrThrow(
    state: ManagedEndpointSupervisorState,
    opts?: Readonly<{
        requireAuth?: boolean;
    }>,
): void {
    const requireAuth = opts?.requireAuth !== false;
    if (state.phase === 'auth_failed') {
        if (requireAuth) {
            throw new HappyError('Authentication required', false, { kind: 'auth', code: 'endpoint_auth_failed' });
        }
        return;
    }
    if (state.phase !== 'online') {
        throw new HappyError('Server is currently unreachable', true, { kind: 'network', code: 'endpoint_offline' });
    }
}

export function classifyEndpointResponse(
    response: Response,
    hadAuth: boolean,
): Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>> | null {
    // Authentication middleware uses 401 for invalid credentials. Resource 403
    // and route-level 500/503 failures do not establish an endpoint outage.
    if (hadAuth && response.status === 401) {
        return { status: 'auth_failed', statusCode: 401, errorMessage: 'HTTP 401' };
    }
    if (response.status === 502 || response.status === 504 || (
        response.status === 503
        && (parseRetryAfterMs(response.headers) !== undefined || readRetryLaterReason(response.headers) === 'server_restarting')
    )) {
        return buildRetryLaterProbeResultFromResponse(response, `HTTP ${response.status}`);
    }
    return null;
}

export function reportEndpointResponseToSupervisor(
    supervisor: ManagedEndpointSupervisor,
    response: Response,
    hadAuth: boolean,
    probeReportScope: ManagedProbeReportScope | undefined,
): void {
    const probe = classifyEndpointResponse(response, hadAuth);
    if (!probe) return;
    if (supervisor.reportProbeResult) {
        supervisor.reportProbeResult(probe, probeReportScope);
    } else if (probe.status === 'auth_failed') {
        supervisor.invalidate();
    } else {
        supervisor.reportFailure({ errorMessage: probe.errorMessage });
    }
}
