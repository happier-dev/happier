import type { Message } from './messageTypes';
import type { ReducerState } from '@/sync/reducer/reducer';

type RouteLookupState = Pick<ReducerState, 'toolIdToMessageId' | 'sidechainToolIdToMessageId' | 'messageIds' | 'localIds'>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseStableRouteRef(routeMessageId: string): { kind: 'tool' | 'server' | 'local'; value: string } | null {
    if (routeMessageId.startsWith('tool:')) {
        const value = normalizeNonEmptyString(routeMessageId.slice('tool:'.length));
        return value ? { kind: 'tool', value } : null;
    }
    if (routeMessageId.startsWith('server:')) {
        const value = normalizeNonEmptyString(routeMessageId.slice('server:'.length));
        return value ? { kind: 'server', value } : null;
    }
    if (routeMessageId.startsWith('local:')) {
        const value = normalizeNonEmptyString(routeMessageId.slice('local:'.length));
        return value ? { kind: 'local', value } : null;
    }
    return null;
}

export function isStableSessionMessageRouteId(routeMessageId: string | null | undefined): boolean {
    const normalizedRouteMessageId = normalizeNonEmptyString(routeMessageId);
    if (!normalizedRouteMessageId) return false;
    return parseStableRouteRef(normalizedRouteMessageId) !== null;
}

function readStableServerMessageId(message: Message): string | null {
    const maybeRealId = (message as Message & { realID?: unknown }).realID;
    return normalizeNonEmptyString(maybeRealId);
}

function readStableLocalMessageId(message: Message): string | null {
    return 'localId' in message ? normalizeNonEmptyString(message.localId) : null;
}

function findOriginalMessageIdForInternalId(reducerState: RouteLookupState | null | undefined, internalMessageId: string): string | null {
    if (!reducerState?.messageIds) return null;
    for (const [originalId, mappedInternalId] of reducerState.messageIds.entries()) {
        if (mappedInternalId === internalMessageId) {
            return normalizeNonEmptyString(originalId);
        }
    }
    return null;
}

export function buildToolCallMessageRouteId(params: Readonly<{
    toolId?: string | null;
    fallbackMessageId?: string | null;
}>): string | null {
    const stableFallbackMessageId = normalizeNonEmptyString(params.fallbackMessageId);
    if (isStableSessionMessageRouteId(stableFallbackMessageId)) {
        return stableFallbackMessageId;
    }
    const toolId = normalizeNonEmptyString(params.toolId);
    if (toolId) return `tool:${toolId}`;
    return stableFallbackMessageId;
}

export function buildMessageRouteId(message: Message): string {
    const stableServerMessageId = readStableServerMessageId(message);
    const stableLocalMessageId = readStableLocalMessageId(message);
    if (message.kind === 'tool-call') {
        return buildToolCallMessageRouteId({
            toolId: typeof message.tool.id === 'string' ? message.tool.id : null,
            fallbackMessageId:
                stableServerMessageId
                    ? `server:${stableServerMessageId}`
                    : stableLocalMessageId
                        ? `local:${stableLocalMessageId}`
                        : message.id,
        }) ?? (stableServerMessageId ? `server:${stableServerMessageId}` : stableLocalMessageId ? `local:${stableLocalMessageId}` : message.id);
    }
    return stableServerMessageId ? `server:${stableServerMessageId}` : stableLocalMessageId ? `local:${stableLocalMessageId}` : message.id;
}

export function buildSessionMessageRouteId(params: Readonly<{
    messageId: string;
    messagesById: Readonly<Record<string, Message>>;
    reducerState: RouteLookupState | null | undefined;
}>): string | null {
    const messageId = normalizeNonEmptyString(params.messageId);
    if (!messageId) return null;

    const message = params.messagesById[messageId];
    const originalMessageId = findOriginalMessageIdForInternalId(params.reducerState, messageId);
    if (originalMessageId) {
        return `server:${originalMessageId}`;
    }

    if (message) {
        const routeMessageId = buildMessageRouteId(message);
        if (routeMessageId !== messageId) {
            return routeMessageId;
        }
    }

    return message ? buildMessageRouteId(message) : messageId;
}

export function resolveMessageRouteIdForDisplay(params: Readonly<{
    message: Message;
    messagesById: Readonly<Record<string, Message>>;
    reducerState: RouteLookupState | null | undefined;
}>): string {
    const directRouteMessageId = buildMessageRouteId(params.message);
    const sessionRouteMessageId = buildSessionMessageRouteId({
        messageId: params.message.id,
        messagesById: params.messagesById,
        reducerState: params.reducerState,
    });

    if (typeof sessionRouteMessageId === 'string' && sessionRouteMessageId.startsWith('server:')) {
        return sessionRouteMessageId;
    }

    if (directRouteMessageId !== params.message.id) {
        return directRouteMessageId;
    }

    return sessionRouteMessageId ?? directRouteMessageId;
}

export function resolveSessionMessageRouteId(params: Readonly<{
    routeMessageId: string;
    messagesById: Readonly<Record<string, Message>>;
    reducerState: RouteLookupState | null | undefined;
}>): string | null {
    const routeMessageId = normalizeNonEmptyString(params.routeMessageId);
    if (!routeMessageId) return null;

    if (params.messagesById[routeMessageId]) {
        return routeMessageId;
    }

    const stableRef = parseStableRouteRef(routeMessageId);
    if (stableRef?.kind === 'tool') {
        return (
            params.reducerState?.toolIdToMessageId.get(stableRef.value)
            ?? params.reducerState?.sidechainToolIdToMessageId.get(stableRef.value)
            ?? null
        );
    }
    if (stableRef?.kind === 'server') {
        return params.reducerState?.messageIds.get(stableRef.value) ?? null;
    }
    if (stableRef?.kind === 'local') {
        return params.reducerState?.localIds.get(stableRef.value) ?? null;
    }

    return (
        params.reducerState?.toolIdToMessageId.get(routeMessageId)
        ?? params.reducerState?.sidechainToolIdToMessageId.get(routeMessageId)
        ?? params.reducerState?.localIds.get(routeMessageId)
        ?? params.reducerState?.messageIds.get(routeMessageId)
        ?? null
    );
}
