import * as React from 'react';
import { newSessionBackgroundLaunches } from '@/components/sessions/new/modules/newSessionBackgroundLaunches';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const push = vi.hoisted(() => vi.fn());
const routeBoundary = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => routeBoundary.params,
    router: { push },
}).module);
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
const { setActiveUnsavedChangesGuard, clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
type UnsavedChangesDecision = import('@/utils/ui/promptUnsavedChangesAlert').UnsavedChangesDecision;
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
        settings: { ...state.settings, rememberLastProjectSessionSelections: true, newSessionPresentationModeV1: 'auto' } }));
    push.mockReset();
    routeBoundary.params = {};
});
afterEach(async () => { clearActiveUnsavedChangesGuard(); standardCleanup(); await disconnectActiveServerConnection(); vi.unstubAllGlobals(); });

describe('ordinary authoring adapters', () => {
    it('opens media in the New Session route host while preserving the displayed Session draft', async () => {
        const { openOrdinaryNewSessionSeed } = await import('@/components/sessions/new/newSessionSeedNavigation');
        const { useNewSessionHostNavigation, useNewSessionHostParams } = await import('@/components/sessions/new/navigation/newSessionHost');
        const { createExistingSessionComposerDocumentOwner } = await import('@/components/sessions/composer/existingSessionComposerDocumentOwner');
        const { createNewSessionComposerDocumentOwner } = await import('@/components/sessions/composer/newSessionComposerDocumentOwner');
        const { readNewSessionAttachmentDrafts } = await import('@/components/sessions/new/attachments/newSessionAttachmentDraftStore');
        const { resolveNewSessionDraftAttachmentFlowId } = await import('@/components/sessions/new/attachments/newSessionDraftAttachmentFlowId');
        const scope = { serverId, accountId: 'account-a' };
        const existing = createExistingSessionComposerDocumentOwner({ scope, ref: { kind: 'session', sessionId: 'session-x' } });
        existing.replaceDocument({ text: 'Keep this draft', structuredInputMentions: [], composerAttachments: [] });
        const before = existing.read().document;
        // Expo is the external boundary: a modal push retains the Session route below it.
        const routes: unknown[] = ['/session/session-x'];
        push.mockImplementation((href: { pathname: string; params: Record<string, string> }) => {
            routes.push(href);
            routeBoundary.params = href.params;
        });
        const outcome = await openOrdinaryNewSessionSeed({ seed: {}, scope, isCurrent: () => true,
            media: { items: [{ kind: 'image', source: { kind: 'memory', bytes: new Uint8Array([137, 80, 78, 71]), name: 'capture.png', mimeType: 'image/png' } }],
                note: 'Inspect this clipping', windowText: { name: 'Window text.txt', text: 'Window contents' } } });
        expect(outcome.kind).toBe('opened');
        if (outcome.kind !== 'opened') throw new Error('Expected an opened New Session');
        const hook = await renderHook(() => ({
            params: useNewSessionHostParams(),
            navigation: useNewSessionHostNavigation(),
        }));
        try {
            expect(routes).toEqual(['/session/session-x', { pathname: '/new', params: {
                draftId: outcome.draftId, draftServerId: scope.serverId, draftAccountId: scope.accountId,
            } }]);
            expect(hook.getCurrent().navigation.embedded).toBe(false);
            expect(hook.getCurrent().params.draftId).toBe(outcome.draftId);
            const composer = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', instanceId: outcome.draftId } });
            expect(composer.read().document.text).toContain('Inspect this clipping');
            expect(readNewSessionDraftFromRepository({ scope, draftId: outcome.draftId })?.input).toContain('Inspect this clipping');
            expect(readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(outcome.draftId))).toHaveLength(2);
            expect(existing.read().document).toEqual(before);
        } finally { await hook.unmount(); }
    });

    it('keeps one composed Docked draft through page navigation, picker return and in-place send settlement', async () => {
        const { NewSessionShellHostProvider, useNewSessionShellHost, interceptNewSessionEntry } = await import('@/components/sessions/new/navigation/newSessionEntry');
        const { NewSessionEmbeddedHostProvider, useNewSessionHostNavigation, useNewSessionHostParams } = await import('@/components/sessions/new/navigation/newSessionHost');
        const { setNewSessionPickerReturnParams } = await import('@/components/sessions/new/navigation/setNewSessionPickerReturnParams');
        const { renderScreen } = await import('@/dev/testkit');
        const { act } = await import('react-test-renderer');
        function HostProbe() {
            const navigation = useNewSessionHostNavigation();
            const params = useNewSessionHostParams();
            return React.createElement('HostProbe', { params, ...navigation });
        }
        function ShellContent(props: Readonly<{ background: string }>) {
            const shell = useNewSessionShellHost();
            return React.createElement(React.Fragment, null,
                React.createElement('ShellProbe', { shell, background: props.background }),
                shell && React.createElement(NewSessionEmbeddedHostProvider, { host: shell.host, children: React.createElement(HostProbe) }));
        }
        function Composition(props: Readonly<{ background: string }>) {
            return React.createElement(NewSessionShellHostProvider, null, React.createElement(ShellContent, props));
        }
        const screen = await renderScreen(React.createElement(Composition, { background: '/projects/project-one' }));
        const shell = () => screen.tree.root.findByType('ShellProbe' as never).props.shell as NonNullable<ReturnType<typeof useNewSessionShellHost>>;
        const host = () => screen.tree.root.findByType('HostProbe' as never).props as {
            params: import('@/components/sessions/new/navigation/newSessionHost').NewSessionHostParams;
            router: ReturnType<typeof useNewSessionHostNavigation>['router'];
            navigation: ReturnType<typeof useNewSessionHostNavigation>['navigation'];
        };
        await act(async () => {
            getStorage().getState().applySettingsLocal({ newSessionPresentationModeV1: 'docked' });
        });
        expect(shell().enabled).toBe(true);
        await act(async () => {
            shell().open(undefined, true);
        });
        await act(async () => {
            host().router.setParams({ directory: '/authored/project', prompt: 'Keep this prompt', machineId: 'authored-machine' });
        });
        const authored = host().params;
        await act(async () => { expect(interceptNewSessionEntry('/new')).toBe(true); });
        expect(host().params).toEqual(authored);
        const draftId = authored.draftId;
        if (typeof draftId !== 'string') throw new Error('Expected the composed Docked draft');
        await screen.update(React.createElement(Composition, { background: '/settings/appearance' }));
        expect(host().params).toEqual(authored);
        await act(async () => {
            expect(setNewSessionPickerReturnParams({ navigation: host().navigation, router: host().router,
                currentParams: { newSessionHostDraftId: draftId }, routeParams: { machineId: 'picked-machine' },
                returnToHost: shell().returnToHost })).toBe('dispatch');
        });
        expect(host().params).toMatchObject({ draftId, directory: '/authored/project', prompt: 'Keep this prompt', machineId: 'picked-machine' });
        await act(async () => { host().router.replace('/session/created'); });
        expect(newSessionBackgroundLaunches.read().latest).toEqual({ kind: 'started', href: '/session/created' });
        expect(shell().visible).toBe(true);
        expect(host().params.draftId).not.toBe(draftId);
        expect(screen.tree.root.findByType('ShellProbe' as never).props.background).toBe('/settings/appearance');
        expect(push).not.toHaveBeenCalled();
    });

    it('opens the seeded Plugin draft in the Docked host with its editable machine, directory and prompt', async () => {
        const { NewSessionShellHostProvider, useNewSessionShellHost } = await import('@/components/sessions/new/navigation/newSessionEntry');
        const { act } = await import('react-test-renderer');
        const hook = await renderHook(() => ({
            open: usePluginAuthoringSession({ serverId, machineId: 'docked-plugin-machine' }),
            shell: useNewSessionShellHost(),
        }), { wrapper: NewSessionShellHostProvider });
        await act(async () => {
            getStorage().getState().applySettingsLocal({ newSessionPresentationModeV1: 'docked' });
        });
        expect(hook.getCurrent().shell?.enabled).toBe(true);
        await act(async () => {
            hook.getCurrent().open({ promptText: 'Edit the Docked plugin', sessionDirectory: '/plugins/docked' });
        });
        const shell = hook.getCurrent().shell;
        expect(shell?.visible).toBe(true);
        expect(push).not.toHaveBeenCalled();
        const draftId = shell?.host.params.draftId;
        expect(typeof draftId).toBe('string');
        if (typeof draftId !== 'string') throw new Error('Expected the seeded Docked draft');
        expect(readNewSessionDraftFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId }))
            .toMatchObject({ input: 'Edit the Docked plugin', selectedPath: '/plugins/docked',
                executionTarget: { kind: 'machine', target: { serverId, machineId: 'docked-plugin-machine' } } });
        expect(Object.keys(getStorage().getState().sessions)).toHaveLength(0);
    });

    it('routes imperative seeds, source continuations and saved-draft reopening through the same Docked host', async () => {
        const { NewSessionShellHostProvider, useNewSessionShellHost } = await import('@/components/sessions/new/navigation/newSessionEntry');
        const { openOrdinaryNewSessionSeed } = await import('@/components/sessions/new/newSessionSeedNavigation');
        const { navigateToSavedNewSessionDraft } = await import('@/components/sessions/drafts/newSessionDraftNavigation');
        const { openNewSessionSourceContextNavigation } = await import('@/components/sessions/new/navigation/newSessionSourceContextNavigation');
        const { act } = await import('react-test-renderer');
        const scope = { serverId, accountId: 'account-a' };
        const hook = await renderHook(useNewSessionShellHost, { wrapper: NewSessionShellHostProvider });
        await act(async () => {
            getStorage().getState().applySettingsLocal({ newSessionPresentationModeV1: 'docked' });
        });
        expect(hook.getCurrent()?.enabled).toBe(true);
        await act(async () => {
            const outcome = await openOrdinaryNewSessionSeed({ seed: { prompt: 'An admitted Action seed' }, scope, isCurrent: () => true });
            expect(outcome.kind).toBe('opened');
        });
        const seededDraftId = hook.getCurrent()?.host.params.draftId;
        expect(typeof seededDraftId).toBe('string');
        if (typeof seededDraftId !== 'string') throw new Error('Expected the imperative seeded draft');
        expect(hook.getCurrent()?.visible).toBe(true);
        expect(readNewSessionDraftFromRepository({ scope, draftId: seededDraftId })).toMatchObject({ input: 'An admitted Action seed' });

        getStorage().getState().applySessions([createSessionFixture({ id: 'source-session', serverId, metadata: { path: '/repo', host: 'dev', machineId: 'source-machine', flavor: 'codex' } })]);
        const fallback = vi.fn();
        await act(async () => {
            const outcome = await openNewSessionSourceContextNavigation({
                sourceSessionId: 'source-session', forkPoint: { type: 'latest' }, serverId,
                restoredDraftText: 'Continue the source', navigateToNewSession: fallback });
            expect(outcome.kind).toBe('opened');
        });
        const sourceDraftId = hook.getCurrent()?.host.params.draftId;
        expect(typeof sourceDraftId).toBe('string');
        if (typeof sourceDraftId !== 'string') throw new Error('Expected the source continuation draft');
        expect(sourceDraftId).not.toBe(seededDraftId);
        expect(hook.getCurrent()?.host.params.dataId).toEqual(expect.any(String));
        expect(readNewSessionDraftFromRepository({ scope, draftId: sourceDraftId })).toMatchObject({ input: 'Continue the source' });
        expect(fallback).not.toHaveBeenCalled();

        await act(async () => {
            expect(await navigateToSavedNewSessionDraft(seededDraftId, scope, () => true)).toBe(true);
        });
        expect(hook.getCurrent()?.host.params).toMatchObject({ draftId: seededDraftId, draftServerId: serverId, draftAccountId: 'account-a' });
        expect(readNewSessionDraftFromRepository({ scope, draftId: seededDraftId })).toMatchObject({ input: 'An admitted Action seed' });
        await act(async () => {
            expect(await navigateToSavedNewSessionDraft(seededDraftId, { serverId: 'other-home', accountId: 'account-b' }, () => true)).toBe(true);
        });
        expect(hook.getCurrent()?.host.params).toMatchObject({ draftId: seededDraftId,
            draftServerId: 'other-home', draftAccountId: 'account-b', spawnServerId: 'other-home' });
        expect(push).not.toHaveBeenCalled();
    });

    it('opens one editable Plugin draft with the exact administration target and daemon directory, without spawning', async () => {
        const scope = { serverId, accountId: 'account-a' };
        const hook = await renderHook(() => usePluginAuthoringSession({ serverId, machineId: 'admin-machine' }));
        const existingDraftCount = listNewSessionDraftProjections(scope).length;
        await hook.getCurrent()({ promptText: 'Edit this plugin', sessionDirectory: '/plugins/canonical-directory' });
        expect(push).toHaveBeenCalledOnce();
        const route = push.mock.calls[0][0] as { params: { draftId: string } };
        expect(readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId })).toMatchObject({
            input: 'Edit this plugin', selectedPath: '/plugins/canonical-directory',
            executionTarget: { kind: 'machine', target: { serverId, machineId: 'admin-machine' } },
        });
        expect(listNewSessionDraftProjections(scope)).toHaveLength(existingDraftCount + 1);
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
        await capturedOpen({ promptText: 'Late prepared plugin', sessionDirectory: '/plugins/prepared-for-a' });
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
        await capturedOpen('configureAcpBackend');
        expect(push).not.toHaveBeenCalled();
        expect(listNewSessionDraftProjections(scope)).toEqual(draftsBefore);
    });

    it('keeps Agent authoring editable on its selected machine with no Session before Send', async () => {
        const hook = await renderHook(() => useOpenAgentAuthoringSession({ serverId, machineId: 'agent-machine' }));
        await hook.getCurrent()('configureAcpBackend');
        const route = push.mock.calls.at(-1)?.[0] as { params: { draftId: string } };
        expect(readNewSessionDraftFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: route.params.draftId }))
            .toMatchObject({ input: 'settingsAgents.authoring.configureAcpBackendPrompt',
                executionTarget: { kind: 'machine', target: { serverId, machineId: 'agent-machine' } } });
        expect(Object.keys(getStorage().getState().sessions)).toHaveLength(0);
    });

    it.each(['keepEditing', 'discard'] as const)('settles the real Agent dirty decision before any draft write (%s)', async (decision) => {
        const pending = createDeferred<UnsavedChangesDecision>();
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: () => pending.promise, tag: 'agent-authoring-test' });
        const hook = await renderHook(() => useOpenAgentAuthoringSession({ serverId, machineId: 'agent-machine' }));
        const scope = { serverId, accountId: 'account-a' };
        const before = structuredClone(listNewSessionDraftProjections(scope));
        const opening = hook.getCurrent()('addAgent');
        expect(listNewSessionDraftProjections(scope)).toEqual(before);
        expect(push).not.toHaveBeenCalled();
        pending.resolve(decision);
        await opening;
        await Promise.resolve();
        if (decision === 'keepEditing') {
            expect(listNewSessionDraftProjections(scope)).toEqual(before);
            expect(push).not.toHaveBeenCalled();
        } else {
            expect(listNewSessionDraftProjections(scope)).toHaveLength(before.length + 1);
            expect(push).toHaveBeenCalledOnce();
            const route = push.mock.calls[0][0] as { params: { draftId: string } };
            expect(readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId })).toMatchObject({
                input: 'settingsAgents.authoring.addAgentPrompt',
                executionTarget: { kind: 'machine', target: { serverId, machineId: 'agent-machine' } },
            });
        }
    });

    it.each(['target', 'account', 'unmount'] as const)('refuses accepted Agent navigation when its %s retires during the dirty decision', async (retirement) => {
        const pending = createDeferred<UnsavedChangesDecision>();
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: () => pending.promise, tag: 'agent-authoring-test' });
        const hook = await renderHook((target: { serverId: string; machineId: string }) => useOpenAgentAuthoringSession(target), {
            initialProps: { serverId, machineId: 'agent-machine' },
        });
        const scopes = ['account-a', 'account-b'].map(accountId => ({ serverId, accountId }));
        const before = scopes.map(scope => structuredClone(listNewSessionDraftProjections(scope)));
        const opening = hook.getCurrent()('configureAcpBackend');
        if (retirement === 'target') await hook.rerender({ serverId, machineId: 'other-machine' });
        else if (retirement === 'unmount') await hook.unmount();
        else getStorage().setState({ profileScope: { serverId, accountId: 'account-b' } });
        pending.resolve('discard');
        await opening;
        await Promise.resolve();
        expect(scopes.map(scope => listNewSessionDraftProjections(scope))).toEqual(before);
        expect(push).not.toHaveBeenCalled();
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
        await hook.getCurrent().handleCreateSessionFromWorkspaceScope({ serverId, machineId: 'workspace-machine', rootPath: '/repo' });
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
        await hook.getCurrent().handleCreateSessionFromWorkspaceScope({ serverId, machineId: 'workspace-machine', rootPath: '/agent/repo' },
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
