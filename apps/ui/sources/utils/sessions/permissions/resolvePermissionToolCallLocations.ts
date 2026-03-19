import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { PermissionToolCallMessageLocation } from './permissionToolCallLocationTypes';

function normalizeSeq(seq: unknown): number | null {
    return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
}

function isToolCallMessage(m: Message | undefined | null): m is ToolCallMessage {
    return Boolean(m && m.kind === 'tool-call');
}

export function resolvePermissionToolCallLocations(params: Readonly<{
    permissionIds: readonly string[];
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    toolIdToMessageId?: ReadonlyMap<string, string> | null;
    resolveRouteMessageId?: ((messageId: string, message: ToolCallMessage | undefined | null) => string | null) | null;
}>): ReadonlyMap<string, PermissionToolCallMessageLocation | null> {
    const ids = params.permissionIds
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => id.length > 0);
    const pendingPermissionIds = new Set(ids);
    const out = new Map<string, PermissionToolCallMessageLocation | null>();
    if (pendingPermissionIds.size === 0) return out;

    const topLevelToolCallIds = new Set<string>();
    const childToRootParent = new Map<string, string>();
    const resolveRouteMessageId = (messageId: string, message: ToolCallMessage | undefined | null): string => {
        return params.resolveRouteMessageId?.(messageId, message) ?? messageId;
    };

    const visitToolChildren = (rootParentRouteId: string, children: readonly Message[] | null | undefined) => {
        if (!Array.isArray(children) || children.length === 0) return;
        for (const child of children) {
            if (!isToolCallMessage(child)) continue;
            childToRootParent.set(child.id, rootParentRouteId);
            visitToolChildren(rootParentRouteId, child.children ?? []);
        }
    };

    for (const messageId of params.messageIdsOldestFirst) {
        const m = params.messagesById[messageId];
        if (!isToolCallMessage(m)) continue;
        topLevelToolCallIds.add(m.id);
        visitToolChildren(resolveRouteMessageId(m.id, m), m.children ?? []);
    }

    const resolveLocationForToolMessageId = (permissionId: string, toolMessageId: string): void => {
        const msg = params.messagesById[toolMessageId];
        const seq = msg ? normalizeSeq((msg as any).seq) : null;
        const routeMessageId = isToolCallMessage(msg) ? resolveRouteMessageId(toolMessageId, msg) : toolMessageId;

        if (topLevelToolCallIds.has(toolMessageId)) {
            out.set(permissionId, { kind: 'top', messageId: routeMessageId, seq });
            return;
        }

        const parentMessageId = childToRootParent.get(toolMessageId) ?? null;
        if (parentMessageId) {
            out.set(permissionId, { kind: 'nested', parentMessageId, messageId: routeMessageId, seq });
            return;
        }

        out.set(permissionId, { kind: 'top', messageId: routeMessageId, seq });
    };

    if (params.toolIdToMessageId && typeof params.toolIdToMessageId.get === 'function') {
        for (const permissionId of pendingPermissionIds) {
            const toolMessageId = params.toolIdToMessageId.get(permissionId) ?? null;
            if (!toolMessageId) continue;
            resolveLocationForToolMessageId(permissionId, toolMessageId);
        }
    }

    if (out.size < pendingPermissionIds.size) {
        const visit = (
            messages: ReadonlyArray<Message>,
            rootToolMessageId: string | null,
        ): void => {
            if (!Array.isArray(messages) || messages.length === 0) return;
            for (const m of messages) {
                if (!isToolCallMessage(m)) continue;
                const toolMessage = m as ToolCallMessage;

                const nextRootToolMessageId = rootToolMessageId ?? toolMessage.id;
                const permissionId =
                    typeof toolMessage.tool?.permission?.id === 'string'
                        ? toolMessage.tool.permission.id
                        : null;

                if (permissionId && pendingPermissionIds.has(permissionId) && !out.has(permissionId)) {
                    if (rootToolMessageId) {
                        out.set(permissionId, {
                            kind: 'nested',
                            parentMessageId: rootToolMessageId,
                            messageId: resolveRouteMessageId(toolMessage.id, toolMessage),
                            seq: normalizeSeq((toolMessage as any).seq),
                        });
                    } else {
                        out.set(permissionId, {
                            kind: 'top',
                            messageId: resolveRouteMessageId(toolMessage.id, toolMessage),
                            seq: normalizeSeq((toolMessage as any).seq),
                        });
                    }
                    if (out.size >= pendingPermissionIds.size) return;
                }

                visit(toolMessage.children ?? [], rootToolMessageId ?? resolveRouteMessageId(toolMessage.id, toolMessage));
                if (out.size >= pendingPermissionIds.size) return;
            }
        };

        const topLevelToolMessages: ToolCallMessage[] = [];
        for (const messageId of params.messageIdsOldestFirst) {
            const m = params.messagesById[messageId];
            if (!isToolCallMessage(m)) continue;
            topLevelToolMessages.push(m);
        }
        visit(topLevelToolMessages, null);
    }

    for (const permissionId of pendingPermissionIds) {
        if (!out.has(permissionId)) out.set(permissionId, null);
    }

    return out;
}
