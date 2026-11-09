import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { readUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { MachineThisMachineSection } = await import('./MachineThisMachineSection');
const { MachineWindowsLaunchSection } = await import('../windows/MachineWindowsLaunchSection');
const { MachineTerminalSettingsSection } = await import('../terminal/MachineTerminalSettingsSection');
const { MachineComputerUseSection } = await import('../computer/MachineComputerUseSection');
const { MachineInstallablesSection } = await import('../installables/MachineInstallablesSection');
const { MachineToolRow } = await import('../installables/MachineToolRow');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { getInstallablesRegistryEntries } = await import('@/capabilities/installablesRegistry');
const { holdSettingWrite } = await import('@/sync/store/settingsPreview');
const { buildMachineTerminalSettingsPatch } = await import('@/sync/domains/settings/terminalSettings');
const { Item } = await import('@/components/ui/lists/Item');

afterEach(async () => { standardCleanup(); await account.reset(); });

describe('Machine settings subscriptions', () => {
    it.each(['summary', 'terminal', 'computer', 'installables'] as const)('%s ignores sibling Machine overrides and presents selected changes', async kind => {
        const machine = createMachineFixture({ active: false });
        const tool = getInstallablesRegistryEntries().find(entry => entry.enabledWhen())!;
        await account.restore({ machines: [machine], settings: {
            sessionTerminalHost: 'none', sessionUseTmux: false,
            sessionTerminalHostByMachineId: { [machine.id]: 'zellij' },
            computerUseByMachineId: { [machine.id]: { enabledProviders: ['cua'], defaultProvider: 'cua' } },
            installablesPolicyByMachineId: { [machine.id]: { [tool.key]: { autoUpdateMode: 'off' } } },
        } });
        expect(storage.getState().settings.sessionTerminalHostByMachineId[machine.id]).toBe('zellij');
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id={kind} onRender={() => { commits++; console.log('A7 commit', kind, commits, readUsableHomeServerIds()); }}>
            {kind === 'summary' ? <MachineThisMachineSection serverId={account.serverId} machine={machine} />
                : kind === 'terminal' ? <MachineTerminalSettingsSection serverId={account.serverId} machineId={machine.id} tmuxAvailable />
                    : kind === 'computer' ? <MachineComputerUseSection serverId={account.serverId} machineId={machine.id} machineName="devbox" online={false} />
                        : <MachineInstallablesSection serverId={account.serverId} machineId={machine.id} machineSentenceName="devbox" />}
        </React.Profiler>);
        // Settle the mounted readers' shared credential lookup before measuring settings publications.
        await act(async () => { await resolveServerCredentialAccountScope(account.serverId); });
        commits = 0;
        console.log('A7 usable at measurement', kind, readUsableHomeServerIds());
        const stopDiagnostic = kind === 'summary' ? storage.subscribe((next, previous) => {
            console.log('A7 changed state', Object.keys(next).filter(key => next[key as keyof typeof next] !== previous[key as keyof typeof previous]));
            console.log('A7 changed settings', Object.keys(next.settings).filter(key => JSON.stringify(next.settings[key as keyof typeof next.settings]) !== JSON.stringify(previous.settings[key as keyof typeof previous.settings])));
            console.log('A7 selected computer identity', next.settings.computerUseByMachineId[machine.id] === previous.settings.computerUseByMachineId[machine.id], previous.settings.computerUseByMachineId[machine.id], next.settings.computerUseByMachineId[machine.id]);
        }) : () => {};
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
        stopDiagnostic();
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
        commits = 0;
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, analyticsOptOut: !storage.getState().settings.analyticsOptOut } }); });
        expect(commits).toBe(0);
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
            ...(kind === 'summary' ? { sessionTerminalHost: 'tmux' as const } : { sessionWindowsRemoteSessionLaunchMode: 'console' as const }),
        } }); });
        expect(commits).toBe(1);
        if (kind === 'summary') expect(screen.findAllByType(Item).find(node => node.props.testID === 'machine-page-row-terminal')?.props.subtitle).toBe('tmux');
    });
});
