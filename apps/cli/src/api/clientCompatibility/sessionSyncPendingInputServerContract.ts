import {
    FeaturesResponseSchema,
    PENDING_INPUT_PROTOCOL_VERSION_V1,
    SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
} from '@happier-dev/protocol';

import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export type RuntimeActivityServerContract = 'v2' | 'legacy' | 'unsupported' | 'indeterminate';
export type PendingInputServerContract = 'v1' | 'released_server_v0_2_1' | 'unsupported' | 'indeterminate';

/**
 * Retained only as a compatibility projection for callers that have not yet
 * consumed the two independent capability fields. New decisions must use
 * `runtimeActivity` or `pendingInput` directly.
 */
export type SessionSyncPendingInputServerContractMode =
    | 'session_sync_v2_pending_input_v1'
    | 'released_server_v0_2_1'
    | 'indeterminate'
    | 'auth_failed';

const SESSION_SERVER_CAPABILITY_REQUEST_TIMEOUT_MS = 6_000;

export async function supportsPendingTerminalHandoffOnServer(params: { serverUrl: string; token: string }): Promise<boolean> {
    const snapshot = await observeServerFeaturesSnapshot({ ...params, timeoutMs: SESSION_SERVER_CAPABILITY_REQUEST_TIMEOUT_MS });
    return snapshot.status === 'ready' && snapshot.features.capabilities.session.pendingTerminalHandoff === true;
}

type ProbeSocket = Readonly<{ connected?: boolean }>;

export type SessionSyncPendingInputServerContractResult = Readonly<{
    mode: SessionSyncPendingInputServerContractMode;
    runtimeActivity: RuntimeActivityServerContract;
    pendingInput: PendingInputServerContract;
    sessionConnectionEpoch: number;
    socket: ProbeSocket;
}>;

type ContractProbe = Readonly<{
    sessionConnectionEpoch: number;
    socket: ProbeSocket;
    machineId: string | null | undefined;
}>;

type CapabilitySelection = Readonly<{
    runtimeActivity: RuntimeActivityServerContract;
    pendingInput: PendingInputServerContract;
}>;

const INDETERMINATE: CapabilitySelection = Object.freeze({
    runtimeActivity: 'indeterminate',
    pendingInput: 'indeterminate',
});

function isReleasedServerV021(features: ReturnType<typeof FeaturesResponseSchema.parse>): boolean {
    return features.capabilities.session.runtimeActivity === undefined
        && features.capabilities.session.pendingInput === undefined
        && features.features.sharing.pendingQueueV2.enabled === true
        && features.features.sharing.pendingDeliveryState.enabled !== true;
}

export function resolveSessionServerCapabilities(raw: unknown): CapabilitySelection {
    const parsed = FeaturesResponseSchema.safeParse(raw);
    if (!parsed.success) return INDETERMINATE;

    if (isReleasedServerV021(parsed.data)) {
        return {
            runtimeActivity: 'legacy',
            pendingInput: 'released_server_v0_2_1',
        };
    }

    const runtimeActivityVersion =
        parsed.data.capabilities.session.runtimeActivity?.protocolVersion;
    const pendingInputVersion =
        parsed.data.capabilities.session.pendingInput?.protocolVersion;
    return {
        runtimeActivity:
            typeof runtimeActivityVersion === 'number'
            && runtimeActivityVersion >= SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY
                ? 'v2'
                : 'unsupported',
        pendingInput:
            typeof pendingInputVersion === 'number'
            && pendingInputVersion >= PENDING_INPUT_PROTOCOL_VERSION_V1
                ? 'v1'
                : 'unsupported',
    };
}

function projectLegacyMode(
    selection: CapabilitySelection,
): SessionSyncPendingInputServerContractMode {
    if (
        selection.runtimeActivity === 'v2'
        && selection.pendingInput === 'v1'
    ) {
        return 'session_sync_v2_pending_input_v1';
    }
    if (
        selection.runtimeActivity === 'legacy'
        && selection.pendingInput === 'released_server_v0_2_1'
    ) {
        return 'released_server_v0_2_1';
    }
    return 'indeterminate';
}

export function supportsRuntimeActivityV2(
    result: SessionSyncPendingInputServerContractResult | null | undefined,
): boolean {
    return result?.runtimeActivity === 'v2';
}

export function supportsPendingInputV1(
    result: SessionSyncPendingInputServerContractResult | null | undefined,
): boolean {
    return result?.pendingInput === 'v1';
}

export function createSessionSyncPendingInputServerContractController(options: Readonly<{
    serverUrl: string;
    token: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}>) {
    const timeoutMs = options.timeoutMs ?? SESSION_SERVER_CAPABILITY_REQUEST_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl ?? fetch;
    let active: {
        readonly sessionConnectionEpoch: number;
        readonly socket: ProbeSocket;
        promise: Promise<SessionSyncPendingInputServerContractResult> | null;
    } | null = null;

    const result = (
        probe: ContractProbe,
        selection: CapabilitySelection,
        forcedMode?: 'auth_failed',
    ): SessionSyncPendingInputServerContractResult => ({
        mode: forcedMode ?? projectLegacyMode(selection),
        ...selection,
        sessionConnectionEpoch: probe.sessionConnectionEpoch,
        socket: probe.socket,
    });
    const isCurrent = (attempt: NonNullable<typeof active>): boolean => active === attempt;

    async function run(
        probe: ContractProbe,
        attempt: NonNullable<typeof active>,
    ): Promise<SessionSyncPendingInputServerContractResult> {
        if (!probe.machineId?.trim() || probe.socket.connected !== true) {
            return result(probe, INDETERMINATE);
        }

        try {
            const snapshot = await observeServerFeaturesSnapshot({
                serverUrl: options.serverUrl,
                token: options.token,
                timeoutMs,
                fetchImpl,
            });
            if (!isCurrent(attempt) || probe.socket.connected !== true) {
                return result(probe, INDETERMINATE);
            }
            if (
                snapshot.status === 'error'
                && (snapshot.httpStatus === 401 || snapshot.httpStatus === 403)
            ) {
                return result(probe, INDETERMINATE, 'auth_failed');
            }
            if (snapshot.status !== 'ready') return result(probe, INDETERMINATE);
            const selection = resolveSessionServerCapabilities(snapshot.features);
            if (!isCurrent(attempt) || probe.socket.connected !== true) {
                return result(probe, INDETERMINATE);
            }
            return result(probe, selection);
        } catch {
            return result(probe, INDETERMINATE);
        }
    }

    return {
        resolve(probe: ContractProbe): Promise<SessionSyncPendingInputServerContractResult> {
            if (!probe.machineId?.trim() || probe.socket.connected !== true) {
                active = null;
                return Promise.resolve(result(probe, INDETERMINATE));
            }
            if (
                active?.sessionConnectionEpoch === probe.sessionConnectionEpoch
                && active.socket === probe.socket
                && active.promise
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
                    active === attempt
                    && result.runtimeActivity === 'indeterminate'
                    && result.pendingInput === 'indeterminate'
                ) {
                    active = null;
                }
                return result;
            });
            attempt.promise = promise;
            active = attempt;
            return promise;
        },
        invalidate(probe?: Readonly<{
            sessionConnectionEpoch?: number;
            socket?: ProbeSocket;
        }>): SessionSyncPendingInputServerContractResult | null {
            if (
                active && probe?.sessionConnectionEpoch !== undefined
                && active.sessionConnectionEpoch !== probe.sessionConnectionEpoch
            ) return null;
            if (active && probe?.socket !== undefined && active.socket !== probe.socket) return null;
            const invalidated = active;
            active = null;
            const sessionConnectionEpoch = probe?.sessionConnectionEpoch ?? invalidated?.sessionConnectionEpoch;
            const socket = probe?.socket ?? invalidated?.socket;
            return sessionConnectionEpoch !== undefined && socket
                ? result({ sessionConnectionEpoch, socket, machineId: null }, INDETERMINATE)
                : null;
        },
    };
}
