import {
    FeaturesResponseSchema,
    PENDING_INPUT_PROTOCOL_VERSION_V1,
    SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
    SessionSyncPendingInputCompatibilityPingAckV1Schema,
} from '@happier-dev/protocol';
import { normalizeBaseUrl } from '@/diagnostics/httpClient';

export type SessionSyncPendingInputServerContractMode =
    | 'session_sync_v2_pending_input_v1'
    | 'released_server_v0_2_1'
    | 'indeterminate'
    | 'auth_failed';

type ProbeSocket = Readonly<{ connected?: boolean }>;
type PingAckEmitter = Readonly<{
    timeout?: (ms: number) => PingAckEmitter;
    emitWithAck: (event: 'ping') => Promise<unknown>;
}>;
type EpochProbe = Readonly<{
    sessionConnectionEpoch: number;
    socket: ProbeSocket;
    machineId: string | null | undefined;
}>;

export type SessionSyncPendingInputServerContractResult = Readonly<{
    mode: SessionSyncPendingInputServerContractMode;
    sessionConnectionEpoch: number;
    socket: ProbeSocket;
}>;

export type SessionSyncPendingInputHttpContractShape =
    | 'current_or_later_compatible'
    | 'v0_2_1_legacy_contract_shape'
    | 'indeterminate';

export function classifySessionSyncPendingInputHttpContractShape(
    payload: unknown,
): SessionSyncPendingInputHttpContractShape {
    const parsed = FeaturesResponseSchema.safeParse(payload);
    if (!parsed.success) return 'indeterminate';

    const compatibility = parsed.data.capabilities.compatibility;
    const sessionSyncVersion = compatibility?.sessionSync.currentSessionSyncProtocolVersion;
    const pendingInputVersion = compatibility?.pendingInput?.currentPendingInputProtocolVersion;
    if (
        sessionSyncVersion !== undefined
        && sessionSyncVersion >= SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY
        && pendingInputVersion !== undefined
        && pendingInputVersion >= PENDING_INPUT_PROTOCOL_VERSION_V1
    ) {
        return 'current_or_later_compatible';
    }

    if (
        compatibility === undefined
        && parsed.data.features.sharing.pendingQueueV2.enabled === true
        && parsed.data.features.sharing.pendingDeliveryState.enabled !== true
    ) {
        return 'v0_2_1_legacy_contract_shape';
    }

    return 'indeterminate';
}

function isExactReleasedServerPingAck(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) && Object.keys(value).length === 0;
}

export function createSessionSyncPendingInputServerContractController(options: Readonly<{
    serverUrl: string;
    token: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}>) {
    const timeoutMs = options.timeoutMs ?? 6_000;
    const fetchImpl = options.fetchImpl ?? fetch;
    let active: {
        readonly sessionConnectionEpoch: number;
        readonly socket: ProbeSocket;
        promise: Promise<SessionSyncPendingInputServerContractResult> | null;
    } | null = null;

    const answer = (
        probe: EpochProbe,
        mode: SessionSyncPendingInputServerContractMode,
    ): SessionSyncPendingInputServerContractResult => ({
        mode,
        sessionConnectionEpoch: probe.sessionConnectionEpoch,
        socket: probe.socket,
    });
    const isCurrentAttempt = (attempt: NonNullable<typeof active>) => active === attempt;

    async function run(
        probe: EpochProbe,
        attempt: NonNullable<typeof active>,
    ): Promise<SessionSyncPendingInputServerContractResult> {
        if (!probe.machineId?.trim() || probe.socket.connected !== true) {
            return answer(probe, 'indeterminate');
        }

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        timer.unref?.();
        let response: Response;
        let payload: unknown;
        try {
            response = await fetchImpl(`${normalizeBaseUrl(options.serverUrl)}/v1/features`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${options.token}` },
                redirect: 'manual',
                signal: abort.signal,
            });
            if (!isCurrentAttempt(attempt) || probe.socket.connected !== true) {
                return answer(probe, 'indeterminate');
            }
            if (response.status === 401 || response.status === 403) {
                return answer(probe, 'auth_failed');
            }
            if (!response.ok) return answer(probe, 'indeterminate');
            payload = await response.json();
        } catch {
            return answer(probe, 'indeterminate');
        } finally {
            clearTimeout(timer);
        }
        if (!isCurrentAttempt(attempt) || probe.socket.connected !== true) {
            return answer(probe, 'indeterminate');
        }

        const httpContractShape = classifySessionSyncPendingInputHttpContractShape(payload);
        if (httpContractShape === 'indeterminate') return answer(probe, 'indeterminate');

        let rawAck: unknown;
        try {
            const emitter = probe.socket as PingAckEmitter;
            rawAck = await (emitter.timeout?.(timeoutMs) ?? emitter).emitWithAck('ping');
        } catch {
            return answer(probe, 'indeterminate');
        }
        if (!isCurrentAttempt(attempt) || probe.socket.connected !== true) {
            return answer(probe, 'indeterminate');
        }

        if (httpContractShape === 'v0_2_1_legacy_contract_shape') {
            return answer(
                probe,
                isExactReleasedServerPingAck(rawAck) ? 'released_server_v0_2_1' : 'indeterminate',
            );
        }

        const ack = SessionSyncPendingInputCompatibilityPingAckV1Schema.safeParse(rawAck);
        if (!ack.success) return answer(probe, 'indeterminate');
        const sessionSyncVersion = ack.data.compatibility.sessionSync.currentSessionSyncProtocolVersion;
        const pendingInputVersion = ack.data.compatibility.pendingInput?.currentPendingInputProtocolVersion;
        return answer(
            probe,
            sessionSyncVersion >= SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY
                && pendingInputVersion !== undefined
                && pendingInputVersion >= PENDING_INPUT_PROTOCOL_VERSION_V1
                ? 'session_sync_v2_pending_input_v1'
                : 'indeterminate',
        );
    }

    return {
        resolve(probe: EpochProbe): Promise<SessionSyncPendingInputServerContractResult> {
            if (probe.socket.connected !== true || !probe.machineId?.trim()) {
                active = null;
                return Promise.resolve(answer(probe, 'indeterminate'));
            }
            if (
                active?.sessionConnectionEpoch === probe.sessionConnectionEpoch
                && active.socket === probe.socket
                && active.promise
                && probe.socket.connected === true
                && Boolean(probe.machineId?.trim())
            ) {
                return active.promise;
            }
            const attempt: NonNullable<typeof active> = {
                sessionConnectionEpoch: probe.sessionConnectionEpoch,
                socket: probe.socket,
                promise: null,
            };
            const promise = run(probe, attempt).then((result) => {
                if (
                    result.mode === 'indeterminate'
                    && isCurrentAttempt(attempt)
                ) {
                    attempt.promise = null;
                }
                return result;
            });
            attempt.promise = promise;
            active = attempt;
            return promise;
        },
        invalidate(probe?: Readonly<{ sessionConnectionEpoch?: number; socket?: ProbeSocket }>): SessionSyncPendingInputServerContractResult | null {
            if (
                active
                &&
                probe?.sessionConnectionEpoch !== undefined
                && active.sessionConnectionEpoch !== probe.sessionConnectionEpoch
            ) return null;
            if (active && probe?.socket !== undefined && active.socket !== probe.socket) return null;
            const invalidated = active;
            active = null;
            const sessionConnectionEpoch = probe?.sessionConnectionEpoch ?? invalidated?.sessionConnectionEpoch;
            const socket = probe?.socket ?? invalidated?.socket;
            return sessionConnectionEpoch !== undefined && socket
                ? { mode: 'indeterminate', sessionConnectionEpoch, socket }
                : null;
        },
    };
}
