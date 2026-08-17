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

describe('AgentCliInstallItem', () => {
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

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');

        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: false,
                }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'AgentCliInstallItem');

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            request: { id: 'cli.codex', method: 'install', params: { skipIfInstalled: true, allowVendorRecipeExecution: true } },
        }));
    });

    it('keeps skipIfInstalled=true when only a system CLI is installed', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        invokeWithAlertsMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: { logPath: null } } });

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');

        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: true,
                    managedInstalled: false,
                }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'AgentCliInstallItem');

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            request: { id: 'cli.codex', method: 'install', params: { skipIfInstalled: true, allowVendorRecipeExecution: true } },
        }));
    });

    it('invokes cli install with skipIfInstalled=false when a managed CLI is already installed (reinstall)', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        invokeWithAlertsMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: { logPath: null } } });

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');

        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: true,
                    managedInstalled: true,
                }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'AgentCliInstallItem');

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            request: { id: 'cli.codex', method: 'install', params: { skipIfInstalled: false, allowVendorRecipeExecution: true } },
        }));
    });

    it('uses explicit update intent for a system-only runtime and refreshes only after success', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        invokeWithAlertsMock.mockResolvedValueOnce({
            supported: true,
            response: { ok: true, result: { logPath: null } },
        });
        const onManagedUpdateConfirmed = vi.fn();
        const onInstalled = vi.fn();

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');

        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
            machineId: 'm2',
            serverId: 'server1',
            capabilityId: 'cli.codex',
            providerTitle: 'Codex',
            installed: true,
            managedInstalled: false,
            intent: 'update',
            onManagedUpdateConfirmed,
            onInstalled,
        }));

        await pressTestInstanceAsync(screen.findByType('Item'), 'AgentCliInstallItem');

        expect(onManagedUpdateConfirmed).toHaveBeenCalledTimes(1);
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm2',
            serverId: 'server1',
            request: {
                id: 'cli.codex',
                method: 'install',
                params: {
                    intent: 'update',
                    skipIfInstalled: false,
                    allowVendorRecipeExecution: true,
                },
            },
        }));
        expect(onInstalled).toHaveBeenCalledTimes(1);
    });

    it('does not report an explicit update as installed when capability invocation fails', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        invokeWithAlertsMock.mockResolvedValueOnce({
            supported: true,
            response: { ok: false, error: { code: 'install-failed', message: 'failed' } },
        });
        const onInstalled = vi.fn();

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');
        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
            machineId: 'm2',
            capabilityId: 'cli.codex',
            providerTitle: 'Codex',
            installed: true,
            managedInstalled: false,
            intent: 'update',
            onInstalled,
        }));

        await pressTestInstanceAsync(screen.findByType('Item'), 'AgentCliInstallItem');

        expect(onInstalled).not.toHaveBeenCalled();
    });

    it('does not invoke install when user cancels confirmation', async () => {
        modalConfirmMock.mockResolvedValueOnce(false);

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');

        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: false,
                }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'AgentCliInstallItem');

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('does not start install when auto-install is not available for the selected machine', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');

        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
            machineId: 'm1',
            capabilityId: 'cli.opencode',
            providerTitle: 'OpenCode',
            installed: false,
            installability: { kind: 'not-installable' },
        }));

        const item = screen.findByType('Item');
        await pressTestInstanceAsync(item, 'AgentCliInstallItem');

        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('does not invoke install when the canonical execution target changes while confirmation is open', async () => {
        let currentExecutionTarget: Readonly<{ machineId: string; serverId: string }> = {
            machineId: 'm1',
            serverId: 'server1',
        };
        modalConfirmMock.mockImplementationOnce(async () => {
            currentExecutionTarget = {
                machineId: 'm2',
                serverId: 'server2',
            };
            return true;
        });
        const resolveExecutionTarget = vi.fn(() => currentExecutionTarget);

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');
        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
            machineId: 'm1',
            serverId: 'server1',
            capabilityId: 'cli.codex',
            providerTitle: 'Codex',
            installed: false,
            resolveExecutionTarget,
        }));

        await pressTestInstanceAsync(screen.findByType('Item'), 'AgentCliInstallItem');

        expect(resolveExecutionTarget).toHaveBeenCalledTimes(1);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('does not fall back to the rendered target when the canonical execution target becomes unavailable', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        const resolveExecutionTarget = vi.fn(() => null);

        const { AgentCliInstallItem } = await import('./AgentCliInstallItem');
        const screen = await renderScreen(React.createElement(AgentCliInstallItem, {
            machineId: 'm1',
            serverId: 'server1',
            capabilityId: 'cli.codex',
            providerTitle: 'Codex',
            installed: false,
            resolveExecutionTarget,
        }));

        await pressTestInstanceAsync(screen.findByType('Item'), 'AgentCliInstallItem');

        expect(resolveExecutionTarget).toHaveBeenCalledTimes(1);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });
});
