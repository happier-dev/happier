import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { filterSessionListIndexByStorageKind } from './filterSessionListIndexByStorageKind';

function makeSessionRow(id: string, direct: boolean): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: direct ? {
            path: '',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        } : { path: '' },
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
    };
}

function makeResolver(rowsByKey: Record<string, SessionListRenderableSession>) {
    return (serverId: string | null | undefined, sessionId: string) => {
        const key = `${String(serverId ?? '').trim()}:${String(sessionId ?? '').trim()}`;
        return rowsByKey[key] ?? null;
    };
}

describe('filterSessionListIndexByStorageKind', () => {
    it('returns the original array for storageKind=all', () => {
        const source: SessionListIndexItem[] = [
            { type: 'session', sessionId: 's1', serverId: 'server-a' },
        ];

        const result = filterSessionListIndexByStorageKind(source, 'all');

        expect(result).toBe(source);
    });

    it('filters sessions by kind and prunes orphan headers', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', title: 'Server A', headerKind: 'server', serverId: 'server-a', serverName: 'Server A' },
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1', serverId: 'server-a' },
            { type: 'session', sessionId: 'direct-1', serverId: 'server-a', groupKey: 'g1' },
            { type: 'session', sessionId: 'persisted-1', serverId: 'server-a', groupKey: 'g1' },
        ];

        const result = filterSessionListIndexByStorageKind(source, 'direct', makeResolver({
            'server-a:direct-1': makeSessionRow('direct-1', true),
            'server-a:persisted-1': makeSessionRow('persisted-1', false),
        }))!;

        expect(result.map((item) => (item.type === 'session' ? item.sessionId : `${item.headerKind}:${item.title}`))).toEqual([
            'server:Server A',
            'date:Today',
            'direct-1',
        ]);
    });

    it('uses indexed storageKind without requiring legacy row state', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1', serverId: 'server-a' },
            { type: 'session', sessionId: 'persisted-1', serverId: 'server-a', groupKey: 'g1', storageKind: 'persisted' },
            { type: 'session', sessionId: 'direct-1', serverId: 'server-a', groupKey: 'g1', storageKind: 'direct' },
        ];

        const result = filterSessionListIndexByStorageKind(source, 'persisted', () => {
            throw new Error('storageKind-bearing index items must not require legacy row resolution');
        })!;

        expect(result).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'persisted-1', storageKind: 'persisted' }),
        ]);
    });

    it('reuses the same empty result when filtering removes every session', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1', serverId: 'server-a' },
            { type: 'session', sessionId: 'persisted-1', serverId: 'server-a', groupKey: 'g1' },
        ];

        const first = filterSessionListIndexByStorageKind(source, 'direct');
        const second = filterSessionListIndexByStorageKind(source, 'direct');

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });

    it('keeps a converted external-history row in all and Happier views but out of External', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1', serverId: 'server-a' },
            { type: 'session', sessionId: 'converted-1', serverId: 'server-a', groupKey: 'g1' },
        ];
        const converted = {
            ...makeSessionRow('converted-1', false),
            metadata: {
                path: '/repo',
                externalHistoryImportV1: { v: 1, importedAt: 1_000 },
            },
        };
        const resolve = makeResolver({ 'server-a:converted-1': converted });

        expect(filterSessionListIndexByStorageKind(source, 'all', resolve)).toBe(source);
        expect(filterSessionListIndexByStorageKind(source, 'persisted', resolve))
            .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'session', sessionId: 'converted-1' })]));
        expect(filterSessionListIndexByStorageKind(source, 'direct', resolve)).toEqual([]);
    });
});
