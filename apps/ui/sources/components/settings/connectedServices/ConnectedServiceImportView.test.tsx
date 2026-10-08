import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol';

import { createMachineFixture, renderScreen, pressTestInstanceAsync, changeTextTestInstance } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';

const boundary = vi.hoisted(() => ({
    rpc: vi.fn(), refreshProfile: vi.fn(async () => {}),
    alert: vi.fn(async () => {}), replace: vi.fn(), back: vi.fn(),
}));

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'antigravity', profileId: 'work' },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit');
        return createExpoRouterMock({ params: { serviceId: 'antigravity', profileId: 'work' }, router: { replace: boundary.replace, back: boundary.back } }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit');
        return createModalModuleMock({ spies: { alert: boundary.alert } }).module;
    },
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit');
    return createStorageModuleStub({ useAllMachines: () => [createMachineFixture({ id: 'chosen', activeAt: Date.now() }), createMachineFixture({ id: 'offline', active: false, activeAt: 1 })] });
});
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({ getActiveServerSnapshot: () => ({ serverId: 'relay' }) }));
vi.mock('@/sync/sync', () => ({ sync: { refreshProfile: boundary.refreshProfile } }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async (importOriginal) => {
    const { createServerScopedMachineRpcModuleMock } = await import('@/dev/testkit');
    return createServerScopedMachineRpcModuleMock({ importOriginal, overrides: { machineRpcWithServerScope: boundary.rpc } });
});

describe('ConnectedServiceImportView', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        boundary.refreshProfile.mockResolvedValue(undefined);
        boundary.rpc.mockResolvedValue({ success: true, serviceId: 'antigravity', profileId: 'work', requiresBrowserReauthorization: false });
    });

    async function readyScreen() {
        const { ConnectedServiceImportView } = await import('./ConnectedServiceImportView');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<ConnectedServiceImportView />);
        expect(screen.tree.findByProps({ testID: 'connectedServices.import.submit' }).props.disabled).toBe(true);
        expect(boundary.rpc).not.toHaveBeenCalled();
        await act(async () => { screen.tree.findByType(DropdownMenu).props.onSelect('chosen'); });
        return screen;
    }

    it('imports from the chosen machine and source with an entered project, then returns to profiles', async () => {
        const screen = await readyScreen();
        await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.import.source:cli' }));
        await act(async () => { changeTextTestInstance(screen.tree.findByProps({ testID: 'connectedServices.import.projectInput' }), 'project-one'); });
        await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.import.submit' }));
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'chosen', serverId: 'relay', payload: expect.objectContaining({ serviceId: 'antigravity', profileId: 'work', source: 'cli', projectId: 'project-one' }) }));
        expect(boundary.refreshProfile).toHaveBeenCalledOnce();
        expect(boundary.back).toHaveBeenCalledOnce();
    });

    it('offers browser authorization for an imported grant that cannot launch ACP sessions', async () => {
        boundary.rpc.mockResolvedValue({ success: true, serviceId: 'antigravity', profileId: 'work', requiresBrowserReauthorization: true });
        const screen = await readyScreen();
        await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.import.submit' }));
        expect(boundary.replace).toHaveBeenCalledWith({ pathname: '/settings/connected-services/oauth', params: { serviceId: 'antigravity', profileId: 'work', method: 'paste' } });
        expect(boundary.back).not.toHaveBeenCalled();
    });

    it('keeps import available for retry when a predecessor machine does not support it', async () => {
        boundary.rpc.mockRejectedValue(Object.assign(new Error('not available'), { code: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
        const screen = await readyScreen();
        await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.import.submit' }));
        expect(boundary.refreshProfile).not.toHaveBeenCalled();
        expect(boundary.back).not.toHaveBeenCalled();
        expect(boundary.alert).toHaveBeenCalledOnce();
        expect(screen.tree.findByProps({ testID: 'connectedServices.import.submit' }).props.disabled).toBe(false);
    });

    it.each([false, true])('refreshes the profile and reports an unknown store outcome without repeating the import (refresh fails: %s)', async (refreshFails) => {
        const message = 'The import result is unknown. Refresh the profile before retrying.';
        if (refreshFails) boundary.refreshProfile.mockRejectedValueOnce(new Error('Refresh unavailable'));
        boundary.rpc.mockResolvedValue({ success: false, errorCode: 'storage_result_unknown', error: message });
        const screen = await readyScreen();
        await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.import.submit' }));
        expect(boundary.rpc).toHaveBeenCalledOnce();
        expect(boundary.refreshProfile).toHaveBeenCalledOnce();
        expect(boundary.alert).toHaveBeenCalledWith(expect.any(String), 'connectedServices.importAccounts.unknownResult');
        expect(boundary.back).not.toHaveBeenCalled();
    });

    it('reports an unknown outcome when the connection drops after issuing the machine import', async () => {
        boundary.rpc.mockImplementationOnce(async (request) => {
            request.onIssued();
            throw new Error('Socket disconnected');
        });
        const screen = await readyScreen();
        await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.import.submit' }));
        expect(boundary.rpc).toHaveBeenCalledOnce();
        expect(boundary.refreshProfile).toHaveBeenCalledOnce();
        expect(boundary.alert).toHaveBeenCalledWith(expect.any(String), 'connectedServices.importAccounts.unknownResult');
    });
});
