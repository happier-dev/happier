import { isBundledAgentId } from '@/agents/catalog/catalog';
import { getAgentModelConfig } from '@happier-dev/agents';
import { buildSendMessageMeta } from '@/sync/domains/messages/buildSendMessageMeta';
import type { MessageMeta } from "@happier-dev/session-core/messages";
import { resolveSentFrom } from '@/sync/domains/messages/sentFrom';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TranscriptAccountActor } from "@happier-dev/session-core/messages";
import { nowServerMs } from '@/sync/runtime/time';
import type { RawRecord } from "@happier-dev/session-core/raw";
import type { SessionMessageHostAdmissionOrigin } from '@/sync/domains/session/input/types';
import { buildTrustedHostSessionInputAdmissionV1, SESSION_INPUT_REQUEST_META_KEY, SESSION_MESSAGE_PROVENANCE_META_KEY, stripSessionInputProtectedMeta } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { projectSessionMessageModelSelectionToLegacyModelV1, withSessionMessageModelSelectionV1, type ProviderBoundModelRef, type SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { resolveEffectiveApiTokenModelRefV1, resolveEffectiveApiTokenPermissionModeV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { SentFrom } from '@happier-dev/protocol/sentFrom';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import {
    resolveSessionActionDefaultBackend,
    resolveSessionActionDefaultTarget,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';

type LocalOutboundDeliveryStatus = 'queued' | 'accepted';

/** Local display only; the server admission receipt replaces this projection. */
export function buildLocalOutboundAccountActor(scope: ServerAccountScope): TranscriptAccountActor {
    return {
        v: 1,
        serverId: scope.serverId,
        accountId: scope.accountId,
        profile: { firstName: null, lastName: null, username: null, avatarUrl: null },
    };
}

export function resolveOutgoingUserMessageModel(params: Readonly<{
    agentId: string | null;
    modelMode?: ModelMode | null;
    structuredModelSelection?: SessionModelSelectionV1 | null;
}>): MessageMeta['model'] | undefined {
    if (!params.agentId || !isBundledAgentId(params.agentId)) return undefined;
    const model = getAgentModelConfig(params.agentId);
    if (params.structuredModelSelection) {
        return model?.supportsSelection !== false
            ? projectSessionMessageModelSelectionToLegacyModelV1(params.structuredModelSelection)
            : undefined;
    }
    const modelMode = params.modelMode || model?.defaultMode;
    return model?.supportsSelection !== false && modelMode !== 'default' ? modelMode : undefined;
}

function resolveOutgoingModelContext(sessionValue: unknown, fallbackAgentId: string | null) {
    const session = sessionValue && typeof sessionValue === 'object' && !Array.isArray(sessionValue)
        ? sessionValue as Session : null;
    const defaultBackend = session ? resolveSessionActionDefaultBackend({ session }) : null;
    const defaultTarget = resolveSessionActionDefaultTarget(defaultBackend);
    const agentId = (session ? readSessionPresentationAgentId(session) : null) ?? fallbackAgentId;
    const agentTargetKey = defaultTarget ? resolveBackendTargetKeyV2(defaultTarget)
        : agentId ? buildAgentUniverseBackendTargetKey(agentId) : null;
    const modelOverride = session && agentTargetKey ? getModelOverrideForSpawn(session, agentTargetKey) : null;
    return { agentTargetKey, selection: modelOverride?.modelSelection ?? null };
}

/**
 * The model a message runs on when its sender may use only `allowedModels` (an embed's grant, or a
 * presentation that narrows the picker): the Session's own choice when it is allowed, else the first
 * allowed model for the current Agent (plan 04 §4.6, the same rule new chats use). The grant decision is the protocol's
 * (`resolveEffectiveApiTokenModelRefV1`); with no list the Session's choice, Automatic included, stands.
 */
function constrainOutgoingModelSelection(
    selection: SessionModelSelectionV1 | null,
    allowedModels: readonly ProviderBoundModelRef[] | null | undefined,
    agentTargetKey: string | null,
): SessionModelSelectionV1 | null {
    if (!allowedModels) return selection;
    const effective = resolveEffectiveApiTokenModelRefV1({ models: [...allowedModels] }, selection?.ref ?? 'automatic', agentTargetKey ?? undefined);
    if (effective === null || effective === 'automatic') return selection;
    if (selection && sameModelRef(selection.ref, effective)) return selection;
    return { v: 1, updatedAt: nowServerMs(), ref: effective };
}

function sameModelRef(left: ProviderBoundModelRef, right: ProviderBoundModelRef): boolean {
    return left.agentTargetKey === right.agentTargetKey
        && left.providerConnectionId === right.providerConnectionId
        && left.modelId === right.modelId;
}

function stripOutgoingUserMessageProtectedMeta(
    meta: Record<string, unknown> | Partial<MessageMeta> | null | undefined,
): Record<string, unknown> {
    const next = stripSessionInputProtectedMeta(meta as Record<string, unknown> | null | undefined);
    delete next[SESSION_MESSAGE_PROVENANCE_META_KEY];
    return next;
}

function buildHostAdmissionMeta(origin: SessionMessageHostAdmissionOrigin | undefined): Record<string, unknown> {
    const admission = buildTrustedHostSessionInputAdmissionV1(origin === 'voice' ? 'voice' : 'ui');
    return {
        [SESSION_MESSAGE_PROVENANCE_META_KEY]: admission.provenance,
        [SESSION_INPUT_REQUEST_META_KEY]: admission.request,
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
    /** The models this sender may run (an embed's grant or a narrowing presentation); `null`: any. */
    allowedModels?: readonly ProviderBoundModelRef[] | null;
    /** Per-input permission grant; absent/null retains the unrestricted sender's policy. */
    allowedPermissionModes?: readonly PermissionMode[] | null;
}>): RawRecord {
    const modelContext = resolveOutgoingModelContext(params.session, params.agentId);
    const structuredModelSelection = constrainOutgoingModelSelection(
        modelContext.selection,
        params.allowedModels,
        modelContext.agentTargetKey,
    );
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
    if (params.allowedPermissionModes) {
        const effectiveMode = resolveEffectiveApiTokenPermissionModeV1(
            { permissionModes: [...params.allowedPermissionModes] },
            mergedMeta.permissionMode ?? params.permissionMode,
        );
        if (effectiveMode === null) throw Object.assign(new Error('permission_mode_not_granted'), { code: 'permission_mode_not_granted' });
        mergedMeta.permissionMode = effectiveMode;
    }
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
        ...(params.pendingOutboxScope && params.rawRecord.role === 'user'
            ? { accountActor: buildLocalOutboundAccountActor(params.pendingOutboxScope) }
            : {}),
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
