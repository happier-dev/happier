import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const invokeWithAlertsMock = vi.fn();
const modalAlertMock = vi.fn();
const modalConfirmMock = vi.fn();

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertMock,
        confirm: modalConfirmMock,
    },
}));

vi.mock('@/hooks/machine/useMachineCapabilityInvokeWithAlerts', () => ({
    useMachineCapabilityInvokeWithAlerts: () => ({
        isInvoking: false,
        invokeWithAlerts: invokeWithAlertsMock,
    }),
}));

describe('ProviderCliInstallItem', () => {
    beforeEach(() => {
        invokeWithAlertsMock.mockReset();
        modalAlertMock.mockReset();
        modalConfirmMock.mockReset();
    });

    it('invokes cli install with skipIfInstalled=true when not installed', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
        invokeWithAlertsMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: { logPath: null } } });

        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: false,
                }),
            );
        });

        const item = tree!.root.findByType('Item' as any);
        await act(async () => {
            await item.props.onPress();
        });

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: true,
                    managedInstalled: false,
                }),
            );
        });

        const item = tree!.root.findByType('Item' as any);
        expect(item.props.title).toBe('Install Codex CLI');
        await act(async () => {
            await item.props.onPress();
        });

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: true,
                    managedInstalled: true,
                }),
            );
        });

        const item = tree!.root.findByType('Item' as any);
        expect(item.props.title).toBe('Reinstall Codex CLI');
        await act(async () => {
            await item.props.onPress();
        });

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            request: { id: 'cli.codex', method: 'install', params: { skipIfInstalled: false, allowVendorRecipeExecution: true } },
        }));
    });

    it('does not invoke install when user cancels confirmation', async () => {
        modalConfirmMock.mockResolvedValueOnce(false);

        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: false,
                }),
            );
        });

        const item = tree!.root.findByType('Item' as any);
        await act(async () => {
            await item.props.onPress();
        });

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('disables install action when auto-install is not available for the selected machine', async () => {
        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.opencode',
                    providerTitle: 'OpenCode',
                    installed: false,
                    installability: { kind: 'not-installable' },
                }),
            );
        });

        const item = tree!.root.findByType('Item' as any);
        expect(item.props.disabled).toBe(true);
    });
});
