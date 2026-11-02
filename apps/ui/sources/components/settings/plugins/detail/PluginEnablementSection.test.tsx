import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { InstalledPluginCapabilityEntryV1Schema } from '@happier-dev/protocol/capabilities';
import { PluginEnablementSection } from './PluginEnablementSection';

installSettingsViewCommonModuleMocks();
afterEach(standardCleanup);
const installed = InstalledPluginCapabilityEntryV1Schema.parse({
    pluginId: 'example.bundled', title: 'Example', description: null, version: '1.0.0',
    enabled: false, accountEnabled: false, machineEnabled: true,
    source: { kind: 'bundled', locator: 'example.bundled' },
    install: { mode: 'bundled', manifestVersion: '2' },
    compatibility: { status: 'compatible', diagnostics: [] }, diagnostics: [],
});

describe('PluginEnablementSection', () => {
    it('keeps both desired scopes visible and sends the exact scope when effective enablement is false', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(<PluginEnablementSection installed={installed} machineLabel={null} disabled={false} onChange={onChange} />);
        const account = screen.findByTestId('settings.plugins.detail.example.bundled.enablement.account')!;
        const machine = screen.findByTestId('settings.plugins.detail.example.bundled.enablement.machine')!;
        expect(account.props.value).toBe(false);
        expect(machine.props.value).toBe(true);
        await React.act(async () => { account.props.onValueChange(true); });
        await React.act(async () => { machine.props.onValueChange(false); });
        expect(onChange.mock.calls).toEqual([['enable', 'account'], ['disable', 'machine']]);
    });

    it('keeps the current values while the existing lifecycle owner is busy', async () => {
        const screen = await renderScreen(<PluginEnablementSection installed={installed} machineLabel={null} disabled onChange={vi.fn()} />);
        expect(screen.findByTestId('settings.plugins.detail.example.bundled.enablement.account')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.plugins.detail.example.bundled.enablement.machine')?.props.disabled).toBe(true);
    });

    it.each([
        [{ accountEnabled: false, machineEnabled: true }, 'settingsPlugins.enablement.accountOff'],
        [{ accountEnabled: false, machineEnabled: false }, 'settingsPlugins.enablement.accountOff'],
        [{ accountEnabled: true, machineEnabled: false }, 'settingsPlugins.enablement.machineOff'],
        [{ accountEnabled: true, machineEnabled: true }, 'settingsPlugins.enablement.description'],
    ] as const)('names the scope that keeps the plugin off (%o)', async (scopes, message) => {
        const screen = await renderScreen(<PluginEnablementSection installed={{ ...installed, ...scopes }}
            machineLabel="Studio Mac" disabled={false} onChange={vi.fn()} />);
        const text = screen.getTextContent();
        expect(text).toContain(message);
        // Each switch says how far it reaches: every machine, or the one named machine.
        expect(text).toContain('settingsPlugins.enablement.accountScope');
        expect(text).toContain('Studio Mac');
    });

    it('marks only the pressed row as working until the lifecycle owner settles', async () => {
        // The lifecycle owner's busy fact, driven the way the screen drives it: the press starts the change.
        let settle: () => void = () => {};
        function Harness() {
            const [busy, setBusy] = React.useState(false);
            settle = () => setBusy(false);
            return <PluginEnablementSection installed={installed} machineLabel="Studio Mac" disabled={busy} onChange={() => setBusy(true)} />;
        }
        const screen = await renderScreen(<Harness />);
        const busyTitles = () => screen.findAll((node) => node.props?.loading === true && typeof node.props?.title === 'string')
            .map((node) => node.props.title);
        await React.act(async () => {
            screen.findByTestId('settings.plugins.detail.example.bundled.enablement.machine')!.props.onValueChange(false);
        });
        expect([...new Set(busyTitles())]).toEqual(['settingsPlugins.enablement.machine']);
        await React.act(async () => { settle(); });
        expect(busyTitles()).toEqual([]);
    });
});
