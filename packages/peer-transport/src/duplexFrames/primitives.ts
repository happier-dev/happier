/** Neutral frame primitives. Payloads remain binary all the way through this package. */
import {
    encodePeerTcpTunnelBinaryFrameV2,
} from '@happier-dev/protocol';

export const MAX_SCHEDULABLE_TIMEOUT_MS = 2_147_483_647;

export function substreamAbortFrame(input: Readonly<{
    tunnelId: string;
    substreamId: string;
    reasonCode: string;
}>): Uint8Array {
    return encodePeerTcpTunnelBinaryFrameV2({
        header: {
            version: 2,
            kind: 'abort',
            tunnelId: input.tunnelId,
            substreamId: input.substreamId,
            reasonCode: input.reasonCode,
            payloadLength: 0,
        },
    });
}

import type {
    PeerTcpTunnelDirectionV1,
} from '@happier-dev/protocol';
import type { PeerTcpTunnelFrame } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDirection(value: unknown): value is PeerTcpTunnelDirectionV1 {
    return value === 'client_to_daemon' || value === 'daemon_to_client';
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Parses the package-owned binary logical frame shape; JSON conversion is caller-owned. */
export function parsePeerTcpTunnelFrame(raw: unknown): PeerTcpTunnelFrame | null {
    if (!isRecord(raw) || raw.v !== 1 || typeof raw.tunnelId !== 'string' || raw.tunnelId.length === 0) return null;
    if (raw.kind === 'data') {
        return isDirection(raw.direction)
            && isNonNegativeInteger(raw.sequence)
            && raw.payload instanceof Uint8Array
            ? {
                v: 1,
                kind: 'data',
                tunnelId: raw.tunnelId,
                direction: raw.direction,
                sequence: raw.sequence,
                payload: raw.payload,
            }
            : null;
    }
    if (raw.kind === 'ack') {
        return isDirection(raw.direction)
            && isNonNegativeInteger(raw.nextSequence)
            && isNonNegativeInteger(raw.windowBytes)
            ? {
                v: 1,
                kind: 'ack',
                tunnelId: raw.tunnelId,
                direction: raw.direction,
                nextSequence: raw.nextSequence,
                windowBytes: raw.windowBytes,
            }
            : null;
    }
    if (raw.kind === 'close') {
        return (raw.direction === undefined || isDirection(raw.direction))
            && (raw.halfClose === undefined || typeof raw.halfClose === 'boolean')
            && typeof raw.reasonCode === 'string'
            && raw.reasonCode.length > 0
            ? {
                v: 1,
                kind: 'close',
                tunnelId: raw.tunnelId,
                ...(raw.direction === undefined ? {} : { direction: raw.direction }),
                halfClose: raw.halfClose ?? false,
                reasonCode: raw.reasonCode,
            }
            : null;
    }
    if (raw.kind === 'abort') {
        return typeof raw.reasonCode === 'string' && raw.reasonCode.length > 0
            ? { v: 1, kind: 'abort', tunnelId: raw.tunnelId, reasonCode: raw.reasonCode }
            : null;
    }
    return null;
}


export function isSchedulableTimeoutMs(value: number | undefined): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 1
        && value <= MAX_SCHEDULABLE_TIMEOUT_MS;
}
