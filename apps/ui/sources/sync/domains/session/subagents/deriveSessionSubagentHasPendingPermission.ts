import type { Message } from '@/sync/domains/messages/messageTypes';

import type { SessionSubagent } from './types';

type SidechainToolPermissionLike = Readonly<{
    id?: string | null;
    status?: string | null;
    kind?: string | null;
}> | null;

type SidechainMessageLike = Readonly<{
    tool?: Readonly<{
        permission?: SidechainToolPermissionLike;
    }> | null;
}> | null;

type PermissionStateLike = Readonly<{
    status?: string | null;
}> | null;

type SidechainStateLike = Readonly<{
    sidechains?: ReadonlyMap<string, readonly SidechainMessageLike[]> | null;
    permissions?: ReadonlyMap<string, PermissionStateLike> | null;
}> | null;

function hasPendingPermissionInMessages(params: Readonly<{
    messages: readonly Message[];
    reducerState: SidechainStateLike;
}>): boolean {
    for (const message of params.messages) {
        if (message.kind !== 'tool-call') continue;

        const permission = message.tool.permission;
        if (
            permission &&
            permission.kind !== 'user_action' &&
            readCurrentPermissionStatus({ permission, reducerState: params.reducerState }) === 'pending'
        ) {
            return true;
        }

        if (hasPendingPermissionInMessages({ messages: message.children, reducerState: params.reducerState })) {
            return true;
        }
    }

    return false;
}

function findSubagentToolChildren(params: Readonly<{
    messages: readonly Message[];
    toolId: string | null;
}>): readonly Message[] {
    for (const message of params.messages) {
        if (message.kind !== 'tool-call') continue;

        if (params.toolId && message.tool.id === params.toolId) {
            return message.children;
        }

        const nested = findSubagentToolChildren({
            messages: message.children,
            toolId: params.toolId,
        });
        if (nested.length > 0) return nested;
    }

    return [];
}

function readCurrentPermissionStatus(params: Readonly<{
    permission: NonNullable<SidechainToolPermissionLike>;
    reducerState: SidechainStateLike;
}>): string | null {
    const permissionId = typeof params.permission.id === 'string' ? params.permission.id.trim() : '';
    if (permissionId.length > 0) {
        const currentStatus = params.reducerState?.permissions?.get(permissionId)?.status;
        if (typeof currentStatus === 'string' && currentStatus.trim().length > 0) {
            return currentStatus.trim();
        }
    }

    return typeof params.permission.status === 'string' && params.permission.status.trim().length > 0
        ? params.permission.status.trim()
        : null;
}

export function deriveSessionSubagentHasPendingPermission(params: Readonly<{
    subagent: SessionSubagent;
    reducerState: SidechainStateLike;
    messages?: readonly Message[];
}>): boolean {
    const sidechainId = params.subagent.transcript.sidechainId?.trim();
    const sidechainMessages = sidechainId ? params.reducerState?.sidechains?.get(sidechainId) : null;

    if (Array.isArray(sidechainMessages) && sidechainMessages.length > 0) {
        for (let index = sidechainMessages.length - 1; index >= 0; index -= 1) {
            const permission = sidechainMessages[index]?.tool?.permission;
            if (!permission) continue;
            if (permission.kind === 'user_action') continue;
            if (readCurrentPermissionStatus({ permission, reducerState: params.reducerState }) === 'pending') {
                return true;
            }
        }

        return false;
    }

    const toolId = params.subagent.transcript.toolId?.trim() || null;
    if (Array.isArray(params.messages) && params.messages.length > 0) {
        const focusedMessages = findSubagentToolChildren({
            messages: params.messages,
            toolId,
        });
        if (focusedMessages.length > 0 && hasPendingPermissionInMessages({
            messages: focusedMessages,
            reducerState: params.reducerState,
        })) {
            return true;
        }
    }

    return false;
}
