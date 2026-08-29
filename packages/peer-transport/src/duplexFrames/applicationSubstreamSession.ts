/** Application-substream session: admission, credit, bounded pending dispatch, teardown. */
import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
} from '@happier-dev/protocol';
import { substreamAbortFrame, isSchedulableTimeoutMs } from './primitives.js';
import type { PeerTcpTunnelApplicationSubstreamSessionResult } from './types.js';

function peerTcpTunnelBinaryDecodeFailureReason(reasonCode: string): 'encoded_frame_too_large' | 'decoded_payload_too_large' | 'frame_invalid' {
    if (reasonCode === 'header_too_large') return 'encoded_frame_too_large';
    if (reasonCode === 'payload_too_large') return 'decoded_payload_too_large';
    return 'frame_invalid';
}

const DEFAULT_MAX_PENDING_APPLICATION_DISPATCHES = 8;
const DEFAULT_MAX_PENDING_APPLICATION_DISPATCH_BYTES = 256 * 1024;

type ActivePeerTcpTunnelApplicationSubstream = {
    bytes: number;
    lastSequence: number | undefined;
    lastDaemonSequence: number | undefined;
    lastActivityMs: number;
    pendingDispatches: number;
    pendingDispatchBytes: number;
    dispatchTail: Promise<void>;
    idleTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Owns admission for application substreams carried by binary_frame_v2 without
 * manufacturing a TCP connection. The application callback only sees admitted
 * request bytes; response bytes pass through the same caps before emission.
 */
export function createPeerTcpTunnelApplicationSubstreamSession(input: Readonly<{
    tunnelId: string;
    maxBinaryHeaderBytes: number;
    maxFrameBytes: number;
    maxBytesPerSubstream: number;
    maxAggregateBytes: number;
    maxConcurrentSubstreams: number;
    maxTotalSubstreams: number;
    maxSubstreamIdleMs: number;
    maxSessionIdleMs: number;
    maxDurationMs: number;
    maxPendingDispatches?: number;
    maxPendingDispatchBytes?: number;
    sendBinaryFrame: (frame: Uint8Array) => Promise<void> | void;
    onTerminal: (input: Readonly<{
        reasonCode: string;
        substreamIds: readonly string[];
    }>) => Promise<void> | void;
    nowMs?: () => number;
}>) {
    const nowMs = input.nowMs ?? Date.now;
    const maxPendingDispatches = input.maxPendingDispatches
        ?? DEFAULT_MAX_PENDING_APPLICATION_DISPATCHES;
    const maxPendingDispatchBytes = input.maxPendingDispatchBytes
        ?? DEFAULT_MAX_PENDING_APPLICATION_DISPATCH_BYTES;
    const startedAtMs = nowMs();
    let lastSessionActivityMs = startedAtMs;
    let aggregateBytes = 0;
    let closed = false;
    let terminalPromise: Promise<void> | null = null;
    let sessionIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    const activeSubstreams = new Map<string, ActivePeerTcpTunnelApplicationSubstream>();
    const openedSubstreamIds = new Set<string>();

    function clearTimers(): void {
        if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
        if (durationTimer) clearTimeout(durationTimer);
        sessionIdleTimer = undefined;
        durationTimer = undefined;
        for (const active of activeSubstreams.values()) {
            if (active.idleTimer) clearTimeout(active.idleTimer);
            active.idleTimer = undefined;
        }
    }

    function terminate(inputReason: Readonly<{
        reasonCode: string;
        substreamId?: string;
        sendAbort?: boolean;
    }>): Promise<void> {
        if (terminalPromise) return terminalPromise;
        closed = true;
        clearTimers();
        const terminalSubstreamIds = new Set(openedSubstreamIds);
        if (inputReason.substreamId) terminalSubstreamIds.add(inputReason.substreamId);
        terminalPromise = (async () => {
            try {
                if (inputReason.sendAbort && inputReason.substreamId) {
                    await input.sendBinaryFrame(substreamAbortFrame({
                        tunnelId: input.tunnelId,
                        substreamId: inputReason.substreamId,
                        reasonCode: inputReason.reasonCode,
                    }));
                }
            } finally {
                await input.onTerminal({
                    reasonCode: inputReason.reasonCode,
                    substreamIds: [...terminalSubstreamIds],
                });
            }
        })();
        return terminalPromise;
    }

    function scheduleSessionIdleTimer(): void {
        if (closed || !isSchedulableTimeoutMs(input.maxSessionIdleMs)) return;
        if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
        sessionIdleTimer = setTimeout(() => {
            const substreamId = activeSubstreams.keys().next().value as string | undefined;
            void terminate({
                reasonCode: 'max_idle_exceeded',
                ...(substreamId ? { substreamId, sendAbort: true } : {}),
            });
        }, input.maxSessionIdleMs);
        sessionIdleTimer.unref?.();
    }

    function scheduleSubstreamIdleTimer(
        substreamId: string,
        active: ActivePeerTcpTunnelApplicationSubstream,
    ): void {
        if (closed || !isSchedulableTimeoutMs(input.maxSubstreamIdleMs)) return;
        if (active.idleTimer) clearTimeout(active.idleTimer);
        active.idleTimer = setTimeout(() => {
            void terminate({ reasonCode: 'max_idle_exceeded', substreamId, sendAbort: true });
        }, input.maxSubstreamIdleMs);
        active.idleTimer.unref?.();
    }

    function recordBytes(
        substreamId: string,
        active: ActivePeerTcpTunnelApplicationSubstream,
        bytes: number,
    ): void {
        active.bytes += bytes;
        aggregateBytes += bytes;
        active.lastActivityMs = nowMs();
        lastSessionActivityMs = active.lastActivityMs;
        scheduleSubstreamIdleTimer(substreamId, active);
        scheduleSessionIdleTimer();
    }

    function canRecordBytes(
        substreamId: string,
        active: ActivePeerTcpTunnelApplicationSubstream,
        bytes: number,
    ): PeerTcpTunnelApplicationSubstreamSessionResult {
        if (active.bytes + bytes > input.maxBytesPerSubstream || aggregateBytes + bytes > input.maxAggregateBytes) {
            return { ok: false, reasonCode: 'substream_cap_exceeded', substreamId };
        }
        return { ok: true };
    }

    async function deny(
        reasonCode: Extract<PeerTcpTunnelApplicationSubstreamSessionResult, { ok: false }>['reasonCode'],
        substreamId?: string,
    ): Promise<PeerTcpTunnelApplicationSubstreamSessionResult> {
        await terminate({
            reasonCode,
            ...(substreamId ? { substreamId, sendAbort: true } : {}),
        });
        return { ok: false, reasonCode, ...(substreamId ? { substreamId } : {}) };
    }

    if (isSchedulableTimeoutMs(input.maxDurationMs)) {
        durationTimer = setTimeout(() => {
            const substreamId = activeSubstreams.keys().next().value as string | undefined;
            void terminate({
                reasonCode: 'max_duration_exceeded',
                ...(substreamId ? { substreamId, sendAbort: true } : {}),
            });
        }, input.maxDurationMs);
        durationTimer.unref?.();
    }
    scheduleSessionIdleTimer();

    return {
        denySubstream(
            substreamId: string,
            reasonCode: Extract<PeerTcpTunnelApplicationSubstreamSessionResult, { ok: false }>['reasonCode'],
        ): Promise<PeerTcpTunnelApplicationSubstreamSessionResult> {
            return deny(reasonCode, substreamId);
        },
        async acceptBinaryFrame(
            raw: Uint8Array,
            dispatch: (frame: Readonly<{
                substreamId: string;
                sequence: number;
                payload: Uint8Array;
            }>) => Promise<Uint8Array | null>,
        ): Promise<PeerTcpTunnelApplicationSubstreamSessionResult> {
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: raw,
                maxHeaderBytes: input.maxBinaryHeaderBytes,
                maxPayloadBytes: Number.MAX_SAFE_INTEGER,
            });
            if (!decoded.ok) {
                return deny(peerTcpTunnelBinaryDecodeFailureReason(decoded.reasonCode));
            }
            const substreamId = decoded.header.substreamId;
            if (!substreamId) return deny('frame_invalid');
            if (closed) return { ok: false, reasonCode: 'tunnel_closed', substreamId };
            if (decoded.header.tunnelId !== input.tunnelId) {
                return deny('tunnel_id_mismatch', substreamId);
            }

            const now = nowMs();
            if (now - startedAtMs > input.maxDurationMs) {
                return deny('max_duration_exceeded', substreamId);
            }
            if (now - lastSessionActivityMs > input.maxSessionIdleMs) {
                return deny('max_idle_exceeded', substreamId);
            }
            if (decoded.header.kind === 'close' || decoded.header.kind === 'abort') {
                if (decoded.payload.byteLength !== 0) return deny('frame_invalid', substreamId);
                await terminate({ reasonCode: decoded.header.reasonCode ?? 'tunnel_closed' });
                return { ok: true };
            }
            if (
                decoded.header.kind !== 'data'
                || decoded.header.direction !== 'client_to_daemon'
                || decoded.header.sequence === undefined
            ) {
                return deny(
                    decoded.header.kind === 'data' ? 'direction_not_allowed' : 'frame_invalid',
                    substreamId,
                );
            }
            if (decoded.payload.byteLength > input.maxFrameBytes) {
                return deny('decoded_payload_too_large', substreamId);
            }

            let active = activeSubstreams.get(substreamId);
            if (!active) {
                if (
                    activeSubstreams.size >= input.maxConcurrentSubstreams
                    || openedSubstreamIds.size >= input.maxTotalSubstreams
                ) {
                    return deny('substream_cap_exceeded', substreamId);
                }
                active = {
                    bytes: 0,
                    lastSequence: undefined,
                    lastDaemonSequence: undefined,
                    lastActivityMs: now,
                    pendingDispatches: 0,
                    pendingDispatchBytes: 0,
                    dispatchTail: Promise.resolve(),
                };
                activeSubstreams.set(substreamId, active);
                openedSubstreamIds.add(substreamId);
            } else if (now - active.lastActivityMs > input.maxSubstreamIdleMs) {
                return deny('max_idle_exceeded', substreamId);
            }

            const expectedSequence = active.lastSequence === undefined ? 0 : active.lastSequence + 1;
            if (decoded.header.sequence !== expectedSequence) {
                return deny('sequence_mismatch', substreamId);
            }
            const requestAdmission = canRecordBytes(substreamId, active, decoded.payload.byteLength);
            if (!requestAdmission.ok) return deny(requestAdmission.reasonCode, substreamId);
            if (
                active.pendingDispatches + 1 > maxPendingDispatches
                || active.pendingDispatchBytes + decoded.payload.byteLength > maxPendingDispatchBytes
            ) {
                return deny('substream_cap_exceeded', substreamId);
            }

            active.lastSequence = decoded.header.sequence;
            active.pendingDispatches += 1;
            active.pendingDispatchBytes += decoded.payload.byteLength;
            recordBytes(substreamId, active, decoded.payload.byteLength);
            const sequence = decoded.header.sequence;
            try {
                await input.sendBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
                    header: {
                        version: 2,
                        kind: 'ack',
                        tunnelId: input.tunnelId,
                        substreamId,
                        direction: 'client_to_daemon',
                        ack: sequence + 1,
                        window: decoded.payload.byteLength,
                        payloadLength: 0,
                    },
                }));
            } catch (error) {
                try {
                    await terminate({ reasonCode: 'application_response_send_failed' });
                } catch {
                    // Preserve the transport boundary's original failure after cleanup was attempted.
                }
                throw error;
            }
            const queuedDispatch = active.dispatchTail.then(async () => {
                if (closed) return { ok: false as const };
                try {
                    return {
                        ok: true as const,
                        responsePayload: await dispatch({
                            substreamId,
                            sequence,
                            payload: decoded.payload,
                        }),
                    };
                } catch (error) {
                    try {
                        await terminate({
                            reasonCode: 'application_dispatch_failed',
                            substreamId,
                            sendAbort: true,
                        });
                    } catch {
                        // Preserve the application boundary's original failure after cleanup was attempted.
                    }
                    throw error;
                }
            });
            active.dispatchTail = queuedDispatch.then(
                () => undefined,
                () => undefined,
            );
            const dispatched = await queuedDispatch.finally(() => {
                active.pendingDispatches = Math.max(0, active.pendingDispatches - 1);
                active.pendingDispatchBytes = Math.max(
                    0,
                    active.pendingDispatchBytes - decoded.payload.byteLength,
                );
            });
            if (!dispatched.ok) return { ok: false, reasonCode: 'tunnel_closed', substreamId };
            const responsePayload = dispatched.responsePayload;
            if (responsePayload === null) return { ok: true };
            if (closed) return { ok: false, reasonCode: 'tunnel_closed', substreamId };
            if (responsePayload.byteLength > input.maxFrameBytes) {
                return deny('decoded_payload_too_large', substreamId);
            }
            const responseAdmission = canRecordBytes(substreamId, active, responsePayload.byteLength);
            if (!responseAdmission.ok) return deny(responseAdmission.reasonCode, substreamId);

            recordBytes(substreamId, active, responsePayload.byteLength);
            try {
                await input.sendBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
                    header: {
                        version: 2,
                        kind: 'data',
                        tunnelId: input.tunnelId,
                        substreamId,
                        direction: 'daemon_to_client',
                        sequence: decoded.header.sequence,
                        payloadLength: responsePayload.byteLength,
                    },
                    payload: responsePayload,
                }));
            } catch (error) {
                try {
                    await terminate({ reasonCode: 'application_response_send_failed' });
                } catch {
                    // Preserve the transport boundary's original failure after cleanup was attempted.
                }
                throw error;
            }
            return { ok: true };
        },
        async sendApplicationFrame(output: Readonly<{
            substreamId: string;
        }> & (
            | Readonly<{ payload: Uint8Array; createPayload?: never }>
            | Readonly<{
                payload?: never;
                createPayload: (sequence: number) => Promise<Uint8Array> | Uint8Array;
              }>
        )): Promise<PeerTcpTunnelApplicationSubstreamSessionResult> {
            if (closed) return { ok: false, reasonCode: 'tunnel_closed', substreamId: output.substreamId };
            const active = activeSubstreams.get(output.substreamId);
            if (!active) return deny('frame_invalid', output.substreamId);
            const sequence = active.lastDaemonSequence === undefined
                ? 0
                : active.lastDaemonSequence + 1;
            const payload = output.createPayload
                ? await output.createPayload(sequence)
                : output.payload;
            if (payload.byteLength > input.maxFrameBytes) {
                return deny('decoded_payload_too_large', output.substreamId);
            }
            const admission = canRecordBytes(output.substreamId, active, payload.byteLength);
            if (!admission.ok) return deny(admission.reasonCode, output.substreamId);
            active.lastDaemonSequence = sequence;
            recordBytes(output.substreamId, active, payload.byteLength);
            try {
                await input.sendBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
                    header: {
                        version: 2,
                        kind: 'data',
                        tunnelId: input.tunnelId,
                        substreamId: output.substreamId,
                        direction: 'daemon_to_client',
                        sequence,
                        payloadLength: payload.byteLength,
                    },
                    payload,
                }));
            } catch (error) {
                try {
                    await terminate({ reasonCode: 'application_response_send_failed' });
                } catch {
                    // Preserve the transport boundary's original failure after cleanup was attempted.
                }
                throw error;
            }
            return { ok: true };
        },
        close: () => terminate({ reasonCode: 'tunnel_closed' }),
    };
}
