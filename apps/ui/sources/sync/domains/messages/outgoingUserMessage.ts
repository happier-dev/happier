import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { buildSendMessageMeta } from '@/sync/domains/messages/buildSendMessageMeta';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';
import { resolveSentFrom } from '@/sync/domains/messages/sentFrom';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { nowServerMs } from '@/sync/runtime/time';
import type { RawRecord } from '@/sync/typesRaw';
import type { SessionMessageHostAdmissionOrigin } from '@/sync/domains/session/input/types';
import {
    projectSessionMessageModelSelectionToLegacyModelV1,
    SESSION_INPUT_REQUEST_META_KEY,
    SESSION_MESSAGE_PROVENANCE_META_KEY,
    SessionInputRequestV1Schema,
    SessionMessageProvenanceV1Schema,
    stripSessionInputProtectedMeta,
    withSessionMessageModelSelectionV1,
    type SentFrom,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';

type LocalOutboundDeliveryStatus = 'queued' | 'accepted';

export function resolveOutgoingUserMessageModel(params: Readonly<{
    agentId: string | null;
    modelMode?: ModelMode | null;
    structuredModelSelection?: SessionModelSelectionV1 | null;
}>): MessageMeta['model'] | undefined {
    if (!params.agentId || !isBundledAgentId(params.agentId)) return undefined;
    const agentCore = getAgentCore(params.agentId);
    if (params.structuredModelSelection) {
        return agentCore.model.supportsSelection
            ? projectSessionMessageModelSelectionToLegacyModelV1(params.structuredModelSelection)
            : undefined;
    }
    const modelMode = params.modelMode || agentCore.model.defaultMode;
    return agentCore.model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;
}

function resolveStructuredOutgoingModelSelection(sessionValue: unknown): SessionModelSelectionV1 | null {
    if (!sessionValue || typeof sessionValue !== 'object' || Array.isArray(sessionValue)) return null;
    const session = sessionValue as Session;
    const defaultBackend = resolveSessionActionDefaultBackend({ session });
    if (!defaultBackend) return null;
    const modelOverride = getModelOverrideForSpawn(
        session,
        resolveBackendTargetKeyV2(defaultBackend.backendTarget),
    );
    return modelOverride?.modelSelection ?? null;
}

function stripOutgoingUserMessageProtectedMeta(
    meta: Record<string, unknown> | Partial<MessageMeta> | null | undefined,
): Record<string, unknown> {
    const next = stripSessionInputProtectedMeta(meta as Record<string, unknown> | null | undefined);
    delete next[SESSION_MESSAGE_PROVENANCE_META_KEY];
    return next;
}

function buildHostAdmissionMeta(origin: SessionMessageHostAdmissionOrigin | undefined): Record<string, unknown> {
    if (origin !== 'voice') return {};
    return {
        [SESSION_MESSAGE_PROVENANCE_META_KEY]: SessionMessageProvenanceV1Schema.parse({
            v: 1,
            kind: 'voice',
        }),
        [SESSION_INPUT_REQUEST_META_KEY]: SessionInputRequestV1Schema.parse({
            v: 1,
            producer: 'voiceInput',
            caller: { kind: 'host' },
            permission: {},
        }),
    };
}

export function buildOutgoingUserTextRecord(params: Readonly<{
    text: string;
    displayText?: string;
    agentId: string | null;
    modelMode?: ModelMode | null;
    permissionMode: PermissionMode;
    settings: Record<string, unknown>;
    session: unknown;
    metaOverrides?: Record<string, unknown> | Partial<MessageMeta> | null;
    hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
    sentFrom?: SentFrom;
}>): RawRecord {
    const structuredModelSelection = resolveStructuredOutgoingModelSelection(params.session);
    const callerMeta = stripOutgoingUserMessageProtectedMeta(params.metaOverrides);
    const mergedMeta = buildSendMessageMeta({
        sentFrom: params.sentFrom ?? resolveSentFrom(),
        permissionMode: params.permissionMode || 'default',
        model: resolveOutgoingUserMessageModel({
            agentId: params.agentId,
            modelMode: params.modelMode,
            structuredModelSelection,
        }),
        displayText: params.displayText,
        agentId: params.agentId,
        settings: params.settings,
        session: params.session,
        metaOverrides: callerMeta as Partial<MessageMeta>,
    });
    const meta = {
        ...stripOutgoingUserMessageProtectedMeta(mergedMeta),
        ...buildHostAdmissionMeta(params.hostAdmissionOrigin),
    };
    return {
        role: 'user',
        content: {
            type: 'text',
            text: params.text,
        },
        meta: structuredModelSelection
            ? withSessionMessageModelSelectionV1(meta, structuredModelSelection)
            : meta,
    };
}

export function buildLocalOutboundPendingUserMessage(params: Readonly<{
    localId: string;
    text: string;
    displayText?: string;
    rawRecord: RawRecord;
    deliveryStatus?: LocalOutboundDeliveryStatus;
    createdAt?: number;
    updatedAt?: number;
    pendingOutboxScope?: ServerAccountScope;
    pendingOutboxOperation?: 'enqueue' | 'cancel';
}>): PendingMessage {
    const createdAt = typeof params.createdAt === 'number' && Number.isFinite(params.createdAt)
        ? params.createdAt
        : nowServerMs();
    const updatedAt = typeof params.updatedAt === 'number' && Number.isFinite(params.updatedAt)
        ? params.updatedAt
        : createdAt;
    return {
        id: params.localId,
        localId: params.localId,
        createdAt,
        updatedAt,
        source: 'local_outbound',
        deliveryStatus: params.deliveryStatus,
        pendingOutboxScope: params.pendingOutboxScope,
        pendingOutboxOperation: params.pendingOutboxOperation,
        text: params.text,
        displayText: params.displayText,
        rawRecord: params.rawRecord,
    };
}

export function readLatestLocalOutboundPendingUserMessageAt(messages: ReadonlyArray<PendingMessage>): number | null {
    let latest: number | null = null;
    for (const message of messages) {
        if (message.source !== 'local_outbound') continue;
        const createdAt = message.createdAt;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}

export function projectLocalOutboundUserMessage(params: Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    displayText?: string;
    rawRecord: RawRecord;
    deliveryStatus?: LocalOutboundDeliveryStatus;
    createdAt?: number;
    updatedAt?: number;
}>): void {
    storage.getState().upsertPendingMessage(params.sessionId, buildLocalOutboundPendingUserMessage(params));
}

export function clearLocalOutboundUserMessage(params: Readonly<{
    sessionId: string;
    localId: string;
}>): void {
    storage.getState().removePendingMessage(params.sessionId, params.localId);
}
