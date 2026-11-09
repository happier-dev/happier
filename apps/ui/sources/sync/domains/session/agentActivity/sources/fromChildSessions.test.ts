import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

import { deriveChildSessionActivityEntries } from './fromChildSessions';

function child(params: Readonly<{
    id: string;
    creator?: string;
    serverId?: string;
    role?: string;
    roleName?: string;
    active?: boolean;
    thinking?: boolean;
    latestTurnStatus?: 'in_progress' | 'completed' | 'failed' | 'cancelled';
    latestTurnStatusObservedAt?: number;
    name?: string;
}>): SessionListViewItem {
    return {
        type: 'session',
        serverId: params.serverId ?? 'server-a',
        session: {
            id: params.id,
            seq: 1,
            createdAt: 10,
            updatedAt: 20,
            active: params.active ?? false,
            activeAt: 20,
            metadataVersion: 1,
            agentStateVersion: 1,
            thinking: params.thinking ?? false,
            thinkingAt: 20,
            presence: 'online',
            latestTurnStatus: params.latestTurnStatus,
            latestTurnStatusObservedAt: params.latestTurnStatusObservedAt,
            metadata: {
                path: '/repo',
                name: params.name ?? params.id,
                sessionOriginV1: params.creator
                    ? { v: 1, kind: 'agent', creatorSessionId: params.creator }
                    : null,
                sessionRole: params.role as never,
                sessionRoleName: params.roleName ?? null,
            },
        },
    };
}

describe('deriveChildSessionActivityEntries', () => {
    it('projects immutable-origin children with authoritative turn status and timestamps', () => {
        const entries = deriveChildSessionActivityEntries({
            parentSessionId: 'parent',
            items: [
                child({ id: 'worker-1', creator: 'parent', role: 'worker', name: 'Windows worker', active: true, latestTurnStatus: 'completed', latestTurnStatusObservedAt: 101 }),
                child({ id: 'worker-1', creator: 'parent', role: 'worker', name: 'duplicate' }),
                child({ id: 'failed-1', creator: 'parent', role: 'reviewer', active: true, latestTurnStatus: 'failed', latestTurnStatusObservedAt: 102 }),
                child({ id: 'cancelled-1', creator: 'parent', role: 'reviewer', latestTurnStatus: 'cancelled', latestTurnStatusObservedAt: 103 }),
                child({ id: 'unknown-1', creator: 'parent', role: 'custom:123e4567-e89b-12d3-a456-426614174000', roleName: 'Release Captain' }),
                child({ id: 'running-1', creator: 'parent', role: 'worker', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 104 }),
                child({ id: 'thinking-1', creator: 'parent', role: 'worker', thinking: true }),
                child({ id: 'nested-other', creator: 'worker-1', role: 'reviewer' }),
                child({ id: 'manual-only', role: 'reviewer' }),
            ],
            resolveRoleLabel: (role, storedName) => storedName ?? ({ worker: 'Worker', reviewer: 'Reviewer' }[role] ?? role),
        });

        expect(entries).toEqual([
            expect.objectContaining({
                id: 'child_session:worker-1',
                kind: 'child_session',
                sessionId: 'worker-1',
                title: 'Windows worker',
                metaDetail: 'Worker',
                status: 'succeeded',
                isActive: false,
                startedAtMs: null,
                updatedAtMs: 101,
                endedAtMs: 101,
            }),
            expect.objectContaining({
                id: 'child_session:failed-1',
                status: 'failed',
                isActive: false,
                updatedAtMs: 102,
                endedAtMs: 102,
            }),
            expect.objectContaining({
                id: 'child_session:cancelled-1',
                status: 'cancelled',
                isActive: false,
                updatedAtMs: 103,
                endedAtMs: 103,
            }),
            expect.objectContaining({
                id: 'child_session:unknown-1',
                metaDetail: 'Release Captain',
                status: 'unknown',
                isActive: false,
                startedAtMs: null,
                updatedAtMs: null,
                endedAtMs: null,
            }),
            expect.objectContaining({
                id: 'child_session:running-1',
                status: 'running',
                isActive: true,
                updatedAtMs: 104,
                endedAtMs: null,
            }),
            expect.objectContaining({
                id: 'child_session:thinking-1',
                status: 'running',
                isActive: true,
                updatedAtMs: null,
                endedAtMs: null,
            }),
        ]);
    });
});
