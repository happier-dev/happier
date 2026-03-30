import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const invokeWithAlertsMock = vi.fn();
const modalAlertMock = vi.fn();
const modalConfirmMock = vi.fn();

installSettingsViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertMock,
                confirm: modalConfirmMock,
            },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/hooks/machine/useMachineCapabilityInvokeWithAlerts', () => ({
    useMachineCapabilityInvokeWithAlerts: () => ({
        isInvoking: false,
        invokeWithAlerts: invokeWithAlertsMock,
    }),
}));

describe('ProviderCliInstallItem', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        invokeWithAlertsMock.mockReset();
        modalAlertMock.mockReset();
        modalConfirmMock.mockReset();
    });

    it('invokes cli install with skipIfInstalled=true when not installed', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        invokeWithAlertsMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: { logPath: null } } });

        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        const screen = await renderScreen(React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: false,
                }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'ProviderCliInstallItem');

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            request: { id: 'cli.codex', method: 'install', params: { skipIfInstalled: true, allowVendorRecipeExecution: true } },
        }));
    });

    it('keeps skipIfInstalled=true when only a system CLI is installed', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        invokeWithAlertsMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: { logPath: null } } });

        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        const screen = await renderScreen(React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: true,
                    managedInstalled: false,
                }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'ProviderCliInstallItem');

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            request: { id: 'cli.codex', method: 'install', params: { skipIfInstalled: true, allowVendorRecipeExecution: true } },
        }));
    });

    it('invokes cli install with skipIfInstalled=false when a managed CLI is already installed (reinstall)', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        invokeWithAlertsMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: { logPath: null } } });

        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        const screen = await renderScreen(React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: true,
                    managedInstalled: true,
                }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'ProviderCliInstallItem');

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            request: { id: 'cli.codex', method: 'install', params: { skipIfInstalled: false, allowVendorRecipeExecution: true } },
        }));
    });

    it('does not invoke install when user cancels confirmation', async () => {
        modalConfirmMock.mockResolvedValueOnce(false);

        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        const screen = await renderScreen(React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: false,
                }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'ProviderCliInstallItem');

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('does not start install when auto-install is not available for the selected machine', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);

        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        const screen = await renderScreen(React.createElement(ProviderCliInstallItem, {
            machineId: 'm1',
            capabilityId: 'cli.opencode',
            providerTitle: 'OpenCode',
            installed: false,
            installability: { kind: 'not-installable' },
        }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'ProviderCliInstallItem');

        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });
});
