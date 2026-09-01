import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { buildSendMessageMeta } from '@/sync/domains/messages/buildSendMessageMeta';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { nowServerMs } from '@/sync/runtime/time';
import type { RawRecord } from '@/sync/typesRaw';

type LocalOutboundDeliveryStatus = 'queued' | 'accepted';

export function buildOutgoingUserTextRecord(params: Readonly<{
    text: string;
    sentFrom: string;
    displayText?: string;
    agentId: AgentId | null;
    modelMode?: ModelMode | null;
    permissionMode: PermissionMode;
    settings: Record<string, unknown>;
    session: unknown;
    metaOverrides?: Record<string, unknown> | null;
}>): RawRecord {
    const agentCore = params.agentId ? getAgentCore(params.agentId) : null;
    const modelMode = params.modelMode || agentCore?.model.defaultMode || 'default';
    const model = agentCore?.model.supportsSelection && modelMode !== 'default'
        ? modelMode
        : undefined;
    return {
        role: 'user',
        content: { type: 'text', text: params.text },
        meta: {
            ...buildSendMessageMeta({
                sentFrom: params.sentFrom,
                permissionMode: params.permissionMode || 'default',
                model,
                displayText: params.displayText,
                agentId: params.agentId,
                settings: params.settings,
                session: params.session,
            }),
            ...(params.metaOverrides ?? {}),
        },
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
        text: params.text,
        displayText: params.displayText,
        rawRecord: params.rawRecord,
    };
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
    storage.getState().upsertPendingMessage(
        params.sessionId,
        buildLocalOutboundPendingUserMessage(params),
    );
}
