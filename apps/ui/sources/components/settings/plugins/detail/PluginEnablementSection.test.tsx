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
        const screen = await renderScreen(<PluginEnablementSection installed={installed} disabled={false} onChange={onChange} />);
        const account = screen.findByTestId('settings.plugins.detail.example.bundled.enablement.account')!;
        const machine = screen.findByTestId('settings.plugins.detail.example.bundled.enablement.machine')!;
        expect(account.props.value).toBe(false);
        expect(machine.props.value).toBe(true);
        await React.act(async () => { account.props.onValueChange(true); });
        await React.act(async () => { machine.props.onValueChange(false); });
        expect(onChange.mock.calls).toEqual([['enable', 'account'], ['disable', 'machine']]);
    });

    it('keeps the current values while the existing lifecycle owner is busy', async () => {
        const screen = await renderScreen(<PluginEnablementSection installed={installed} disabled onChange={vi.fn()} />);
        expect(screen.findByTestId('settings.plugins.detail.example.bundled.enablement.account')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.plugins.detail.example.bundled.enablement.machine')?.props.disabled).toBe(true);
    });
});
