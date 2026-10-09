import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { clearTempData } from '@/utils/sessions/tempDataStore';
import type { WorkspaceRefV1 } from '@happier-dev/protocol';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { SESSION_CONFIG_OPTION_OVERRIDES_KEY, SESSION_MODE_OVERRIDE_KEY } from '@happier-dev/agents';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
let serverIdA: string;
let serverIdB: string;
let rows: ProjectAccountRowV1[] = [];

const routerPushSpy = vi.hoisted(() => vi.fn());
const openUniversalSearchSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => dimensions, Dimensions: { get: () => dimensions },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function SearchWrapper({ children }: React.PropsWithChildren) {
    return React.createElement(UniversalSearchRuntimeProvider, {
        value: { open: openUniversalSearchSpy, buildCommands: () => [] },
    }, children);
}

const { storage } = await import('@/sync/domains/state/storage');
await loadSyncSingletonForTests();

describe('useSessionListNavigationActions', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        await homes.reset();
        routerPushSpy.mockReset();
        openUniversalSearchSpy.mockClear();
        serverIdA = await homes.addHome({ name: 'Session list A', serverUrl: 'https://session-list-a.test', accountId: 'account-a' });
        serverIdB = await homes.addHome({ name: 'Session list B', serverUrl: 'https://session-list-b.test', accountId: 'account-a', active: false });
        rows = [];
        homes.answer(serverIdA, 'POST /v1/account/project-rows/list', { select: () => ({ body: { status: 'listed', coverage: 'complete', rows } }) });
        homes.answer(serverIdA, '/v2/cursor', { body: { cursor: '0' } });
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://session-list-a.test')!.token! });
        storage.getState().activateProjectAccountRowsScope({ serverId: serverIdA, accountId: 'account-a' });
        storage.getState().applySettingsLocal({ rememberLastProjectSessionSelections: true, mobileWorkspaceExperienceV1: 'cockpit' });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine_target' })], true, { sourceServerId: serverIdA });
        storage.setState({ sessions: {} });
        clearTempData();
        resetSessionDraftRepositoryForTests();
    });

    afterEach(async () => {
        await standardCleanup();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await homes.reset();
        clearTempData();
    });

    it('opens an existing project through its persisted mobile surface and worktree', async () => {
        const workspaceRefs: WorkspaceRefV1[] = [{
            id: 'wr_1',
            serverId: serverIdA,
            machineId: 'machine_a',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }, { id: 'wr_1', serverId: serverIdB, machineId: 'other-machine', rootPath: '/other', createdAtMs: 1 }];
        rows = workspaceRefs.map(ref => {
            const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
            return { key, revision: 1, content: { t: 'plain' as const, v: { key, value: ref } } };
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const census = await createDefaultActionExecutor().execute('projects.list', { serverId: serverIdA });
        expect(census, JSON.stringify(census)).toMatchObject({ ok: true });
        expect(storage.getState().projectAccountRows?.workspaceRefs, JSON.stringify({ census,
            profileScope: storage.getState().profileScope, snapshot: storage.getState().projectAccountRows })).toHaveLength(workspaceRefs.length);
        const key = `project-selection:v1:${JSON.stringify([serverIdA, 'wr_1'])}`;
        storage.getState().applyLocalSettings({
            projectLastMobileSurfaceByWorkspaceRefId: { [buildRealmQualifiedMobileSurfaceStorageKey('project', { serverId: serverIdA, accountId: 'account-a' }, 'wr_1')!]: 'changes' },
            projectLastActiveRootPathByWorkspaceRefId: { [key]: '/repo/.worktrees/feature' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { [key]: 'gitwt_feature' },
        });

        const { useSessionListNavigationActions } = await import('./useSessionListNavigationActions');
        const hook = await renderHook(() => useSessionListNavigationActions(), { wrapper: SearchWrapper });

        act(() => {
            hook.getCurrent().handleOpenProject('wr_1', serverIdA);
        });

        const href = new URL(routerPushSpy.mock.calls[0][0], 'https://happier.invalid');
        expect(href.pathname).toBe('/projects/wr_1/changes');
        expect(Object.fromEntries(href.searchParams)).toMatchObject({ serverId: serverIdA, worktreeId: 'gitwt_feature' });
        await hook.unmount();
    });

    it.each([
        { navigationRefused: false, managed: false },
        { navigationRefused: true, managed: false },
        { navigationRefused: true, managed: true },
    ])('retains remembered configuration durably (navigation refused: $navigationRefused, managed: $managed)', async ({ navigationRefused, managed }) => {
        if (navigationRefused) routerPushSpy.mockImplementation(() => { throw new Error('Navigation unavailable'); });
        storage.setState({ sessions: {
            seed_sess: createSessionFixture({
                id: 'seed_sess',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                encryptionMode: 'plain',
                metadata: {
                    host: 'source-host',
                    machineId: 'machine-source',
                    path: '/old/repo',
                    flavor: 'codex',
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    profileId: 'profile-1',
                    transcriptStorage: 'direct',
                    codexBackendMode: 'appServer',
                    runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
                    mcpSelectionV1: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['portable'], forceExcludeServerIds: [] },
                    connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
                    [SESSION_CONFIG_OPTION_OVERRIDES_KEY]: { v: 1, updatedAt: 101, overrides: { effort: { updatedAt: 101, value: 'high' } } },
                    [SESSION_MODE_OVERRIDE_KEY]: {
                        v: 1,
                        updatedAt: 100,
                        modeId: 'plan',
                    },
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 101,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 102,
            }),
        } });

        const { useSessionListNavigationActions } = await import('./useSessionListNavigationActions');
        const hook = await renderHook(() => useSessionListNavigationActions(), { wrapper: SearchWrapper });

        await act(async () => {
            expect(storage.getState().settings.rememberLastProjectSessionSelections).toBe(true);
            expect(storage.getState().sessions.seed_sess?.metadata?.profileId).toBe('profile-1');
            hook.getCurrent().handleCreateSessionFromWorkspaceScope(managed
                ? { kind: 'managed', serverId: serverIdA, machineId: 'machine_target' }
                : { serverId: serverIdA, machineId: 'machine_target', rootPath: '/repo' },
            { seedSessionId: 'seed_sess' });
        });

        const pushArg = routerPushSpy.mock.calls[0]?.[0];
        expect(pushArg.params.dataId).toBeUndefined();
        resetSessionDraftRepositoryForTests();
        const draft = readNewSessionDraftFromRepository({ scope: { serverId: serverIdA, accountId: 'account-a' }, draftId: pushArg.params.draftId });
        expect(draft).toEqual(expect.objectContaining({
            input: '',
            selectedMachineId: 'machine_target',
            selectedPath: managed ? null : '/repo',
            ...(managed ? { directoryKind: 'managed' } : {}),
            agentType: 'codex',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelSelection: {
                v: 1,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    modelId: 'gpt-5',
                    providerConnectionId: null,
                },
                updatedAt: 102,
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: { v: 1, updatedAt: 101, overrides: { effort: { updatedAt: 101, value: 'high' } } },
            runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
            mcpSelection: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['portable'], forceExcludeServerIds: [] },
            backendNewSessionOptionStateByTargetKey: { 'agent:happier.agent.codex/codex': {
                connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            } },
        }));

        await hook.unmount();
    });

    it('retains a durable no-folder Machine draft when navigation fails', async () => {
        routerPushSpy.mockImplementation(() => { throw new Error('Navigation unavailable'); });
        const { useSessionListNavigationActions } = await import('./useSessionListNavigationActions');
        const hook = await renderHook(() => useSessionListNavigationActions(), { wrapper: SearchWrapper });
        try {
            expect(() => act(() => hook.getCurrent().handleCreateSessionFromWorkspaceScope({ kind: 'managed', serverId: serverIdA, machineId: 'machine_target' }))).not.toThrow();
            const route = routerPushSpy.mock.calls[0]?.[0];
            resetSessionDraftRepositoryForTests();
            expect(readNewSessionDraftFromRepository({ scope: { serverId: serverIdA, accountId: 'account-a' }, draftId: route.params.draftId }))
                .toMatchObject({ selectedMachineId: 'machine_target', directoryKind: 'managed', selectedPath: null, targetServerId: serverIdA });
        } finally { await hook.unmount(); }
    });

    it('escalates through the canonical universal Search opener with a normalized query', async () => {
        const { useSessionListNavigationActions } = await import('./useSessionListNavigationActions');
        const hook = await renderHook(() => useSessionListNavigationActions({
            accountId: 'account-b',
            serverId: 'home-b',
            sessionId: null,
            machineId: null,
            rootPath: null,
        }), { wrapper: SearchWrapper });

        await act(async () => {
            hook.getCurrent().handleOpenUniversalSearch('  vector  ');
        });

        expect(openUniversalSearchSpy).toHaveBeenCalledWith('vector', {
            accountId: 'account-b',
            serverId: 'home-b',
            sessionId: null,
            machineId: null,
            rootPath: null,
        });
        expect(routerPushSpy).not.toHaveBeenCalled();

        await hook.unmount();
    });
});
