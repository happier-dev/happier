import type {
    MachineLiveStreamCapsV1,
    MachineLiveStreamCodecIdV1,
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';

/**
 * Default viewer-proposed caps for a simulator live-stream watch (Phase 8.1b).
 *
 * The server enforces the real policy ceiling through the relay-authorization grant
 * scope (`requestLiveStreamRelayAuthorization`), so these are the viewer's requested
 * upper bounds, not a trusted limit. They are intentionally conservative; the
 * device-QA lane (8.2/8.3) tunes them against live capture once the
 * `devices.simulatorPreview` gate is flipped.
 */
export const DEFAULT_SIMULATOR_LIVE_STREAM_CAPS: MachineLiveStreamCapsV1 = {
    maxBitrateBps: 4_000_000,
    maxFramesPerSecond: 30,
    maxFrameBytes: 2_000_000,
    maxDurationMs: 30 * 60_000,
};

export type SimulatorLiveStreamIdentity = Readonly<{
    simulatorId: string;
    sourceMachineId: string;
    targetMachineId: string;
    /** Viewer account/profile id (the watcher identity — NOT a machine id). */
    viewerId: string;
    /** Per-tab viewer socket id. Required for product viewer relays so the server can target the tab. */
    viewerSocketId: string;
    streamId: string;
    streamFamily: string;
    sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
    caps: MachineLiveStreamCapsV1;
}>;

export type CreateSimulatorLiveStreamId = (input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    viewerId: string;
    viewerSocketId: string;
    streamFamily: string;
}>) => string;

/**
 * Deterministic per-(viewer, daemon, capture source) stream id. The daemon relay keys active
 * streams by `${streamId}:${targetMachineId}` AND, for the viewer path, by the per-tab viewer
 * socket. The id therefore binds the viewer identity so two tabs of the same user get isolated
 * logical streams (it previously dropped the target entirely, collapsing all viewers of a daemon
 * onto one id). A reconnecting viewer with a stable socket id resumes the same logical stream;
 * the daemon terminator resolves capture by `streamFamily` from the `start` envelope.
 */
export function createDefaultSimulatorLiveStreamId(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    viewerId: string;
    viewerSocketId: string;
    streamFamily: string;
}>): string {
    const viewerKey = input.viewerSocketId || input.viewerId || input.targetMachineId;
    return `sim-live:${input.sourceMachineId}:${input.streamFamily}:${viewerKey}`;
}

function normalize(value: unknown): string {
    return String(value ?? '').trim();
}

type ResolveSimulatorLiveStreamIdentityParams = Readonly<{
    resources: readonly SimulatorDeviceResourceV1[];
    selectedSimulatorId?: string | null;
    sourceMachineId?: string | null;
    targetMachineId?: string | null;
    viewerId?: string | null;
    viewerSocketId?: string | null;
    caps?: MachineLiveStreamCapsV1;
    createStreamId?: CreateSimulatorLiveStreamId;
}>;

function identitySignature(identity: SimulatorLiveStreamIdentity): string {
    return [
        identity.simulatorId,
        identity.sourceMachineId,
        identity.targetMachineId,
        identity.viewerId,
        identity.viewerSocketId,
        identity.streamId,
        identity.streamFamily,
        identity.sourceCodecs.join(','),
        identity.caps.maxBitrateBps,
        identity.caps.maxFramesPerSecond,
        identity.caps.maxFrameBytes,
        identity.caps.maxDurationMs,
        identity.caps.maxTotalBytes ?? '',
    ].join('|');
}

function deriveSimulatorLiveStreamIdentity(
    params: ResolveSimulatorLiveStreamIdentityParams,
): SimulatorLiveStreamIdentity | null {
    const simulatorId = normalize(params.selectedSimulatorId);
    const sourceMachineId = normalize(params.sourceMachineId);
    const targetMachineId = normalize(params.targetMachineId);
    const viewerId = normalize(params.viewerId);
    const viewerSocketId = normalize(params.viewerSocketId);
    if (!simulatorId || !sourceMachineId || !targetMachineId || !viewerId || !viewerSocketId) return null;

    const resource = params.resources.find((candidate) => candidate.simulatorId === simulatorId);
    if (!resource || resource.capture.status === 'unavailable') return null;

    const streamFamily = normalize(resource.capture.sourceId);
    if (!streamFamily) return null;

    const createStreamId = params.createStreamId ?? createDefaultSimulatorLiveStreamId;
    const caps = params.caps ?? DEFAULT_SIMULATOR_LIVE_STREAM_CAPS;
    return {
        simulatorId,
        sourceMachineId,
        targetMachineId,
        viewerId,
        viewerSocketId,
        streamId: createStreamId({ sourceMachineId, targetMachineId, viewerId, viewerSocketId, streamFamily }),
        streamFamily,
        sourceCodecs: resource.capture.supportedCodecs,
        caps,
    };
}

export type SimulatorLiveStreamIdentityResolver = (
    params: ResolveSimulatorLiveStreamIdentityParams,
) => SimulatorLiveStreamIdentity | null;

/**
 * Create a per-surface null-stable identity resolver. The memoized slot lives in the hook
 * instance that owns the resolver, so two mounted simulator surfaces cannot evict each other.
 */
export function createSimulatorLiveStreamIdentityResolver(): SimulatorLiveStreamIdentityResolver {
    let lastIdentitySignature: string | null = null;
    let lastIdentity: SimulatorLiveStreamIdentity | null = null;

    return (params) => {
        const next = deriveSimulatorLiveStreamIdentity(params);
        if (!next) {
            lastIdentitySignature = null;
            lastIdentity = null;
            return null;
        }

        const signature = identitySignature(next);
        if (signature === lastIdentitySignature && lastIdentity) {
            return lastIdentity;
        }
        lastIdentitySignature = signature;
        lastIdentity = next;
        return next;
    };
}

/**
 * Derive the canonical live-stream identity for the currently selected simulator from the
 * runtime surface output. Returns null when any required fact is missing (no selection,
 * resource not capture-available, no resolved relay machine identity, or no per-tab viewer
 * socket id) so the caller leaves ingestion disabled — fail-closed.
 */
export function resolveSimulatorLiveStreamIdentity(
    params: ResolveSimulatorLiveStreamIdentityParams,
): SimulatorLiveStreamIdentity | null {
    return deriveSimulatorLiveStreamIdentity(params);
}
