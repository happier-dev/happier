import { describe, expect, it } from 'vitest';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { resolvePermissionToolCallLocations } from './resolvePermissionToolCallLocations';

function toolMessage(params: Readonly<{
    id: string;
    seq?: number;
    permissionId?: string;
    children?: ToolCallMessage[];
}>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: 1,
        tool: {
            id: `call:${params.id}`,
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
        });

        expect(out.get('p1')).toEqual({ kind: 'top', messageId: 't1', seq: 10 });
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
        });

        expect(out.get('p2')).toEqual({ kind: 'nested', parentMessageId: 'p0', messageId: 'c1', seq: 11 });
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
});
