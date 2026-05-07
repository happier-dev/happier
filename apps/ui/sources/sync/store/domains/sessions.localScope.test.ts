import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

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

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };

function session(id: string) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
    };
}

function createHarness() {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        sessionMessages: {},
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

describe('sessions domain: local server/account scope', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('hydrates drafts and local metadata only for the active server account scope', () => {
        const { get, domain } = createHarness();

        expect(domain.activateSessionLocalStateScope).toBeTypeOf('function');
        domain.activateSessionLocalStateScope(scopeA);
        domain.applySessions([session('s1') as any]);
        domain.updateSessionDraft('s1', 'account A draft');
        domain.updateSessionPermissionMode('s1', 'yolo');
        domain.updateSessionModelMode('s1', 'gemini-2.5-pro');
        domain.markSessionViewed('s1');
        domain.upsertSessionReviewCommentDraft('s1', {
            id: 'comment-a',
            filePath: 'src/a.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
            body: 'account A review',
            createdAt: 1,
        });
        const actionDraft = domain.createSessionActionDraft('s1', {
            actionId: 'run-tests',
            input: { target: 'unit' },
        });

        expect(get().sessions.s1?.draft).toBe('account A draft');
        expect(get().sessions.s1?.permissionMode).toBe('yolo');
        expect(get().sessions.s1?.modelMode).toBe('gemini-2.5-pro');
        expect(get().reviewCommentsDraftsBySessionId.s1?.[0]?.body).toBe('account A review');
        expect(get().actionDraftsBySessionId.s1?.[0]?.id).toBe(actionDraft.id);
        expect(get().sessionLastViewed.s1).toBeTypeOf('number');

        domain.activateSessionLocalStateScope(scopeB);
        domain.applySessions([session('s1') as any]);

        expect(get().sessions.s1?.draft ?? null).toBeNull();
        expect(get().sessions.s1?.permissionMode).not.toBe('yolo');
        expect(get().sessions.s1?.modelMode).not.toBe('gemini-2.5-pro');
        expect(get().reviewCommentsDraftsBySessionId.s1 ?? []).toEqual([]);
        expect(get().actionDraftsBySessionId.s1 ?? []).toEqual([]);
        expect(get().sessionLastViewed.s1).toBeUndefined();

        domain.activateSessionLocalStateScope(scopeA);
        domain.applySessions([session('s1') as any]);

        expect(get().sessions.s1?.draft).toBe('account A draft');
        expect(get().sessions.s1?.permissionMode).toBe('yolo');
        expect(get().sessions.s1?.modelMode).toBe('gemini-2.5-pro');
        expect(get().reviewCommentsDraftsBySessionId.s1?.[0]?.body).toBe('account A review');
        expect(get().actionDraftsBySessionId.s1?.[0]?.id).toBe(actionDraft.id);
        expect(get().sessionLastViewed.s1).toBeTypeOf('number');
    });
});
