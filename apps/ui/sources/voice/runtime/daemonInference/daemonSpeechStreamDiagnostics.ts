import { DAEMON_VOICE_INFERENCE_CLIENT_ERROR_CODES } from './daemonVoiceInferenceErrors';

export type DaemonSpeechStreamTransportKind =
    | 'binary_tunnel'
    | 'json_rpc_compat'
    | 'json_rpc_compat_forbidden';

export type DaemonSpeechStreamTransportSelection = Readonly<{
    sessionId: string;
    machineId: string;
    transport: DaemonSpeechStreamTransportKind;
}>;

export type DaemonSpeechStreamBinaryTunnelReceipt = Readonly<{
    routeKind: 'loopback_direct' | 'server_relay';
    frameEncoding: 'binary_frame_v2';
    carrierKind: 'binary_tunnel_frame_v2';
    relayEvidence:
        | 'not_applicable'
        | 'pending'
        | 'key_install_authenticated'
        | 'chunk_ack_authenticated'
        | 'finish_authenticated';
    streamIdentity: Readonly<{
        machineId: string;
        packId: string | null;
        streamId: string;
        generation: number;
    }> | null;
    maxAuthenticatedAckSeq: number | null;
    localTransport: 'open' | 'closed' | 'close_failed';
    operation: Readonly<{
        kind: 'finish' | 'cancel';
        result: 'ok' | 'error';
    }> | null;
}>;

export type DaemonSpeechStreamBinaryTunnelReceiptRecorder = Readonly<{
    recordStreamIdentity: (identity: Readonly<{
        machineId: string;
        packId: string | null;
        streamId: string;
        generation: number;
    }>) => void;
    recordRelayEvidence: (evidence: Readonly<{
        phase: 'install' | 'data' | 'finish';
        ackSeq?: number;
    }>) => void;
    recordOperationResult: (
        operation: 'finish' | 'cancel',
        result: 'ok' | 'error',
    ) => void;
    recordLocalTransportClose: (result: 'closed' | 'close_failed') => void;
}>;

export type DaemonSpeechStreamDiagnosticsSnapshot = Readonly<{
    binaryTunnelSelections: number;
    jsonRpcCompatibilitySelections: number;
    jsonRpcCompatibilityForbidden: number;
    lastTransport: DaemonSpeechStreamTransportKind | null;
    lastBinaryTunnelReceipt: DaemonSpeechStreamBinaryTunnelReceipt | null;
    lastStartFailure: Readonly<{
        code: string | null;
        message: string;
    }> | null;
}>;

const RETAINED_START_FAILURE_CODES = new Set([
    ...DAEMON_VOICE_INFERENCE_CLIENT_ERROR_CODES,
    'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
    'VOICE_CONVERSATION_TARGET_MISSING',
    'stream_transport_unavailable',
    'MACHINE_RPC_ABORTED',
]);

const RETAINED_START_FAILURE_MESSAGES = new Set([
    'daemon_voice_inference_stream_transport_unavailable',
    'voice_conversation_spawn_target_missing',
]);

function readAllowlistedFailureValue(value: unknown, allowlist: ReadonlySet<string>): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return allowlist.has(normalized) ? normalized : null;
}

function readStartFailure(error: unknown): NonNullable<DaemonSpeechStreamDiagnosticsSnapshot['lastStartFailure']> {
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
    const message = readAllowlistedFailureValue(record?.message, RETAINED_START_FAILURE_MESSAGES)
        ?? readAllowlistedFailureValue(error, RETAINED_START_FAILURE_MESSAGES)
        ?? 'redacted_start_failure';
    return Object.freeze({
        code: readAllowlistedFailureValue(record?.code, RETAINED_START_FAILURE_CODES),
        message,
    });
}

export function createDaemonSpeechStreamDiagnostics(options?: Readonly<{
    warn?: (message: string) => void;
    maxRememberedSessions?: number;
}>) {
    const warn = options?.warn ?? ((message: string) => console.warn(message));
    const maxRememberedSessions = Math.max(1, Math.floor(options?.maxRememberedSessions ?? 64));
    const warnedSessionIds = new Set<string>();
    const warnedSessionOrder: string[] = [];
    let binaryTunnelSelections = 0;
    let jsonRpcCompatibilitySelections = 0;
    let jsonRpcCompatibilityForbidden = 0;
    let lastTransport: DaemonSpeechStreamTransportKind | null = null;
    let lastBinaryTunnelReceipt: DaemonSpeechStreamBinaryTunnelReceipt | null = null;
    let lastStartFailure: DaemonSpeechStreamDiagnosticsSnapshot['lastStartFailure'] = null;
    let binaryTunnelReceiptGeneration = 0;
    const listeners = new Set<() => void>();
    let currentSnapshot: DaemonSpeechStreamDiagnosticsSnapshot = Object.freeze({
        binaryTunnelSelections,
        jsonRpcCompatibilitySelections,
        jsonRpcCompatibilityForbidden,
        lastTransport,
        lastBinaryTunnelReceipt,
        lastStartFailure,
    });

    const publish = (): void => {
        currentSnapshot = Object.freeze({
            binaryTunnelSelections,
            jsonRpcCompatibilitySelections,
            jsonRpcCompatibilityForbidden,
            lastTransport,
            lastBinaryTunnelReceipt,
            lastStartFailure,
        });
        for (const listener of listeners) listener();
    };

    return Object.freeze({
        beginBinaryTunnelReceipt: (input: Readonly<{
            routeKind: 'loopback_direct' | 'server_relay';
            frameEncoding: 'binary_frame_v2';
            carrierKind: 'binary_tunnel_frame_v2';
        }>): DaemonSpeechStreamBinaryTunnelReceiptRecorder => {
            const generation = ++binaryTunnelReceiptGeneration;
            lastStartFailure = null;
            lastBinaryTunnelReceipt = Object.freeze({
                ...input,
                relayEvidence: input.routeKind === 'server_relay' ? 'pending' : 'not_applicable',
                streamIdentity: null,
                maxAuthenticatedAckSeq: null,
                localTransport: 'open',
                operation: null,
            });
            publish();

            const updateCurrentReceipt = (
                update: (current: DaemonSpeechStreamBinaryTunnelReceipt) => DaemonSpeechStreamBinaryTunnelReceipt,
            ): void => {
                if (generation !== binaryTunnelReceiptGeneration || !lastBinaryTunnelReceipt) return;
                lastBinaryTunnelReceipt = Object.freeze(update(lastBinaryTunnelReceipt));
                publish();
            };

            return Object.freeze({
                recordStreamIdentity: (identity): void => {
                    updateCurrentReceipt((current) => ({
                        ...current,
                        streamIdentity: Object.freeze({ ...identity }),
                    }));
                },
                recordRelayEvidence: (evidence): void => {
                    updateCurrentReceipt((current) => {
                        if (current.routeKind !== 'server_relay') return current;
                        const rank = {
                            pending: 0,
                            key_install_authenticated: 1,
                            chunk_ack_authenticated: 2,
                            finish_authenticated: 3,
                        } as const;
                        const nextEvidence = evidence.phase === 'install'
                            ? 'key_install_authenticated'
                            : evidence.phase === 'data'
                                ? 'chunk_ack_authenticated'
                                : 'finish_authenticated';
                        const currentRank = current.relayEvidence === 'key_install_authenticated'
                            ? 1
                            : current.relayEvidence === 'chunk_ack_authenticated'
                                ? 2
                                : current.relayEvidence === 'finish_authenticated'
                                    ? 3
                                    : 0;
                        const relayEvidence = rank[nextEvidence] > currentRank
                            ? nextEvidence
                            : current.relayEvidence;
                        const ackSeq = evidence.ackSeq;
                        const maxAuthenticatedAckSeq = typeof ackSeq === 'number'
                            && Number.isSafeInteger(ackSeq)
                            && ackSeq >= -1
                            ? Math.max(current.maxAuthenticatedAckSeq ?? -1, ackSeq)
                            : current.maxAuthenticatedAckSeq;
                        return {
                            ...current,
                            relayEvidence,
                            maxAuthenticatedAckSeq,
                        };
                    });
                },
                recordOperationResult: (operation, result): void => {
                    updateCurrentReceipt((current) => ({
                        ...current,
                        operation: { kind: operation, result },
                    }));
                },
                recordLocalTransportClose: (result): void => {
                    updateCurrentReceipt((current) => ({
                        ...current,
                        localTransport: result,
                    }));
                },
            });
        },
        record: (selection: DaemonSpeechStreamTransportSelection): void => {
            lastTransport = selection.transport;
            lastStartFailure = null;
            if (selection.transport === 'binary_tunnel') {
                binaryTunnelSelections += 1;
                publish();
                return;
            }
            binaryTunnelReceiptGeneration += 1;
            lastBinaryTunnelReceipt = null;
            if (selection.transport === 'json_rpc_compat_forbidden') {
                jsonRpcCompatibilityForbidden += 1;
            } else {
                jsonRpcCompatibilitySelections += 1;
            }
            publish();
            if (warnedSessionIds.has(selection.sessionId)) return;
            warnedSessionIds.add(selection.sessionId);
            warnedSessionOrder.push(selection.sessionId);
            while (warnedSessionOrder.length > maxRememberedSessions) {
                const retired = warnedSessionOrder.shift();
                if (retired) warnedSessionIds.delete(retired);
            }
            warn(selection.transport === 'json_rpc_compat_forbidden'
                ? '[daemonVoiceInference] JSON/RPC streaming STT compatibility transport blocked by policy'
                : '[daemonVoiceInference] streaming STT using explicit JSON/RPC compatibility transport');
        },
        recordStartFailure: (error: unknown): void => {
            lastStartFailure = readStartFailure(error);
            publish();
        },
        snapshot: (): DaemonSpeechStreamDiagnosticsSnapshot => currentSnapshot,
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    });
}

export const daemonSpeechStreamDiagnostics = createDaemonSpeechStreamDiagnostics();
