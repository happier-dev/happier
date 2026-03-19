import { describe, expect, it } from 'vitest';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { buildMessageRouteId } from '@/sync/domains/messages/messageRouteIds';

import { resolvePermissionToolCallLocations } from './resolvePermissionToolCallLocations';

function toolMessage(params: Readonly<{
    id: string;
    seq?: number;
    permissionId?: string;
    toolId?: string | null;
    realID?: string | null;
    children?: ToolCallMessage[];
}>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: 1,
        tool: {
            ...(typeof params.toolId === 'string' ? { id: params.toolId } : params.toolId === null ? {} : { id: `call:${params.id}` }),
            name: 'tool',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
            ...(params.permissionId ? { permission: { id: params.permissionId, status: 'pending' as const } } : {}),
        } as any,
        ...(typeof params.realID === 'string' ? { realID: params.realID } : {}),
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        children: params.children ?? [],
    } as any;
}

describe('resolvePermissionToolCallLocations', () => {
    it('resolves top-level tool call locations using toolIdToMessageId', () => {
        const top = toolMessage({ id: 't1', seq: 10, permissionId: 'p1' });
        const messagesById = { t1: top };
        const ids = ['t1'];
        const toolIdToMessageId = new Map<string, string>([['p1', 't1']]);

        const out = resolvePermissionToolCallLocations({
            permissionIds: ['p1'],
            messageIdsOldestFirst: ids,
            messagesById,
            toolIdToMessageId,
            resolveRouteMessageId: (_messageId, message) => (message ? buildMessageRouteId(message) : null),
        });

        expect(out.get('p1')).toEqual({ kind: 'top', messageId: 'tool:call:t1', seq: 10 });
    });

    it('resolves nested tool call locations (child -> root parent)', () => {
        const child = toolMessage({ id: 'c1', seq: 11, permissionId: 'p2' });
        const parent = toolMessage({ id: 'p0', seq: 10, children: [child] });
        const messagesById = { p0: parent, c1: child };
        const ids = ['p0'];
        const toolIdToMessageId = new Map<string, string>([['p2', 'c1']]);

        const out = resolvePermissionToolCallLocations({
            permissionIds: ['p2'],
            messageIdsOldestFirst: ids,
            messagesById,
            toolIdToMessageId,
            resolveRouteMessageId: (_messageId, message) => (message ? buildMessageRouteId(message) : null),
        });

        expect(out.get('p2')).toEqual({
            kind: 'nested',
            parentMessageId: 'tool:call:p0',
            messageId: 'tool:call:c1',
            seq: 11,
        });
    });

    it('returns null for unknown permission ids', () => {
        const top = toolMessage({ id: 't1', seq: 10 });
        const out = resolvePermissionToolCallLocations({
            permissionIds: ['p-missing'],
            messageIdsOldestFirst: ['t1'],
            messagesById: { t1: top },
            toolIdToMessageId: new Map<string, string>(),
        });

        expect(out.get('p-missing')).toBeNull();
    });

    it('uses the provided route-id resolver when a tool call has no provider tool id', () => {
        const top = toolMessage({ id: 'internal-1', realID: 'server-msg-1', toolId: null, seq: 10, permissionId: 'p3' });

        const out = resolvePermissionToolCallLocations({
            permissionIds: ['p3'],
            messageIdsOldestFirst: ['internal-1'],
            messagesById: { 'internal-1': top },
            toolIdToMessageId: new Map<string, string>([['p3', 'internal-1']]),
            resolveRouteMessageId: (messageId) => (messageId === 'internal-1' ? 'server:server-msg-1' : messageId),
        });

        expect(out.get('p3')).toEqual({ kind: 'top', messageId: 'server:server-msg-1', seq: 10 });
    });
});
