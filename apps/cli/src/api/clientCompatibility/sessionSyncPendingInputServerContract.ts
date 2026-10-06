import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { PENDING_INPUT_PROTOCOL_VERSION_V1, PENDING_INPUT_PROTOCOL_VERSION_V3, SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY } from '@happier-dev/protocol/clientCompatibility/primitives';
import {
    observeServerFeaturesSnapshot,
    type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';

export type RuntimeActivityServerContract = 'v2' | 'legacy' | 'unsupported' | 'indeterminate';
export type PendingInputServerContract = 'v1' | 'released_server_v0_2_1' | 'unsupported' | 'indeterminate';
export type PublisherAuthorityServerContract = 'v1' | 'unsupported' | 'indeterminate';

export type SessionSyncPendingInputServerContractMode =
    | 'session_sync_v3_publisher_authority_check_v1'
    | 'session_sync_v2_pending_input_v1'
    | 'released_server_v0_2_1'
    | 'indeterminate'
    | 'auth_failed';

type ProbeSocket = Readonly<{ connected?: boolean }>;
type EpochProbe = Readonly<{
    sessionConnectionEpoch: number;
    socket: ProbeSocket;
    machineId: string | null | undefined;
}>;

export type SessionSyncPendingInputServerContractResult = Readonly<{
    mode: SessionSyncPendingInputServerContractMode;
    runtimeActivity: RuntimeActivityServerContract;
    pendingInput: PendingInputServerContract;
    pendingInputProtocolVersion?: number;
    publisherAuthority: PublisherAuthorityServerContract;
    sessionConnectionEpoch: number;
    socket: ProbeSocket;
}>;

type CapabilitySelection = Pick<
    SessionSyncPendingInputServerContractResult,
    'runtimeActivity' | 'pendingInput' | 'pendingInputProtocolVersion' | 'publisherAuthority'
>;

const INDETERMINATE: CapabilitySelection = Object.freeze({
    runtimeActivity: 'indeterminate',
    pendingInput: 'indeterminate',
    publisherAuthority: 'indeterminate',
});

/** The truthful target-admission leaf from the daemon-wide cached server snapshot. */
export function resolveMachineSessionInputAdmissionCapability(
    snapshot: CliServerFeaturesSnapshot | undefined,
): Readonly<{ protocolVersions: readonly [1] | readonly [1, 2] }> {
    return snapshot?.status === 'ready'
        && (snapshot.features.capabilities.session?.pendingInput?.protocolVersion ?? 0)
            >= PENDING_INPUT_PROTOCOL_VERSION_V3
        ? { protocolVersions: [1, 2] }
        : { protocolVersions: [1] };
}

function isReleasedServerV021(features: ReturnType<typeof FeaturesResponseSchema.parse>): boolean {
    return features.capabilities.session.runtimeActivity === undefined
        && features.capabilities.session.pendingInput === undefined
        && features.capabilities.session.publisherAuthority === undefined
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
            publisherAuthority: 'unsupported',
        };
    }
    const session = parsed.data.capabilities.session;
    return {
        ...(session.pendingInput ? { pendingInputProtocolVersion: session.pendingInput.protocolVersion } : {}),
        runtimeActivity:
            (session.runtimeActivity?.protocolVersion ?? 0)
                >= SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY
                ? 'v2'
                : 'unsupported',
        pendingInput:
            (session.pendingInput?.protocolVersion ?? 0)
                >= PENDING_INPUT_PROTOCOL_VERSION_V1
                ? 'v1'
                : 'unsupported',
        publisherAuthority:
            (session.publisherAuthority?.protocolVersion ?? 0) >= 1
                ? 'v1'
                : 'unsupported',
    };
}

function projectMode(selection: CapabilitySelection): SessionSyncPendingInputServerContractMode {
    if (selection.publisherAuthority === 'v1') {
        return 'session_sync_v3_publisher_authority_check_v1';
    }
    if (selection.runtimeActivity === 'v2' && selection.pendingInput === 'v1') {
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

export function supportsSessionSyncPendingInputV1(
    contract: SessionSyncPendingInputServerContractResult | null | undefined,
): boolean {
    return contract?.pendingInput === 'v1';
}

export function supportsSessionPublisherAuthorityCheckV1(
    contract: SessionSyncPendingInputServerContractResult | null | undefined,
): boolean {
    return contract?.publisherAuthority === 'v1';
}

export function supportsRuntimeActivityV2(
    contract: SessionSyncPendingInputServerContractResult | null | undefined,
): boolean {
    return contract?.runtimeActivity === 'v2';
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
        selection: CapabilitySelection,
        forcedMode?: 'auth_failed',
    ): SessionSyncPendingInputServerContractResult => ({
        mode: forcedMode ?? projectMode(selection),
        ...selection,
        sessionConnectionEpoch: probe.sessionConnectionEpoch,
        socket: probe.socket,
    });
    const isCurrent = (attempt: NonNullable<typeof active>): boolean => active === attempt;

    async function run(
        probe: EpochProbe,
        attempt: NonNullable<typeof active>,
    ): Promise<SessionSyncPendingInputServerContractResult> {
        if (!probe.machineId?.trim() || probe.socket.connected !== true) {
            return answer(probe, INDETERMINATE);
        }
        try {
            const snapshot = await observeServerFeaturesSnapshot({
                serverUrl: options.serverUrl,
                token: options.token,
                projection: 'public',
                timeoutMs,
                fetchImpl,
            });
            if (!isCurrent(attempt) || probe.socket.connected !== true) {
                return answer(probe, INDETERMINATE);
            }
            if (
                snapshot.status === 'error'
                && (snapshot.httpStatus === 401 || snapshot.httpStatus === 403)
            ) {
                return answer(probe, INDETERMINATE, 'auth_failed');
            }
            if (snapshot.status !== 'ready') return answer(probe, INDETERMINATE);
            const selection = resolveSessionServerCapabilities(snapshot.features);
            if (!isCurrent(attempt) || probe.socket.connected !== true) {
                return answer(probe, INDETERMINATE);
            }
            return answer(probe, selection);
        } catch {
            return answer(probe, INDETERMINATE);
        }
    }

    return {
        resolve(probe: EpochProbe): Promise<SessionSyncPendingInputServerContractResult> {
            if (!probe.machineId?.trim() || probe.socket.connected !== true) {
                active = null;
                return Promise.resolve(answer(probe, INDETERMINATE));
            }
            if (
                active?.sessionConnectionEpoch === probe.sessionConnectionEpoch
                && active.socket === probe.socket
                && active.promise
            ) return active.promise;
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
                    && result.publisherAuthority === 'indeterminate'
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
                ? answer({ sessionConnectionEpoch, socket, machineId: null }, INDETERMINATE)
                : null;
        },
    };
}
