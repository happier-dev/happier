import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

// Native UI adapters are replaced; workspace targeting, admission and the Files view stay real.
installSessionFilesViewCommonModuleMocks({ storage: async (importOriginal) => importOriginal() });
// Machine transport is external; qualification, storage selectors and browser effects stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: vi.fn(async () => ({ success: false, errorCode: 'BACKEND_UNAVAILABLE', error: 'offline' })),
}));
vi.mock('@/sync/ops/machineFileBrowser', () => ({
    machineFilesystemListDirectory: vi.fn(async () => ({ ok: false, error: 'offline' })),
}));
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionRepositoryTreeBrowserView unavailable target', () => {
    let previousState: ReturnType<typeof import('@/sync/domains/state/storage').storage.getState>;
    let serverId: string;

    beforeEach(async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        serverId = (await upsertAndActivateServer({ serverUrl: 'https://files-target.example.test', scope: 'device' })).id;
        previousState = storage.getState();
        const session = createSessionFixture({ id: 'files-session', serverId, metadata: { machineId: 'files-machine', path: '', host: 'files.local', homeDir: '/tmp' } });
        const machine = createMachineFixture({ id: 'files-machine', active: false });
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine },
            machineListByServerId: { [serverId]: [machine] }, sessionListRowsByServerId: {}, sessionListIndexByServerId: {},
            ordinarySessionListMembershipByServerId: {}, concurrentSessionListCacheByServerId: {} });
    });

    afterEach(async () => {
        standardCleanup();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(previousState, true);
    });

    it('does not enable workspace effects through a same-id machine on another Home', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const addressedServerId = (await upsertServerProfile({ serverUrl: 'https://missing-files-target.example.test' })).id;
        const machine = createMachineFixture({ id: 'files-machine', active: true, activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine], [addressedServerId]: [] } });
        const { WorkspaceRepositoryTreeBrowserView } = await import('@/components/projects/files/WorkspaceRepositoryTreeBrowserView');
        const { RepositoryTreeCreateMenu } = await import('@/components/workspaces/files/repositoryTree/RepositoryTreeCreateMenu');
        const screen = await renderScreen(<WorkspaceRepositoryTreeBrowserView scope={{ serverId: addressedServerId, machineId: machine.id, rootPath: '/repo' }} scmSnapshot={null} onOpenFile={() => {}} />);
        const menu = screen.findAllByType(RepositoryTreeCreateMenu)[0];
        expect(menu?.props.createEnabled).toBe(false);
        expect(menu?.props.uploadEnabled).toBe(false);
    });

    it.each([false, true])('explains unavailable Files targeting without inferring offline status (machine active: %s)', async (active) => {
        const { storage } = await import('@/sync/domains/state/storage');
        const machine = createMachineFixture({ id: 'files-machine', active });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(<SessionRepositoryTreeBrowserView sessionId="files-session" serverId={serverId} onOpenFile={() => {}} />);
        const state = screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === 'repository-tree-root-error');
        expect(state?.props).toMatchObject({ kind: 'unavailable', iconName: 'folder', reason: 'files.pane.workspaceUnavailableReason' });
        expect(state?.props.diagnosticCode).toBeUndefined();
        expect(screen.findByTestId('repository-tree-root-error-action')).toBeTruthy();
        expect(screen.findByTestId('source-control-unavailable')).toBeNull();
    });
});
