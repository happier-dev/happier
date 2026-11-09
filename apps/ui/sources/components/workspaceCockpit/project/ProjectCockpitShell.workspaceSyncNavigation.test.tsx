import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createWorkspaceSyncHarness, createWorkspaceSyncRelationshipsListFixture } from '@/dev/testkit/harness/workspaceSyncHarness';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resetWorkspaceSyncStatusStoreForTests, setWorkspaceSyncStatus } from '@/sync/domains/sessionHandoff/workspaceSyncStatusStore';

const routerReplace = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original, renderItems: true }).module;
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: routerReplace } }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

let refs: WorkspaceRefV1[] = [];
const policy = { v: 1 as const, selection: 'git_worktree' as const,
    extraIgnorePatterns: [], extraIncludePatterns: [],
    policyDigest: computeWorkspaceSyncPolicyDigest({ v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [] }),
};
const relationship = { v: 1 as const, relationshipId: 'link-1', controllerMachineId: 'machine-1',
    alphaWorkspaceRefId: 'wr_1', betaWorkspaceRefId: 'wr_2', mode: 'keep_both_in_sync' as const,
    contentPolicy: policy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
};

const workspace = createWorkspaceSyncHarness(request => machineRpc(request));
await workspace.ready;
const { storage } = await import('@/sync/domains/state/storage');

beforeEach(async () => {
    await workspace.reset();
    refs = [
        { id: 'wr_1', serverId: workspace.serverId, machineId: 'machine-a', rootPath: '/repo', label: 'Repo', createdAtMs: 1 },
        { id: 'wr_2', serverId: workspace.serverId, machineId: 'machine-b', rootPath: '/peer', label: 'Peer', createdAtMs: 1 },
    ];
    applyProjectAccountRowsFixture(storage, { workspaceRefs: refs,
        relationships: [{ ...relationship, controllerMachineId: 'machine-a' }] });
});
afterEach(async () => {
    standardCleanup();
    vi.unstubAllGlobals();
    await workspace.dispose();
});

describe('Project cockpit workspace sync navigation', () => {
    it('opens the real conflict row in Details and retains its comparison across companion changes', async () => {
        standardCleanup();
        resetWorkspaceSyncStatusStoreForTests();
        routerReplace.mockClear();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        setWorkspaceSyncStatus({ serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'link-1' }, {
            relationshipId: 'link-1', controllerMachineId: 'machine-a', state: 'conflicted',
            alphaPath: '/repo', betaPath: '/peer', mode: 'keep_both_in_sync',
            endpointStates: { alpha: null, beta: null }, conflictCount: 1, lastCycleObservedAtMs: 2,
        });
        machineRpc.mockImplementation(async (input: { method: string }) => {
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) return {
                status: 'page', relationshipId: 'link-1', totalCount: 1, nextCursor: null,
                conflicts: [{ relationshipId: 'link-1', path: 'src/example.ts',
                    alpha: { kind: 'file', digest: 'a'.repeat(40), size: 3 },
                    beta: { kind: 'file', digest: 'b'.repeat(40), size: 3 } }],
            };
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST) return createWorkspaceSyncRelationshipsListFixture([]);
            throw new Error(`Unexpected RPC ${input.method}`);
        });
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { ProjectCockpitShell } = await import('./ProjectCockpitShell');
        const render = (surface: 'services' | 'tabs') => <AppPaneProvider>
            <ProjectCockpitShell workspaceRef={refs[0]} scopeId="project:wr_1" activeRootPath="/repo"
                surface={surface} isFocused onSelectRootPath={vi.fn()} />
        </AppPaneProvider>;
        const screen = await renderScreen(render('tabs'));
        await screen.pressByTestIdAsync('workspace-sync-relationship-link-1-conflicts');
        await vi.waitFor(() => expect(screen.findByTestId('workspace-sync-conflict-path-list')).not.toBeNull());
        await act(async () => { await screen.update(render('tabs')); });
        expect(screen.findByTestId('workspace-sync-conflict-path-list')).not.toBeNull();
        expect(screen.getTextContent()).toContain('src/example.ts');
        await act(async () => { await screen.update(render('services')); });
        await act(async () => { await screen.update(render('tabs')); });
        expect(screen.findByTestId('workspace-sync-conflict-path-list')).not.toBeNull();
        await screen.unmount();
        vi.unstubAllGlobals();
    });
});
