import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderSettingsView } from '@/dev/testkit';
import type { InstallableDepDataLike, InstallableRegistryEntry } from '@/capabilities/installablesRegistry';
import { installMachineComponentCommonModuleMocks } from '../machineComponentTestHelpers';
import type { MachineToolRowProps } from './MachineToolRow';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMachineComponentCommonModuleMocks({
    icons: () => ({ Ionicons: 'Ionicons' }),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert: vi.fn() } }).module,
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ ActivityIndicator: 'ActivityIndicator' }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ theme: { colors: { textSecondary: '#999999' } } }),
});

const entry = {
    key: 'tool',
    capabilityId: 'dep.tool',
    title: 'Tool',
    subtitle: null,
    experimental: false,
    iconName: 'terminal',
    setupUrl: null,
    installLabels: { install: 'install', update: 'update', reinstall: 'reinstall-label' },
} as unknown as InstallableRegistryEntry;

const dep = (fields: Partial<InstallableDepDataLike>): InstallableDepDataLike => ({
    installed: true,
    installedVersion: '1.0.0',
    sourceKind: 'managed',
    lastInstallLogPath: null,
    lastBackgroundUpdateCheckAtMs: null,
    ...fields,
});

async function renderRow(props: Partial<MachineToolRowProps>) {
    const { MachineToolRow } = await import('./MachineToolRow');
    const onPolicyChange = vi.fn();
    const screen = await renderSettingsView(
        <MachineToolRow
            entry={entry}
            machineId="machine-1"
            serverId="server-1"
            status={null}
            capabilitiesStatus="loaded"
            policy={{ autoInstallWhenNeeded: false, autoUpdateMode: 'notify' }}
            autoUpdateModeOptions={[{ id: 'off', label: 'off' }, { id: 'notify', label: 'notify' }, { id: 'auto', label: 'auto' }]}
            onPolicyChange={onPolicyChange}
            refreshStatus={() => {}}
            showDivider={false}
            {...props}
        />,
    );
    return { screen, onPolicyChange };
}

await import('./MachineToolRow');

describe('MachineToolRow', () => {
    afterEach(() => flushHookEffects({ cycles: 1 }));

    it('keeps a tool to one row until opened, and its policy stays reachable and writable once open', async () => {
        const { screen, onPolicyChange } = await renderRow({ status: dep({ installed: false, installedVersion: null }) });
        expect(screen.findRowByTitle('common.install')).not.toBeNull();
        expect(screen.findRowByTitle('machineDetailPage.toolsPage.autoInstallTitle')).toBeNull();
        expect(screen.findRowByTitle('machineDetailPage.toolsPage.autoUpdateTitle')).toBeNull();

        await act(async () => { screen.pressRow('machine-tool-tool'); });
        await vi.waitFor(() => expect(screen.findRowByTitle('machineDetailPage.toolsPage.autoUpdateTitle')).not.toBeNull());
        await act(async () => { screen.pressRowByTitle('machineDetailPage.toolsPage.autoInstallTitle'); });
        expect(onPolicyChange).toHaveBeenCalledWith('tool', { autoInstallWhenNeeded: true });
        await screen.unmount();
    });

    it('offers Update only when a newer version is out, and Reinstall only from the open row', async () => {
        const outdated = await renderRow({ status: dep({ latestVersionCheck: { ok: true, latestVersion: '2.0.0', label: 'latest' } }) });
        expect(outdated.screen.findRowByTitle('common.update')).not.toBeNull();
        await outdated.screen.unmount();

        const current = await renderRow({ status: dep({ latestVersionCheck: { ok: true, latestVersion: '1.0.0', label: 'latest' } }) });
        expect(current.screen.findRowByTitle('common.update')).toBeNull();
        expect(current.screen.findRowByTitle('reinstall-label')).toBeNull();
        await act(async () => { current.screen.pressRow('machine-tool-tool'); });
        await vi.waitFor(() => expect(current.screen.findRowByTitle('reinstall-label')).not.toBeNull());
        await current.screen.unmount();
    });

    it('offers no install while the machine cannot answer', async () => {
        const { screen } = await renderRow({ status: dep({ installed: false, installedVersion: null }), capabilitiesStatus: 'idle' });
        expect(screen.findRowByTitle('common.install')).toBeNull();
        await screen.unmount();
    });
});
