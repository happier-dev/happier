import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Boundary mock (platform storage): the sessions domain persists drafts/permission
// modes through react-native-mmkv, which has no JS implementation in vitest.
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
import { clearPersistence } from '@/sync/domains/state/persistence';
import { registerSessionTranscriptDerivedCacheClear } from '@/sync/runtime/sessionTranscriptDerivedCaches';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListIndexByServerId: {},
        sessionListRowStateByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    // Mirror store initialization behavior: domain's initial values are merged into state.
    set(domain as any);
    return { get, domain };
}

describe('sessions domain: deleteSession transcript memory release', () => {
    const unregisterFns: Array<() => void> = [];

    beforeEach(() => {
        clearPersistence();
    });

    afterEach(() => {
        while (unregisterFns.length > 0) {
            unregisterFns.pop()?.();
        }
    });

    it('clears per-session derived transcript caches through the shared release seam', () => {
        const cleared: string[] = [];
        unregisterFns.push(registerSessionTranscriptDerivedCacheClear((sessionId) => {
            cleared.push(sessionId);
        }));

        const { get, domain } = createHarness();
        domain.deleteSession('s_gone');

        expect(cleared).toEqual(['s_gone']);
        expect(get().sessionMessages.s_gone).toBeUndefined();
    });
});
