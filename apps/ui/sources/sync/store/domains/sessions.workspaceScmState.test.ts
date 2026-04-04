import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvStore = vi.hoisted(() => new Map<string, string>());
const readMachineTargetForSessionMock = vi.fn();
const resolvePreferredServerIdForSessionIdMock = vi.fn();

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

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (...args: unknown[]) => readMachineTargetForSessionMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (...args: unknown[]) => resolvePreferredServerIdForSessionIdMock(...args),
}));

import { createSessionsDomain } from './sessions';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
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

describe('sessions domain: workspace-scoped SCM state', () => {
    beforeEach(() => {
        projectManager.clear();
        readMachineTargetForSessionMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
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
        readMachineTargetForSessionMock.mockImplementation((sessionId: string) => (
            sessionId === 's1' || sessionId === 's2'
                ? { machineId: 'm1', basePath: '/repo' }
                : null
        ));
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('s');

        const { domain } = createHarness();

        domain.setSessionRepositoryTreeExpandedPaths('s1', ['src']);
        expect(domain.getSessionRepositoryTreeExpandedPaths('s2')).toEqual(['src']);
    });

    it('preserves workspace repository tree expansion when deleting one session from that workspace', () => {
        readMachineTargetForSessionMock.mockImplementation((sessionId: string) => (
            sessionId === 's1' || sessionId === 's2'
                ? { machineId: 'm1', basePath: '/repo' }
                : null
        ));
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('s');

        const { domain, get } = createHarness();
        const state = get();
        state.sessions = {
            s1: { id: 's1' } as any,
            s2: { id: 's2' } as any,
        };
        state.sessionListRenderables = {
            s1: { id: 's1' } as any,
            s2: { id: 's2' } as any,
        };

        domain.setSessionRepositoryTreeExpandedPaths('s1', ['src']);
        domain.deleteSession('s1');

        expect(domain.getWorkspaceRepositoryTreeExpandedPaths({ serverId: 's', machineId: 'm1', rootPath: '/repo' })).toEqual(['src']);
        expect(domain.getSessionRepositoryTreeExpandedPaths('s2')).toEqual(['src']);
    });
});
