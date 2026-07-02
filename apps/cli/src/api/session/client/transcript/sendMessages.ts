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
import {
    buildUserTextMessageContent,
} from '../../outbound/shared';
import { extractAssistantTextSnapshotFromAcpMessage } from '../../turns/extractAssistantTextSnapshot';
import type { TurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshot';

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

type CommitSessionMessageParams = Readonly<{
    message: PlainOrEncryptedPayload;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole;
    sessionEventType?: SessionEventType;
    logErrorMessage: string;
    markAsUserMessage?: boolean;
}>;

export type SessionClientTranscriptSendPort = Readonly<{
    sessionId: string;
    turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
    socket: {
        connected: boolean;
        emit: (event: 'transcript-stream-segment', payload: unknown) => void;
    };
    outboundShapeLogger: {
        log: (label: string, payload: unknown) => void;
    };
    debug: (message: string, data?: unknown) => void;
    debugLargeJson: (message: string, data?: unknown) => void;
    getMetadataSnapshot: () => Metadata | null;
    buildOutboundSessionMessagePayload: (content: unknown) => PlainOrEncryptedPayload;
    commitSessionMessageBestEffort: (params: CommitSessionMessageParams) => void;
    logSendWhileDisconnected: (context: string, details?: Record<string, unknown>) => void;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
}>;

function observeAcpAssistantText(params: Readonly<{
    store?: TurnAssistantTextSnapshotStore;
    provider: ACPProvider;
    body: ACPMessageData;
    localId?: string | null;
    source: 'ephemeral' | 'provider-dispatch';
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

export function sendAgentMessageViaPort(
    port: SessionClientTranscriptSendPort,
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: Readonly<{ localId?: string; meta?: Record<string, unknown> }>,
): Readonly<{
    normalizedBody: ACPMessageData;
    localId: string;
}> {
    const { normalizedBody, content, localId, sidechainId } = prepareAcpTranscriptDispatch({
        provider,
        body,
        meta: opts?.meta,
        localId: opts?.localId,
        toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
        permissionToolCallRawInputByProviderAndId: port.permissionToolCallRawInputByProviderAndId,
        toolCallInputByProviderAndId: port.toolCallInputByProviderAndId,
    });

    port.outboundShapeLogger.log(`acp:${provider}:${normalizedBody.type}`, normalizedBody);
    port.debug(`[SOCKET] Sending ACP message from ${provider}:`, {
        type: normalizedBody.type,
        hasMessage: 'message' in normalizedBody,
    });
    port.logSendWhileDisconnected(`${provider} ACP message`, { type: normalizedBody.type });

    const messageRole = resolveAcpSessionMessageRole(normalizedBody);
    const payload = port.buildOutboundSessionMessagePayload(content);
    port.commitSessionMessageBestEffort({
        message: payload,
        localId,
        sidechainId,
        messageRole,
        logErrorMessage: '[SOCKET] Failed to commit agent message (non-fatal)',
    });
    observeAcpAssistantText({
        store: port.turnAssistantTextSnapshotStore,
        provider,
        body: normalizedBody,
        localId,
        source: 'provider-dispatch',
    });

    return { normalizedBody, localId };
}

export function sendUserTextMessageViaPort(
    port: SessionClientTranscriptSendPort,
    text: string,
    opts?: Readonly<{ localId?: string; meta?: Record<string, unknown> }>,
): void {
    const content = buildUserTextMessageContent(text, opts?.meta);

    port.logSendWhileDisconnected('User text message', { length: text.length });
    const payload = port.buildOutboundSessionMessagePayload(content);
    const localId = typeof opts?.localId === 'string' && opts.localId.length > 0 ? opts.localId : randomUUID();
    const meta = opts?.meta ?? null;
    const metaSource = typeof meta?.source === 'string' ? meta.source : null;
    const metaSentFrom = typeof meta?.sentFrom === 'string' ? meta.sentFrom : null;
    if (metaSource === 'cli' || metaSentFrom === 'cli') {
        port.markAgentQueueEchoSuppressedLocalId(localId);
    }

    port.commitSessionMessageBestEffort({
        message: payload,
        localId,
        sidechainId: null,
        messageRole: 'user',
        markAsUserMessage: true,
        logErrorMessage: '[SOCKET] Failed to commit user message (non-fatal)',
    });
}

export function sendAgentMessageEphemeralViaPort(
    port: SessionClientTranscriptSendPort,
    provider: ACPProvider,
    body: ACPMessageData,
    opts: Readonly<{ localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> }>,
): void {
    if (!port.socket.connected) {
        return;
    }

    const { normalizedBody, content, localId, sidechainId } = prepareAcpTranscriptDispatch({
        provider,
        body,
        meta: opts.meta,
        localId: opts.localId,
        toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
        permissionToolCallRawInputByProviderAndId: port.permissionToolCallRawInputByProviderAndId,
        toolCallInputByProviderAndId: port.toolCallInputByProviderAndId,
    });
    const messageRole = resolveAcpSessionMessageRole(normalizedBody);
    const payload = port.buildOutboundSessionMessagePayload(content);
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
        port.socket.emit('transcript-stream-segment', {
            sid: port.sessionId,
            message: {
                localId,
                ...(sidechainId ? { sidechainId } : {}),
                messageRole,
                content: payload,
                createdAt,
                updatedAt,
            },
        });
    } catch {
        // best effort
    }
    observeAcpAssistantText({
        store: port.turnAssistantTextSnapshotStore,
        provider,
        body: normalizedBody,
        localId,
        source: 'ephemeral',
    });
}

export function sendSessionEventViaPort(
    port: SessionClientTranscriptSendPort,
    event: SessionEventMessage,
    id?: string,
): void {
    const content = buildSessionEventContent(event, id);
    port.logSendWhileDisconnected('session event', { eventType: event.type });

    const payload = port.buildOutboundSessionMessagePayload(content);
    port.commitSessionMessageBestEffort({
        message: payload,
        localId: randomUUID(),
        sidechainId: null,
        messageRole: resolveSessionEventMessageRole(),
        sessionEventType: event.type === 'ready' ? 'ready' : undefined,
        logErrorMessage: '[SOCKET] Failed to commit session event (non-fatal)',
    });
}
