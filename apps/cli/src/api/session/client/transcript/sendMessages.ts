import { randomUUID } from 'node:crypto';

import type {
    Metadata,
} from '../../../types';
import type {
    ACPMessageData,
    ACPProvider,
    SessionEventMessage,
} from '../../sessionMessageTypes';
import {
    prepareAcpTranscriptDispatch,
} from '../../outbound/transcriptDispatch';
import {
    resolveAcpSessionMessageRole,
    resolveSessionEventMessageRole,
} from '../../messageRole';
import { extractAssistantTextSnapshotFromAcpMessage } from '../../turns/extractAssistantTextSnapshot';
import type { TurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshot';
import {
    createEphemeralSendFailure,
    type EphemeralSendOutcome,
} from './ephemeralSendOutcome';

type PlainOrEncryptedPayload = string | { t: 'plain'; v: unknown };
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';
type SessionEventType = 'ready';

function buildSessionEventContent(event: SessionEventMessage, id?: string): {
    role: 'agent';
    content: {
        id: string;
        type: 'event';
        data: SessionEventMessage;
    };
} {
    return {
        role: 'agent',
        content: {
            id: id ?? randomUUID(),
            type: 'event',
            data: event,
        },
    };
}

export function prepareSessionEventMessageViaPort(
    port: Pick<SessionClientTranscriptSendPort, 'buildOutboundSessionMessagePayload'>,
    event: SessionEventMessage,
    id?: string,
): Readonly<{
    payload: PlainOrEncryptedPayload;
    localId: string;
    messageRole: SessionMessageRole;
    sessionEventType: SessionEventType | undefined;
}> {
    return {
        payload: port.buildOutboundSessionMessagePayload(buildSessionEventContent(event, id)),
        localId: randomUUID(),
        messageRole: resolveSessionEventMessageRole(),
        sessionEventType: event.type === 'ready' ? 'ready' : undefined,
    };
}

export type SessionClientTranscriptSendPort = Readonly<{
    sessionId: string;
    turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
    socket: {
        connected: boolean;
        emit: (event: 'transcript-stream-segment' | 'transcript-stream-segment-delta', payload: unknown) => void;
    };
    getEphemeralStreamConnectionEpoch?: () => number;
    outboundShapeLogger: {
        log: (label: string, payload: unknown) => void;
    };
    debug: (message: string, data?: unknown) => void;
    debugLargeJson: (message: string, data?: unknown) => void;
    getMetadataSnapshot: () => Metadata | null;
    buildOutboundSessionMessagePayload: (content: unknown) => PlainOrEncryptedPayload;
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
    maxToolCallCacheEntries?: number | undefined;
}>;

function readEphemeralStreamConnectionEpoch(port: SessionClientTranscriptSendPort): number {
    const epoch = port.getEphemeralStreamConnectionEpoch?.();
    return typeof epoch === 'number' && Number.isFinite(epoch) ? Math.max(0, Math.trunc(epoch)) : 0;
}

function observeAcpAssistantText(params: Readonly<{
    store?: TurnAssistantTextSnapshotStore;
    provider: ACPProvider;
    body: ACPMessageData;
    localId?: string | null;
    source: 'ephemeral';
}>): void {
    const extracted = extractAssistantTextSnapshotFromAcpMessage(params.provider, params.body);
    if (!extracted) return;
    params.store?.observe({
        text: extracted.text,
        provider: extracted.provider,
        sidechainId: extracted.sidechainId,
        localId: params.localId ?? null,
        source: params.source,
    });
}

export function sendAgentMessageEphemeralViaPort(
    port: SessionClientTranscriptSendPort,
    provider: ACPProvider,
    body: ACPMessageData,
    opts: Readonly<{ localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number }>,
): EphemeralSendOutcome {
    const epoch = readEphemeralStreamConnectionEpoch(port);
    if (!port.socket.connected) {
        return createEphemeralSendFailure('disconnected', epoch);
    }

    let prepared: ReturnType<typeof prepareAcpTranscriptDispatch>;
    try {
        prepared = prepareAcpTranscriptDispatch({
            provider,
            body,
            meta: opts.meta,
            localId: opts.localId,
            toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: port.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: port.toolCallInputByProviderAndId,
            maxToolCallCacheEntries: port.maxToolCallCacheEntries,
        });
    } catch (error) {
        return createEphemeralSendFailure('prepare_failed', readEphemeralStreamConnectionEpoch(port), error);
    }
    const { normalizedBody, content, localId, sidechainId } = prepared;
    const messageRole = resolveAcpSessionMessageRole(normalizedBody);
    let payload: PlainOrEncryptedPayload;
    try {
        payload = port.buildOutboundSessionMessagePayload(content);
    } catch (error) {
        return createEphemeralSendFailure('serialize_failed', readEphemeralStreamConnectionEpoch(port), error);
    }
    const createdAt =
        typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
            ? Math.max(0, Math.trunc(opts.createdAt))
            : Date.now();
    const metaUpdatedAt =
        typeof opts.meta?.happierStreamSegmentV1 === 'object'
        && opts.meta?.happierStreamSegmentV1
        && typeof (opts.meta.happierStreamSegmentV1 as Record<string, unknown>).updatedAtMs === 'number'
        && Number.isFinite((opts.meta.happierStreamSegmentV1 as Record<string, unknown>).updatedAtMs)
            ? Math.trunc((opts.meta.happierStreamSegmentV1 as Record<string, unknown>).updatedAtMs as number)
            : undefined;
    const updatedAt =
        typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
            ? Math.max(createdAt, Math.trunc(opts.updatedAt))
            : typeof metaUpdatedAt === 'number'
                ? Math.max(createdAt, metaUpdatedAt)
                : Date.now();

    try {
        observeAcpAssistantText({
            store: port.turnAssistantTextSnapshotStore,
            provider,
            body: normalizedBody,
            localId,
            source: 'ephemeral',
        });
    } catch (error) {
        return createEphemeralSendFailure('observe_failed', readEphemeralStreamConnectionEpoch(port), error);
    }

    try {
        port.socket.emit('transcript-stream-segment', {
            sid: port.sessionId,
            message: {
                localId,
                ...(sidechainId ? { sidechainId } : {}),
                messageRole,
                ...(typeof opts.tick === 'number' && Number.isFinite(opts.tick) && opts.tick >= 0
                    ? { tick: Math.trunc(opts.tick) }
                    : {}),
                content: payload,
                createdAt,
                updatedAt,
            },
        });
    } catch (error) {
        return createEphemeralSendFailure('emit_failed', readEphemeralStreamConnectionEpoch(port), error);
    }
    return { accepted: true, epoch: readEphemeralStreamConnectionEpoch(port) };
}

/**
 * Emit a live transcript delta tick: `body` carries ONLY the text appended since the previous
 * live emission for this segment. Full-snapshot checkpoints still flow through
 * `sendAgentMessageEphemeralViaPort`; receivers that cannot chain a delta drop it and resync on
 * the next checkpoint. The delta content goes through the same envelope/encryption choke point as
 * snapshots (`prepareAcpTranscriptDispatch` + `buildOutboundSessionMessagePayload`).
 */
export function sendAgentMessageEphemeralDeltaViaPort(
    port: SessionClientTranscriptSendPort,
    provider: ACPProvider,
    body: ACPMessageData,
    opts: Readonly<{ localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> }>,
): EphemeralSendOutcome {
    const epoch = readEphemeralStreamConnectionEpoch(port);
    if (!port.socket.connected) {
        return createEphemeralSendFailure('disconnected', epoch);
    }

    let prepared: ReturnType<typeof prepareAcpTranscriptDispatch>;
    try {
        prepared = prepareAcpTranscriptDispatch({
            provider,
            body,
            meta: opts.meta,
            localId: opts.localId,
            toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: port.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: port.toolCallInputByProviderAndId,
            maxToolCallCacheEntries: port.maxToolCallCacheEntries,
        });
    } catch (error) {
        return createEphemeralSendFailure('prepare_failed', readEphemeralStreamConnectionEpoch(port), error);
    }
    const { normalizedBody, content, localId, sidechainId } = prepared;
    const messageRole = resolveAcpSessionMessageRole(normalizedBody);
    let payload: PlainOrEncryptedPayload;
    try {
        payload = port.buildOutboundSessionMessagePayload(content);
    } catch (error) {
        return createEphemeralSendFailure('serialize_failed', readEphemeralStreamConnectionEpoch(port), error);
    }
    const createdAt =
        typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
            ? Math.max(0, Math.trunc(opts.createdAt))
            : Date.now();
    const updatedAt =
        typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
            ? Math.max(createdAt, Math.trunc(opts.updatedAt))
            : Date.now();

    // Intentionally no observeAcpAssistantText here: delta bodies carry only appended chars, and
    // the turn-assistant-text snapshot expects full text. Full-snapshot checkpoints (<= 1s apart)
    // keep the turn snapshot fresh through sendAgentMessageEphemeralViaPort.

    try {
        port.socket.emit('transcript-stream-segment-delta', {
            sid: port.sessionId,
            message: {
                localId,
                ...(sidechainId ? { sidechainId } : {}),
                messageRole,
                tick: Math.max(1, Math.trunc(opts.tick)),
                baseLength: Math.max(0, Math.trunc(opts.baseLength)),
                content: payload,
                createdAt,
                updatedAt,
            },
        });
    } catch (error) {
        return createEphemeralSendFailure('emit_failed', readEphemeralStreamConnectionEpoch(port), error);
    }
    return { accepted: true, epoch: readEphemeralStreamConnectionEpoch(port) };
}
