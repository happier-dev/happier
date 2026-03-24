import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';
import { flushHookEffects, renderSettingsView } from '@/dev/testkit';
import type { InstallableDepInstallerProps } from './InstallableDepInstaller';
import { installMachineComponentCommonModuleMocks } from './machineComponentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alertMock = vi.fn();
type MachineCapabilitiesInvokeMock = typeof import('@/sync/ops/capabilities').machineCapabilitiesInvoke;

const machineCapabilitiesInvokeMock = vi.fn<MachineCapabilitiesInvokeMock>(
    async (_machineId: string, _request: unknown, _options: unknown) => ({ supported: false, reason: 'not-supported' }),
);

installMachineComponentCommonModuleMocks({
    icons: () => ({
        Ionicons: 'Ionicons',
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: alertMock,
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#999999',
                },
            },
        });
    },
});

vi.mock('@/sync/ops/capabilities', () => ({
    machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

const installLabels = {
    install: 'Install now',
    update: 'Update now',
    reinstall: 'Reinstall now',
} as const;

const installModal = {
    installTitle: 'Install dependency',
    updateTitle: 'Update dependency',
    reinstallTitle: 'Reinstall dependency',
    description: 'Confirm install',
} as const;

const baseInstallerProps = {
    machineId: 'machine-1',
    serverId: 'server-b',
    enabled: true,
    groupTitle: 'Dependencies',
    depId: CODEX_ACP_DEP_ID,
    depTitle: 'Codex ACP',
    depIconName: 'construct-outline',
    depStatus: null,
    capabilitiesStatus: 'loaded',
    installLabels,
    installModal,
    refreshStatus: () => {},
} satisfies Omit<InstallableDepInstallerProps, 'refreshLatestVersion' | 'extraItems'>;

async function renderInstaller(
    overrides: Partial<Pick<InstallableDepInstallerProps, 'depStatus' | 'capabilitiesStatus' | 'refreshLatestVersion' | 'extraItems'>> = {},
) {
    const { InstallableDepInstaller } = await import('./InstallableDepInstaller');

    return renderSettingsView(
        <InstallableDepInstaller
            {...baseInstallerProps}
            {...overrides}
        />,
    );
}

describe('InstallableDepInstaller', () => {
    beforeEach(() => {
        alertMock.mockReset();
        machineCapabilitiesInvokeMock.mockReset();
        machineCapabilitiesInvokeMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: {} },
        });
    });

    afterEach(() => {
        return flushHookEffects({ cycles: 1 });
    });

    it('routes install invocation through the provided serverId', async () => {
        const screen = await renderInstaller({
            depStatus: {
                installed: false,
                installedVersion: null,
                sourceKind: 'github_release_binary',
                lastInstallLogPath: null,
                lastBackgroundUpdateCheckAtMs: null,
            },
        });

        await act(async () => {
            screen.pressRowByTitle(installLabels.install);
        });

        const confirmButtons = alertMock.mock.calls.find(
            (call) => call[0] === installModal.installTitle && Array.isArray(call[2]),
        )?.[2];
        if (!Array.isArray(confirmButtons) || typeof confirmButtons[1]?.onPress !== 'function') {
            throw new Error('Expected confirmation buttons with install callback');
        }

        await act(async () => {
            await confirmButtons[1].onPress();
        });
        await flushHookEffects({ cycles: 1 });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ id: CODEX_ACP_DEP_ID, method: 'install' }),
            expect.objectContaining({ timeoutMs: 5 * 60_000, serverId: 'server-b' }),
        );

        await screen.unmount();
    });

    it('invokes installs without install-spec params', async () => {
        const screen = await renderInstaller({
            depStatus: {
                installed: false,
                installedVersion: null,
                sourceKind: 'github_release_binary',
                lastInstallLogPath: null,
                lastBackgroundUpdateCheckAtMs: null,
            },
        });

        const installAction = screen.findRowByTitle(installLabels.install);
        if (!installAction) {
            throw new Error('Expected install action item');
        }
        await act(async () => {
            screen.pressRowByTitle(installLabels.install);
        });

        const confirmButtons = alertMock.mock.calls.find((call) => Array.isArray(call[2]))?.[2];
        if (!Array.isArray(confirmButtons) || typeof confirmButtons[1]?.onPress !== 'function') {
            throw new Error('Expected confirmation buttons with install callback');
        }

        await act(async () => {
            await confirmButtons[1].onPress();
        });
        await flushHookEffects({ cycles: 1 });

        const lastCall = machineCapabilitiesInvokeMock.mock.calls.at(-1);
        expect(lastCall).toBeTruthy();
        expect(lastCall?.[0]).toBe('machine-1');
        expect(lastCall?.[2]).toMatchObject({ timeoutMs: 5 * 60_000, serverId: 'server-b' });

        const request = lastCall?.[1] as Record<string, unknown> | undefined;
        expect(request).toMatchObject({ id: CODEX_ACP_DEP_ID, method: 'install' });
        expect(request).not.toHaveProperty('params');

        await screen.unmount();
    });

    it('renders the last background update check in the existing installables UI', async () => {
        const toLocaleStringSpy = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Mar 10, 2026, 6:13 PM');

        const screen = await renderInstaller({
            depStatus: {
                installed: true,
                installedVersion: '0.9.5',
                sourceKind: 'github_release_binary',
                lastInstallLogPath: null,
                lastBackgroundUpdateCheckAtMs: 1_773_164_020_808,
            },
        });

        const lastCheckedItem = screen.findByProps({ title: 'settingsProviders.authentication.lastCheckedTitle' });
        expect(lastCheckedItem).toBeTruthy();
        expect(lastCheckedItem?.props.subtitle).toBe('Mar 10, 2026, 6:13 PM');

        await screen.unmount();
        toLocaleStringSpy.mockRestore();
    });
});
