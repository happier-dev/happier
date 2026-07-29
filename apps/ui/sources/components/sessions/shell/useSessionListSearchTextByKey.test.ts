import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

import { createSessionListSearchTextSelector } from './useSessionListSearchTextByKey';

function createRenderable(
    overrides: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    return {
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

function createState(overrides: Partial<StorageState>): StorageState {
    return {
        sessions: {},
        sessionListRenderables: {},
        sessionListRowStateByServerId: {},
        sessionMessages: {},
        sessionPending: {},
        ...overrides,
    } as StorageState;
}

describe('createSessionListSearchTextSelector', () => {
    it('reuses cached text without reading rows on an empty session-list delta tick', () => {
        let metadataReads = 0;
        const renderable = createRenderable({ id: 'session1' });
        Object.defineProperty(renderable, 'metadata', {
            configurable: true,
            enumerable: true,
            get: () => {
                metadataReads += 1;
                return { name: 'Build lane', path: '/repo' };
            },
        });
        const sessionListRenderables = { session1: renderable };
        const selector = createSessionListSearchTextSelector([
            { type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined },
        ], true);

        const first = selector(createState({
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['session1'],
                removedSessionIds: [],
                rebuiltSessionListIndex: true,
            },
            sessionListRenderables,
        }));
        const readsAfterFirstSelection = metadataReads;

        const second = selector(createState({
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: [],
                removedSessionIds: [],
                rebuiltSessionListIndex: false,
            },
            sessionListRenderables,
        }));

        expect(second).toBe(first);
        expect(second['server1:session1']).toContain('Build lane');
        expect(metadataReads).toBe(readsAfterFirstSelection);
    });

    it('indexes private layout-v1 workspace fields from the owner view, not shared metadata', () => {
        const selector = createSessionListSearchTextSelector([
            { type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined },
        ], true);
        const session: Session = {
            id: 'session1',
            seq: 0,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
            metadataLayoutVersion: 1,
            metadata: {
                host: '',
                path: '/must-not-index',
                summary: {
                    text: 'Shared title',
                    updatedAt: 1,
                },
            },
            ownerMetadataView: {
                name: 'Private session',
                path: '/private/repo',
                host: 'private-host',
                machineId: 'private-machine',
            },
        };
        const result = selector(createState({
            sessions: {
                session1: session,
            },
        }));

        expect(result['server1:session1']).toContain('/private/repo');
        expect(result['server1:session1']).not.toContain('/must-not-index');
    });
});
