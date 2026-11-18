import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { useHomeViewSelectionSettingsMutable } = await import('@/hooks/server/useHomeViewSelectionSettings');
const { MachineThisMachineSection } = await import('./MachineThisMachineSection');
const { MachineWindowsLaunchSection } = await import('../windows/MachineWindowsLaunchSection');
const { MachineTerminalSettingsSection } = await import('../terminal/MachineTerminalSettingsSection');
const { MachineComputerUseSection } = await import('../computer/MachineComputerUseSection');
const { MachineInstallablesSection } = await import('../installables/MachineInstallablesSection');
const { MachineRolesSection } = await import('../security/MachineRolesSection');
const { Modal } = await import('@/modal');
const { t } = await import('@/text');
const { MachineToolRow } = await import('../installables/MachineToolRow');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { getInstallablesRegistryEntries } = await import('@/capabilities/installablesRegistry');
const { holdSettingWrite } = await import('@/sync/store/settingsPreview');
const { buildMachineTerminalSettingsPatch } = await import('@/sync/domains/settings/terminalSettings');
const { Item } = await import('@/components/ui/lists/Item');
const { HappierSwitchNative } = await import('@happier-dev/plugin-ui/presentation');

afterEach(async () => { standardCleanup(); await account.reset(); });

describe('Machine settings subscriptions', () => {
    it.each([
        { control: 'Windows launch', actionId: 'machines.metadata.update' },
        { control: 'terminal', actionId: 'settings.set' },
        { control: 'roles', actionId: 'machines.roles.set' },
    ] as const)('explains the $control refusal and keeps the previous setting', async ({ control, actionId }) => {
        const machine = createMachineFixture({ id: 'shop', isShared: false, active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, platform: 'win32' } });
        await account.restore({ currentAccount: true, machines: [machine], settings: {
            actionsSettingsV1: { v: 1, actions: { [actionId]: { enabled: false } } },
        } });
        const serverId = account.serverId;
        const screen = await renderScreen(control === 'Windows launch'
            ? <MachineWindowsLaunchSection serverId={serverId} machine={machine} windowsTerminalAvailable />
            : control === 'terminal'
                ? <MachineTerminalSettingsSection serverId={serverId} machineId={machine.id} tmuxAvailable />
                : <MachineRolesSection serverId={serverId} machine={machine} machineName="shop" online />);
        try {
            await act(async () => { await resolveServerCredentialAccountScope(serverId); });
            const findControl = () => {
                const row = screen.findAllByType(Item).find(node => control === 'roles'
                    ? node.props.testID === 'machine-roles-row-sessions'
                    : node.props.title === t(control === 'Windows launch' ? 'machine.windows.remoteSessionModeOverrideTitle' : 'machine.tmux.overrideTitle'));
                return (row?.props.rightElement as React.ReactElement<{
                    value: boolean; onValueChange: (value: boolean) => void | Promise<void>;
                }> | undefined)?.props;
            };
            const value = control === 'roles';
            expect(findControl()?.value).toBe(value);
            await act(async () => { await findControl()?.onValueChange(!value); });
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(expect.any(String), t('actionConfirmations.turnedOffUnnamedMessage')));
            expect(findControl()?.value).toBe(value);
        } finally { await screen.unmount(); }
    });

    it.each(['summary', 'terminal', 'computer', 'installables'] as const)('%s ignores sibling Machine overrides and presents selected changes', async kind => {
        const machine = createMachineFixture({ active: false });
        const tool = getInstallablesRegistryEntries().find(entry => entry.enabledWhen())!;
        await account.restore({ machines: [machine], settings: {
            sessionTerminalHost: 'none', sessionUseTmux: false,
            sessionTerminalHostByMachineId: { [machine.id]: 'zellij' },
            computerUseByMachineId: { [machine.id]: { enabledProviders: ['cua'], defaultProvider: 'cua' } },
            installablesPolicyByMachineId: { [machine.id]: { [tool.key]: { autoUpdateMode: 'off' } } },
        } });
        // Account restoration selects its Home after hydration. Publish that selection's
        // compatibility projection through the same owner as the Home picker before measurement.
        const homeView = await renderHook(useHomeViewSelectionSettingsMutable);
        await act(async () => { await homeView.getCurrent().setHomeViewSelectionSettings(current => current); });
        await homeView.unmount();
        expect(storage.getState().settings.sessionTerminalHostByMachineId[machine.id]).toBe('zellij');
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id={kind} onRender={() => { commits++; }}>
            {kind === 'summary' ? <MachineThisMachineSection serverId={account.serverId} machine={machine} />
                : kind === 'terminal' ? <MachineTerminalSettingsSection serverId={account.serverId} machineId={machine.id} tmuxAvailable />
                    : kind === 'computer' ? <MachineComputerUseSection serverId={account.serverId} machineId={machine.id} machineName="devbox" online={false} />
                        : <MachineInstallablesSection serverId={account.serverId} machineId={machine.id} machineSentenceName="devbox" />}
        </React.Profiler>);
        // Settle the mounted readers' shared credential lookup before measuring settings publications.
        await act(async () => { await resolveServerCredentialAccountScope(account.serverId); });
        if (kind === 'terminal') {
            // The Switch defers its first mount; measure publications after the control is present.
            await waitForTestEvent(screen.subscribe, () => screen.findAllByType(HappierSwitchNative).length, count => count > 0);
        }
        commits = 0;
        const initialSettings = storage.getState().settings;
        for (let index = 0; index < 3; index++) {
            await act(async () => {
                const settings = storage.getState().settings;
                storage.getState().applySettingsLocal({
                    sessionTerminalHostByMachineId: { ...settings.sessionTerminalHostByMachineId, [`sibling-${index}`]: 'herdr' },
                    sessionTmuxByMachineId: { ...settings.sessionTmuxByMachineId,
                        [`sibling-${index}`]: { useTmux: true, sessionName: 'other', isolated: false, tmpDir: null } },
                    computerUseByMachineId: { ...settings.computerUseByMachineId,
                        [`sibling-${index}`]: { enabledProviders: ['agent-desktop'], defaultProvider: 'agent-desktop' } },
                    installablesPolicyByMachineId: { ...settings.installablesPolicyByMachineId,
                        [`sibling-${index}`]: { [tool.key]: { autoUpdateMode: 'auto' } } },
                });
            });
        }
        expect(storage.getState().settings.serverSelectionGroups).toBe(initialSettings.serverSelectionGroups);
        expect(storage.getState().settings.serverSelectionActiveTargetKind).toBe(initialSettings.serverSelectionActiveTargetKind);
        expect(storage.getState().settings.serverSelectionActiveTargetId).toBe(initialSettings.serverSelectionActiveTargetId);
        expect(commits).toBe(0);
        await act(async () => {
            const settings = storage.getState().settings;
            storage.getState().applySettingsLocal(kind === 'computer'
                ? { computerUseByMachineId: { ...settings.computerUseByMachineId,
                    [machine.id]: { enabledProviders: ['agent-desktop'], defaultProvider: 'agent-desktop' } } }
                : kind === 'installables'
                    ? { installablesPolicyByMachineId: { ...settings.installablesPolicyByMachineId,
                        [machine.id]: { [tool.key]: { autoUpdateMode: 'auto' } } } }
                    : { sessionTerminalHostByMachineId: { ...settings.sessionTerminalHostByMachineId, [machine.id]: 'herdr' } });
        });
        expect(commits).toBe(1);
        if (kind === 'summary') expect(screen.findAllByType(Item).find(node => node.props.testID === 'machine-page-row-terminal')?.props.subtitle).toBe('Herdr');
        if (kind === 'terminal') {
            expect(screen.findAllByType(SegmentedChoiceItem)[0]?.props.value).toBe('herdr');
            let release!: () => void;
            await act(async () => { release = holdSettingWrite({ anchor: 'machines.terminal.host' }, { host: 'tmux' },
                settings => buildMachineTerminalSettingsPatch({ settings, machineId: machine.id, host: 'tmux' })); });
            expect(screen.findAllByType(SegmentedChoiceItem)[0]?.props.value).toBe('tmux');
            await act(async () => { release(); });
            expect(screen.findAllByType(SegmentedChoiceItem)[0]?.props.value).toBe('herdr');
            await act(async () => {
                const { [machine.id]: _selected, ...siblings } = storage.getState().settings.sessionTerminalHostByMachineId;
                storage.getState().applySettingsLocal({ sessionTerminalHostByMachineId: siblings,
                    sessionTerminalHost: 'legacy', sessionUseTmux: true });
            });
            expect(screen.findAllByType(Item).find(node => node.props.testID === 'machine-terminal-effective-host')?.props.subtitle).toBe('tmux');
        }
        if (kind === 'computer') {
            expect(screen.findByTestId('machine-computer-use-provider-agent-desktop.default')).not.toBeNull();
            expect(screen.findByTestId('machine-computer-use-provider-cua.switch')).not.toBeNull();
        }
        if (kind === 'installables') expect(screen.findAllByType(MachineToolRow).find(node => node.props.entry.key === tool.key)?.props.policy.autoUpdateMode).toBe('auto');
    });

    it.each(['summary', 'windows'] as const)('%s ignores unrelated preferences and commits once for a consumed key', async kind => {
        const machine = createMachineFixture({ metadata: { ...createMachineFixture().metadata!, platform: 'win32' } });
        await account.restore({ waivedActions: ['settings.set'], machines: [machine], settings: {
            sessionTerminalHost: 'none', sessionUseTmux: false, sessionWindowsRemoteSessionLaunchMode: 'hidden',
        } });
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id={kind} onRender={() => { commits++; }}>
            {kind === 'summary'
                ? <MachineThisMachineSection serverId={account.serverId} machine={machine} />
                : <MachineWindowsLaunchSection serverId={account.serverId} machine={machine} windowsTerminalAvailable />}
        </React.Profiler>);
        // Settle the mounted readers' shared credential lookup before measuring settings publications.
        await act(async () => { await resolveServerCredentialAccountScope(account.serverId); });
        if (kind === 'windows') {
            // The Switch defers its first mount; measure publications after the control is present.
            await waitForTestEvent(screen.subscribe, () => screen.findAllByType(HappierSwitchNative).length, count => count > 0);
        }
        commits = 0;
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, analyticsOptOut: !storage.getState().settings.analyticsOptOut } }); });
        expect(commits).toBe(0);
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
            ...(kind === 'summary' ? { sessionTerminalHost: 'legacy' as const, sessionUseTmux: true } : { sessionWindowsRemoteSessionLaunchMode: 'console' as const }),
        } }); });
        expect(commits).toBe(1);
        if (kind === 'summary') expect(screen.findAllByType(Item).find(node => node.props.testID === 'machine-page-row-terminal')?.props.subtitle).toBe('tmux');
    });
});
