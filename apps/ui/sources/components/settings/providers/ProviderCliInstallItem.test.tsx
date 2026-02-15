import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn();
const modalAlertMock = vi.fn();

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
    },
}));

vi.mock('@/sync/ops', () => ({
    machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

describe('ProviderCliInstallItem', () => {
    it('invokes cli install with skipIfInstalled=true when not installed', async () => {
        machineCapabilitiesInvokeMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: { logPath: null } } });

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

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledWith(
            'm1',
            { id: 'cli.codex', method: 'install', params: { skipIfInstalled: true } },
            expect.any(Object),
        );
    });

    it('invokes cli install with skipIfInstalled=false when installed (reinstall)', async () => {
        machineCapabilitiesInvokeMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: { logPath: null } } });

        const { ProviderCliInstallItem } = await import('./ProviderCliInstallItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ProviderCliInstallItem, {
                    machineId: 'm1',
                    capabilityId: 'cli.codex',
                    providerTitle: 'Codex',
                    installed: true,
                }),
            );
        });

        const item = tree!.root.findByType('Item' as any);
        await act(async () => {
            await item.props.onPress();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledWith(
            'm1',
            { id: 'cli.codex', method: 'install', params: { skipIfInstalled: false } },
            expect.any(Object),
        );
    });
});

