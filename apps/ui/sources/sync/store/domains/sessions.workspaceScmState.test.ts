import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvStore = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }
        set(key: string, value: string) {
            mmkvStore.set(key, value);
        }
        delete(key: string) {
            mmkvStore.delete(key);
        }
        clearAll() {
            mmkvStore.clear();
        }
    }
    return { MMKV };
});

import { createSessionsDomain } from './sessions';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {},
        reviewCommentsDraftsBySessionId: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        profile: { id: 'p1' },
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    set(domain as any);
    return { get, domain };
}

function seedWorkspaceSessions(state: any, sessionIds: string[]) {
    state.machines = {
        m1: {
            id: 'm1',
            active: true,
            metadata: {},
        },
    };
    state.sessionListIndexByServerId = {
        s: sessionIds.map((sessionId) => ({
            type: 'session',
            sessionId,
            serverId: 's',
            serverName: 'Server',
        })),
    };
    state.sessions = Object.fromEntries(sessionIds.map((sessionId) => [
        sessionId,
        {
            id: sessionId,
            serverId: 's',
            metadata: {
                machineId: 'm1',
                path: '/repo',
            },
        },
    ]));
    state.sessionListRenderables = Object.fromEntries(sessionIds.map((sessionId) => [
        sessionId,
        {
            id: sessionId,
            metadata: {
                machineId: 'm1',
                path: '/repo',
            },
        } satisfies Partial<SessionListRenderableSession>,
    ]));
}

describe('sessions domain: workspace-scoped SCM state', () => {
    beforeEach(() => {
        projectManager.clear();
    });

    it('exposes workspace-scoped touched paths without a sessionId', () => {
        const { domain } = createHarness();

        const scope = { serverId: 's', machineId: 'm1', rootPath: '/repo' };
        domain.markWorkspaceScmTouchedPaths(scope, ['a.ts'], 10);
        expect(domain.getWorkspaceScmTouchedPaths(scope)).toEqual(['a.ts']);
    });

    it('stores repository tree expansion by workspace cache key', () => {
        const { domain } = createHarness();

        const scope = { serverId: 's', machineId: 'm1', rootPath: '/repo' };
        expect(domain.getWorkspaceRepositoryTreeExpandedPaths(scope)).toEqual([]);

        domain.setWorkspaceRepositoryTreeExpandedPaths(scope, ['src', 'src/components']);
        expect(domain.getWorkspaceRepositoryTreeExpandedPaths(scope)).toEqual(['src', 'src/components']);

        domain.clearWorkspaceRepositoryTreeExpandedPaths(scope);
        expect(domain.getWorkspaceRepositoryTreeExpandedPaths(scope)).toEqual([]);
    });

    it('shares repository tree expansion across sessions in the same workspace', () => {
        const { domain, get } = createHarness();
        seedWorkspaceSessions(get(), ['s1', 's2']);

        domain.setSessionRepositoryTreeExpandedPaths('s1', ['src']);
        expect(domain.getSessionRepositoryTreeExpandedPaths('s2')).toEqual(['src']);
    });

    it('preserves workspace repository tree expansion when deleting one session from that workspace', () => {
        const { domain, get } = createHarness();
        const state = get();
        seedWorkspaceSessions(state, ['s1', 's2']);

        domain.setSessionRepositoryTreeExpandedPaths('s1', ['src']);
        domain.deleteSession('s1');

        expect(domain.getWorkspaceRepositoryTreeExpandedPaths({ serverId: 's', machineId: 'm1', rootPath: '/repo' })).toEqual(['src']);
        expect(domain.getSessionRepositoryTreeExpandedPaths('s2')).toEqual(['src']);
    });
});
