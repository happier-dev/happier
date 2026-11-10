import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';
import { flushHookEffects, renderSettingsView } from '@/dev/testkit';
import type { InstallableDepInstallerProps } from './InstallableDepInstaller';
import { installMachineComponentCommonModuleMocks } from './machineComponentTestHelpers';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alertMock = vi.fn();

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
    depIconName: 'wrench',
    depStatus: null,
    capabilitiesStatus: 'loaded',
    installLabels,
    installModal,
    refreshStatus: () => {},
} satisfies Omit<InstallableDepInstallerProps, 'refreshLatestVersion' | 'extraItems'>;

async function renderInstaller(
    overrides: Partial<Pick<InstallableDepInstallerProps, 'depStatus' | 'capabilitiesStatus' | 'refreshStatus' | 'refreshLatestVersion' | 'extraItems'>> = {},
) {
    const { InstallableDepInstaller } = await import('./InstallableDepInstaller');

    return renderSettingsView(
        <InstallableDepInstaller
            {...baseInstallerProps}
            {...overrides}
        />,
    );
}

await import('./InstallableDepInstaller');

describe('InstallableDepInstaller', () => {
    beforeEach(() => {
        alertMock.mockReset();
    });

    afterEach(() => {
        return flushHookEffects({ cycles: 1 });
    });

    it.each([
        ['downloading', false, 'deps.installable.downloading'],
        ['unavailable', false, 'deps.ui.notInstalled'],
        ['ready', true, 'deps.ui.installed'],
    ] as const)('shows externally started runtime state %s and lets users refresh it', async (runtimeState, installed, subtitle) => {
        const refreshStatus = vi.fn();
        const depStatus = {
            installed,
            runtimeState,
            installedVersion: null,
            sourceKind: 'first_party_runtime',
            lastInstallLogPath: '/runtime/install.log',
            lastBackgroundUpdateCheckAtMs: null,
        };
        const screen = await renderInstaller({ depStatus, refreshStatus });

        expect(screen.findRowByTitle(baseInstallerProps.depTitle)?.props.subtitle).toBe(subtitle);
        expect(screen.findRowByTitle(installed ? installLabels.reinstall : installLabels.install)?.props.disabled).toBe(false);
        expect(screen.findRowByTitle('deps.ui.lastInstallLog')?.props.subtitle).toBe('/runtime/install.log');

        await act(async () => {
            screen.pressRowByTitle(baseInstallerProps.depTitle);
        });
        expect(refreshStatus).toHaveBeenCalled();
        await screen.unmount();
    });

    it('renders the last background update check through the app date presentation', async () => {
        const screen = await renderInstaller({
            depStatus: {
                installed: true,
                installedVersion: '0.9.5',
                sourceKind: 'github_release_binary',
                lastInstallLogPath: null,
                lastBackgroundUpdateCheckAtMs: 1_773_164_020_808,
            },
        });

        const lastCheckedItem = screen.findByProps({ title: 'settingsAgents.authentication.lastCheckedTitle' });
        expect(lastCheckedItem).toBeTruthy();
        expect(lastCheckedItem?.props.subtitle).toBe(formatAsOfTime(1_773_164_020_808));

        await screen.unmount();
    });

    it('disables install actions when machine capability invocation is unavailable', async () => {
        const screen = await renderInstaller({
            capabilitiesStatus: 'not-supported',
            depStatus: {
                installed: false,
                installedVersion: null,
                sourceKind: 'github_release_binary',
                lastInstallLogPath: null,
                lastBackgroundUpdateCheckAtMs: null,
            },
        });

        const installAction = screen.findRowByTitle(installLabels.install);
        expect(installAction?.props.disabled).toBe(true);

        await act(async () => {
            screen.pressRowByTitle(installLabels.install);
        });

        expect(alertMock).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
