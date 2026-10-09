import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push } }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { renderHook, standardCleanup, createSessionFixture, createMachineFixture } = await import('@/dev/testkit');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { listNewSessionDraftProjections, resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { usePluginAuthoringSession } = await import('./usePluginAuthoringSession');
const { useOpenAgentAuthoringSession } = await import('@/components/settings/agents/authoring/agentAuthoringSession');
const { handleSourceControlBranchMenuSelect } = await import('@/components/sessions/sourceControl/branches/handleSourceControlBranchMenuSelect');
const { useSessionListNavigationActions } = await import('@/components/sessions/shell/useSessionListNavigationActions');
const { UniversalSearchRuntimeProvider } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');

let serverId: string;
beforeEach(async () => {
    await home.reset();
    resetSessionDraftRepositoryForTests();
    await prepareSessionDraftPersistenceStorage();
    serverId = await home.addHome({ serverUrl: 'https://authoring.test', name: 'Authoring', accountId: 'account-a' });
    home.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://authoring.test');
    if (!credentials) throw new Error('Expected signed-in Home');
    await restoreConnectionToActiveServer(credentials);
    getStorage().setState((state) => ({ profileScope: { serverId, accountId: 'account-a' }, sessions: {}, machines: {},
        settings: { ...state.settings, rememberLastProjectSessionSelections: true } }));
    push.mockClear();
});
afterEach(async () => { standardCleanup(); await disconnectActiveServerConnection(); vi.unstubAllGlobals(); });

describe('ordinary authoring adapters', () => {
    it('opens one editable Plugin draft with the exact administration target and daemon directory, without spawning', async () => {
        const hook = await renderHook(() => usePluginAuthoringSession({ serverId, machineId: 'admin-machine' }));
        hook.getCurrent()({ promptText: 'Edit this plugin', sessionDirectory: '/plugins/canonical-directory' });
        expect(push).toHaveBeenCalledOnce();
        const route = push.mock.calls[0][0] as { params: { draftId: string } };
        const scope = { serverId, accountId: 'account-a' };
        expect(readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId })).toMatchObject({
            input: 'Edit this plugin', selectedPath: '/plugins/canonical-directory',
            executionTarget: { kind: 'machine', target: { serverId, machineId: 'admin-machine' } },
        });
        expect(listNewSessionDraftProjections(scope)).toHaveLength(1);
        expect(Object.keys(getStorage().getState().sessions)).toHaveLength(0);
    });

    it.each(['target', 'account'] as const)('refuses a captured Plugin continuation after its %s retires', async (retirement) => {
        const hook = await renderHook((target: { serverId: string; machineId: string }) => usePluginAuthoringSession(target), {
            initialProps: { serverId, machineId: 'admin-machine' },
        });
        const capturedOpen = hook.getCurrent();
        if (retirement === 'target') await hook.rerender({ serverId, machineId: 'other-machine' });
        else getStorage().setState({ profileScope: { serverId, accountId: 'account-b' } });
        // Resetting the in-memory repository does not discard durable drafts from earlier entries.
        const scopes = ['account-a', 'account-b'].map((accountId) => ({ serverId, accountId }));
        const draftsBefore = scopes.map((scope) => structuredClone(listNewSessionDraftProjections(scope)));
        capturedOpen({ promptText: 'Late prepared plugin', sessionDirectory: '/plugins/prepared-for-a' });
        expect(push).not.toHaveBeenCalled();
        expect(scopes.map((scope) => listNewSessionDraftProjections(scope))).toEqual(draftsBefore);
    });

    it('refuses a captured Agent entry after the administration target changes', async () => {
        const hook = await renderHook((target: { serverId: string; machineId: string }) => useOpenAgentAuthoringSession(target), {
            initialProps: { serverId, machineId: 'admin-machine' },
        });
        const capturedOpen = hook.getCurrent();
        await hook.rerender({ serverId, machineId: 'other-machine' });
        const scope = { serverId, accountId: 'account-a' };
        const draftsBefore = structuredClone(listNewSessionDraftProjections(scope));
        capturedOpen('configureAcpBackend');
        expect(push).not.toHaveBeenCalled();
        expect(listNewSessionDraftProjections(scope)).toEqual(draftsBefore);
    });

    it('keeps Agent authoring editable on its selected machine with no Session before Send', async () => {
        const hook = await renderHook(() => useOpenAgentAuthoringSession({ serverId, machineId: 'agent-machine' }));
        hook.getCurrent()('configureAcpBackend');
        const route = push.mock.calls.at(-1)?.[0] as { params: { draftId: string } };
        expect(readNewSessionDraftFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: route.params.draftId }))
            .toMatchObject({ input: 'settingsAgents.authoring.configureAcpBackendPrompt',
                executionTarget: { kind: 'machine', target: { serverId, machineId: 'agent-machine' } } });
        expect(Object.keys(getStorage().getState().sessions)).toHaveLength(0);
    });

    it('opens a branch-selection draft on the exact source Machine without creating a worktree or Session', async () => {
        const createWorktree = vi.fn(async () => {});
        await handleSourceControlBranchMenuSelect({
            itemId: 'worktree:create-from-another-branch', closeMenu: () => {},
            createWorktreeFromCurrentBranch: createWorktree, directoryFallback: '/repo/packages/app',
            machineTarget: { machineId: 'source-machine', basePath: '/repo/packages/app' },
            targetServerId: serverId, openNewSessionForDirectory: () => {}, pruneWorktrees: async () => {},
            removeWorktree: async () => {}, router: (await import('expo-router')).router,
            setIncludeRemotes: () => {}, setOpen: () => {}, switchBranch: async () => {},
        });
        const route = push.mock.calls.at(-1)?.[0] as { pathname: string; params: { draftId: string; worktree: string } };
        expect(route).toMatchObject({ pathname: '/new', params: { worktree: 'new' } });
        expect(readNewSessionDraftFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: route.params.draftId }))
            .toMatchObject({ selectedPath: '/repo/packages/app',
                executionTarget: { kind: 'machine', target: { serverId, machineId: 'source-machine' } } });
        expect(createWorktree).not.toHaveBeenCalled();
        expect(Object.keys(getStorage().getState().sessions)).toHaveLength(0);
    });

    it('persists a Session-list placement draft without creating a parallel configuration handoff', async () => {
        const hook = await renderHook(() => useSessionListNavigationActions(), {
            wrapper: ({ children }) => React.createElement(UniversalSearchRuntimeProvider, {
                value: { open: () => {}, buildCommands: () => [] },
            }, children),
        });
        hook.getCurrent().handleCreateSessionFromWorkspaceScope({ serverId, machineId: 'workspace-machine', rootPath: '/repo' });
        const route = push.mock.calls.at(-1)?.[0] as { params: { draftId: string; dataId?: string } };
        expect(route.params.dataId).toBeUndefined();
        expect(readNewSessionDraftFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: route.params.draftId }))
            .toMatchObject({ selectedPath: '/repo',
                executionTarget: { kind: 'machine', target: { serverId, machineId: 'workspace-machine' } } });
        expect(Object.keys(getStorage().getState().sessions)).toHaveLength(0);
    });

    it('uses the Session control directory without cloning configuration when remembering selections is disabled', async () => {
        home.answer(serverId, 'GET /v2/account/settings', { body: {
            content: { t: 'plain', v: { rememberLastProjectSessionSelections: false } }, version: 1,
        } });
        getStorage().getState().applySettingsLocal({ rememberLastProjectSessionSelections: false });
        const source = createSessionFixture({ id: 'source-session', serverId, metadataLayoutVersion: 1,
            ownerMetadataView: { ...createSessionFixture().metadata!, machineId: 'workspace-machine', path: '/agent/repo',
                profileId: 'source-profile',
                sessionWorkspaceLocationV1: { v: 1, machineId: 'workspace-machine',
                    agentPath: '/agent/repo', machinePath: '/machine/repo' } } });
        getStorage().setState({ sessions: { [source.id]: source },
            machines: { 'workspace-machine': createMachineFixture({ id: 'workspace-machine' }) } });
        const hook = await renderHook(() => useSessionListNavigationActions(), {
            wrapper: ({ children }) => React.createElement(UniversalSearchRuntimeProvider, {
                value: { open: () => {}, buildCommands: () => [] },
            }, children),
        });
        expect(getStorage().getState().settings.rememberLastProjectSessionSelections).toBe(false);
        hook.getCurrent().handleCreateSessionFromWorkspaceScope({ serverId, machineId: 'workspace-machine', rootPath: '/agent/repo' },
            { seedSessionId: source.id });
        const route = push.mock.calls.at(-1)?.[0] as { params: { draftId: string; dataId?: string } };
        expect(route.params.draftId).toEqual(expect.any(String));
        expect(route.params.dataId).toBeUndefined();
        expect(readNewSessionDraftFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: route.params.draftId }))
            .toMatchObject({ selectedPath: '/machine/repo', selectedProfileId: null,
                executionTarget: { kind: 'machine', target: { serverId, machineId: 'workspace-machine' } } });
        expect(Object.keys(getStorage().getState().sessions)).toEqual([source.id]);
    });
});
