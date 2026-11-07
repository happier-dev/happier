import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSessionListRenderableFromSession } from '../../domains/session/listing/sessionListRenderable';
import { buildSessionListViewData } from '../../domains/session/listing/sessionListViewData';
import { setActiveServerId, upsertServerProfile } from '../../domains/server/serverProfiles';
import { storage } from '../../domains/state/storageStore';
import type { Session } from '../../domains/state/storageTypes';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

afterEach(() => {
    storage.setState(storage.getInitialState(), true);
    vi.unstubAllEnvs();
});

describe('session repository grouping across Homes', () => {
    it('regroups a cached inactive Home when a metadata patch identifies a linked worktree', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `repository-grouping-patches-${Math.random()}`);
        const active = upsertServerProfile({ serverUrl: 'https://active-repository.example.test' });
        const remote = upsertServerProfile({ serverUrl: 'https://remote-repository.example.test' });
        setActiveServerId(active.id, { scope: 'device' });
        const renderables = Object.fromEntries(['/repo', '/worktrees/feature'].map((path, index) => {
            const session: Session = {
                id: `repo-session-${index}`, seq: 1, createdAt: 1, updatedAt: 2,
                active: false, activeAt: 1, archivedAt: null,
                metadata: { path, machineId: 'machine-remote', host: 'remote.local' }, metadataVersion: 1,
                agentState: null, agentStateVersion: 1, thinking: false, thinkingAt: 0, presence: 1,
            };
            return [session.id, buildSessionListRenderableFromSession(session)];
        }));
        const cached = buildSessionListViewData(renderables, {}, {
            groupInactiveSessionsByProject: true, inactiveGroupingV1: 'project',
            serverScope: { serverId: remote.id },
        });
        const activeRows = storage.getState().sessionListViewData;
        storage.setState((state) => ({
            settings: { ...state.settings, sessionListInactiveGroupingV1: 'project', sessionListGroupGitWorktreesV1: true },
            sessionListViewDataByServerId: { [remote.id]: cached },
        }));
        expect(cached.filter((row) => row.type === 'header' && row.headerKind === 'project')).toHaveLength(2);

        storage.getState().applySessionListRenderablePatches([{
            sessionId: 'repo-session-1',
            patch: {
                metadataVersion: 2,
                metadata: {
                    ...renderables['repo-session-1'].metadata,
                    path: '/worktrees/feature',
                    sessionRepositoryV1: { v: 1, machineId: 'machine-remote', rootPath: '/repo', worktreePath: '/worktrees/feature' },
                },
            },
        }], remote.id);

        const next = storage.getState().sessionListViewDataByServerId[remote.id];
        expect(next?.filter((row) => row.type === 'header' && row.headerKind === 'project')).toHaveLength(1);
        expect(next?.filter((row) => row.type === 'session')).toHaveLength(2);
        expect(storage.getState().sessionListViewData).toBe(activeRows);
    });
});
