import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alertMock = vi.fn();
const machineCapabilitiesInvokeMock = vi.fn(
    async (_machineId: string, _request: unknown, _options: unknown) => ({ supported: false, reason: 'not-supported' }),
);

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
    },
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
                    depId={CODEX_ACP_DEP_ID}
                    depTitle="Codex ACP"
                    depIconName="construct-outline"
                    depStatus={{
                        installed: false,
                        installedVersion: null,
                        sourceKind: 'github_release_binary',
                        lastInstallLogPath: null,
                        lastBackgroundUpdateCheckAtMs: null,
                    }}
                    capabilitiesStatus="loaded"
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
            expect.objectContaining({ id: CODEX_ACP_DEP_ID, method: 'install' }),
            expect.objectContaining({ timeoutMs: 5 * 60_000, serverId: 'server-b' }),
        );
    });

    it('invokes installs without install-spec params', async () => {
        const { InstallableDepInstaller } = await import('./InstallableDepInstaller');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <InstallableDepInstaller
                    machineId="machine-1"
                    serverId="server-b"
                    enabled
                    groupTitle="Dependencies"
                    depId={CODEX_ACP_DEP_ID}
                    depTitle="Codex ACP"
                    depIconName="construct-outline"
                    depStatus={{
                        installed: false,
                        installedVersion: null,
                        sourceKind: 'github_release_binary',
                        lastInstallLogPath: null,
                        lastBackgroundUpdateCheckAtMs: null,
                    }}
                    capabilitiesStatus="loaded"
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

        const confirmButtons = alertMock.mock.calls.at(-1)?.[2];
        if (!Array.isArray(confirmButtons) || typeof confirmButtons[1]?.onPress !== 'function') {
            throw new Error('Expected confirmation buttons with install callback');
        }

        await act(async () => {
            await confirmButtons[1].onPress();
        });

        const lastCall = machineCapabilitiesInvokeMock.mock.calls.at(-1);
        expect(lastCall).toBeTruthy();
        expect(lastCall?.[0]).toBe('machine-1');
        expect(lastCall?.[2]).toMatchObject({ timeoutMs: 5 * 60_000, serverId: 'server-b' });

        const request = lastCall?.[1] as Record<string, unknown> | undefined;
        expect(request).toMatchObject({ id: CODEX_ACP_DEP_ID, method: 'install' });
        expect(request).not.toHaveProperty('params');
    });

    it('renders the last background update check in the existing installables UI', async () => {
        const { InstallableDepInstaller } = await import('./InstallableDepInstaller');
        vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Mar 10, 2026, 6:13 PM');

        const depStatus = {
            installed: true,
            installedVersion: '0.9.5',
            sourceKind: 'github_release_binary',
            lastInstallLogPath: null,
            lastBackgroundUpdateCheckAtMs: 1_773_164_020_808,
        };

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <InstallableDepInstaller
                    machineId="machine-1"
                    serverId="server-b"
                    enabled
                    groupTitle="Dependencies"
                    depId={CODEX_ACP_DEP_ID}
                    depTitle="Codex ACP"
                    depIconName="construct-outline"
                    depStatus={depStatus}
                    capabilitiesStatus="loaded"
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

        const lastCheckedItem = tree.root.findAllByType('Item' as any).find(
            (item) => item.props.title === 'settingsProviders.authentication.lastCheckedTitle',
        );
        expect(lastCheckedItem).toBeTruthy();
        expect(lastCheckedItem?.props.subtitle).toBe('Mar 10, 2026, 6:13 PM');
    });
});
