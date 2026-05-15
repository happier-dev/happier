import type { ApprovalRequestV1 } from '@happier-dev/protocol';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';

type ApprovalLocationEntry = Readonly<{
    artifactId: string;
    approval: ApprovalRequestV1;
}>;

function normalizeSeq(seq: unknown): number | null {
    return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
}

function isToolCallMessage(message: Message | undefined | null): message is ToolCallMessage {
    return Boolean(message && message.kind === 'tool-call');
}

function stableSerialize(value: unknown): string | null {
    if (typeof value === 'undefined') return null;
    try {
        return JSON.stringify(value, (_key, nested) => {
            if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(nested).sort()) {
                sorted[key] = (nested as Record<string, unknown>)[key];
            }
            return sorted;
        });
    } catch {
        return null;
    }
}

function hasExactOriginAnchor(origin: ApprovalRequestV1['origin']): boolean {
    return Boolean(origin?.messageId || origin?.parentMessageId || origin?.toolCallId);
}

function createLocation(params: Readonly<{
    message: ToolCallMessage;
    routeMessageId: string;
    parentRouteMessageId: string | null;
}>): PermissionToolCallMessageLocation {
    const seq = normalizeSeq((params.message as any).seq);
    if (params.parentRouteMessageId) {
        return {
            kind: 'nested',
            parentMessageId: params.parentRouteMessageId,
            messageId: params.routeMessageId,
            seq,
        };
    }

    return {
        kind: 'top',
        messageId: params.routeMessageId,
        seq,
    };
}

export function resolveApprovalToolCallLocations(params: Readonly<{
    approvals: readonly ApprovalLocationEntry[];
    sessionId: string;
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    resolveRouteMessageId?: ((messageId: string, message: ToolCallMessage | undefined | null) => string | null) | null;
}>): ReadonlyMap<string, PermissionToolCallMessageLocation | null> {
    const approvals = params.approvals.filter((entry) => entry.artifactId.trim().length > 0);
    const out = new Map<string, PermissionToolCallMessageLocation | null>();
    if (approvals.length === 0) return out;

    const sessionId = params.sessionId.trim();
    const resolveRouteMessageId = (messageId: string, message: ToolCallMessage | undefined | null): string => {
        return params.resolveRouteMessageId?.(messageId, message) ?? messageId;
    };

    const locationsByMessageId = new Map<string, PermissionToolCallMessageLocation>();
    const locationsByToolCallId = new Map<string, PermissionToolCallMessageLocation>();
    const toolMessages: ToolCallMessage[] = [];

    const visit = (message: ToolCallMessage, parentRouteMessageId: string | null): void => {
        const routeMessageId = resolveRouteMessageId(message.id, message);
        const location = createLocation({ message, routeMessageId, parentRouteMessageId });
        locationsByMessageId.set(message.id, location);
        locationsByMessageId.set(routeMessageId, location);
        if (typeof message.tool?.id === 'string' && message.tool.id.trim()) {
            locationsByToolCallId.set(message.tool.id, location);
        }
        toolMessages.push(message);

        const nextParentRouteMessageId = parentRouteMessageId ?? routeMessageId;
        for (const child of message.children ?? []) {
            if (isToolCallMessage(child)) visit(child, nextParentRouteMessageId);
        }
    };

    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (isToolCallMessage(message)) visit(message, null);
    }

    for (const entry of approvals) {
        const origin = entry.approval.origin;
        if (origin?.kind !== 'transcript_tool_call' || origin.sessionId !== sessionId) {
            out.set(entry.artifactId, null);
            continue;
        }

        const byMessageId = origin.messageId ? locationsByMessageId.get(origin.messageId) : null;
        if (byMessageId) {
            out.set(entry.artifactId, byMessageId);
            continue;
        }

        const byParentMessageId =
            origin.parentMessageId && !origin.messageId
                ? locationsByMessageId.get(origin.parentMessageId)
                : null;
        if (byParentMessageId) {
            out.set(entry.artifactId, byParentMessageId);
            continue;
        }

        const byToolCallId = origin.toolCallId ? locationsByToolCallId.get(origin.toolCallId) : null;
        if (byToolCallId) {
            out.set(entry.artifactId, byToolCallId);
            continue;
        }

        if (hasExactOriginAnchor(origin)) {
            out.set(entry.artifactId, null);
            continue;
        }

        const originToolInput = stableSerialize(origin.toolInput);
        const matches = toolMessages.filter((message) => {
            if (!origin.toolName || message.tool?.name !== origin.toolName) return false;
            if (originToolInput == null) return true;
            return stableSerialize(message.tool?.input) === originToolInput;
        });

        out.set(entry.artifactId, matches.length === 1 ? locationsByMessageId.get(matches[0]!.id) ?? null : null);
    }

    return out;
}
