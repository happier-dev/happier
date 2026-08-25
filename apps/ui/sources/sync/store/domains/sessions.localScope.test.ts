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

import { clearPersistence } from '@/sync/domains/state/persistence';
import { createSessionsDomain } from './sessions';

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

function reviewDraft(id: string, body: string) {
    return {
        id,
        filePath: 'src/a.ts',
        source: 'file' as const,
        anchor: { kind: 'fileLine' as const, startLine: 1 },
        snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
        body,
        createdAt: 1,
    };
}

function createHarness() {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListRowStateByServerId: {},
        sessionListIndexByServerId: {},
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
    set(domain as any);
    return { get, domain: domain as any };
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
        domain.updateSessionPermissionMode('s1', 'yolo');
        domain.updateSessionModelMode('s1', 'gemini-2.5-pro');
        domain.markSessionViewed('s1');
        domain.upsertSessionReviewCommentDraft('s1', reviewDraft('comment-a', 'account A review'));
        domain.upsertWorkspaceReviewCommentDraft('workspace-a', reviewDraft('workspace-comment-a', 'account A workspace review'));
        const actionDraft = domain.createSessionActionDraft('s1', {
            actionId: 'run-tests',
            input: { target: 'unit' },
        });

        expect(get().sessions.s1?.permissionMode).toBe('yolo');
        expect(get().sessions.s1?.modelMode).toBe('gemini-2.5-pro');
        expect(get().reviewCommentsDraftsBySessionId.s1?.[0]?.body).toBe('account A review');
        expect(get().reviewCommentsDraftsByWorkspaceCacheKey['workspace-a']?.[0]?.body).toBe('account A workspace review');
        expect(get().actionDraftsBySessionId.s1?.[0]?.id).toBe(actionDraft.id);
        expect(get().sessionLastViewed.s1).toBeTypeOf('number');

        domain.activateSessionLocalStateScope(scopeB);
        domain.applySessions([session('s1') as any]);

        expect(get().sessions.s1?.permissionMode).not.toBe('yolo');
        expect(get().sessions.s1?.modelMode).not.toBe('gemini-2.5-pro');
        expect(get().reviewCommentsDraftsBySessionId.s1 ?? []).toEqual([]);
        expect(get().reviewCommentsDraftsByWorkspaceCacheKey['workspace-a'] ?? []).toEqual([]);
        expect(get().actionDraftsBySessionId.s1 ?? []).toEqual([]);
        expect(get().sessionLastViewed.s1).toBeUndefined();

        domain.activateSessionLocalStateScope(scopeA);
        domain.applySessions([session('s1') as any]);

        expect(get().sessions.s1?.permissionMode).toBe('yolo');
        expect(get().sessions.s1?.modelMode).toBe('gemini-2.5-pro');
        expect(get().reviewCommentsDraftsBySessionId.s1?.[0]?.body).toBe('account A review');
        expect(get().reviewCommentsDraftsByWorkspaceCacheKey['workspace-a']?.[0]?.body).toBe('account A workspace review');
        expect(get().actionDraftsBySessionId.s1?.[0]?.id).toBe(actionDraft.id);
        expect(get().sessionLastViewed.s1).toBeTypeOf('number');
    });
});
