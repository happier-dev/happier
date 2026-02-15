import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alertMock = vi.fn();
const promptMock = vi.fn(async () => null);
const machineCapabilitiesInvokeMock = vi.fn(async () => ({ supported: false, reason: 'not-supported' }));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999999',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: alertMock,
        prompt: promptMock,
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: () => [null, vi.fn()],
}));

vi.mock('@/sync/ops', () => ({
    machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('InstallableDepInstaller', () => {
    it('routes install invocation through the provided serverId', async () => {
        const { InstallableDepInstaller } = await import('./InstallableDepInstaller');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <InstallableDepInstaller
                    machineId="machine-1"
                    serverId="server-b"
                    enabled
                    groupTitle="Dependencies"
                    depId="dep.codexAcp"
                    depTitle="Codex ACP"
                    depIconName="construct-outline"
                    depStatus={{
                        installed: false,
                        installedVersion: null,
                        distTag: 'latest',
                        lastInstallLogPath: null,
                    }}
                    capabilitiesStatus="loaded"
                    installSpecSettingKey="codexAcpInstallSpec"
                    installSpecTitle="Install source"
                    installSpecDescription="Install source details"
                    installLabels={{
                        install: 'Install now',
                        update: 'Update now',
                        reinstall: 'Reinstall now',
                    }}
                    installModal={{
                        installTitle: 'Install dependency',
                        updateTitle: 'Update dependency',
                        reinstallTitle: 'Reinstall dependency',
                        description: 'Confirm install',
                    }}
                    refreshStatus={() => {}}
                />,
            );
        });

        const installAction = tree.root.findAllByType('Item' as any).find((item) => item.props.title === 'Install now');
        if (!installAction) throw new Error('Expected install action item');

        await act(async () => {
            installAction.props.onPress();
        });

        const confirmButtons = alertMock.mock.calls[0]?.[2];
        if (!Array.isArray(confirmButtons) || typeof confirmButtons[1]?.onPress !== 'function') {
            throw new Error('Expected confirmation buttons with install callback');
        }

        await act(async () => {
            await confirmButtons[1].onPress();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ id: 'dep.codexAcp', method: 'install' }),
            expect.objectContaining({ timeoutMs: 5 * 60_000, serverId: 'server-b' }),
        );
    });
});
