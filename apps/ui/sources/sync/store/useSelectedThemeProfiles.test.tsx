import * as React from 'react';
import { afterEach, expect, it, onTestFinished } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiThemeProjection } from '@/sync/domains/plugins/ui/projection';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { findActiveThemeProfileForMode } from '@/theme/profiles/themeProfilePersistence';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { useSelectedThemeProfiles, useThemeProfileReferenceSelection } from './useThemeProfiles';

const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

it('keeps two selected plugin documents with the same local id separate across modes', async () => {
    const fixture = await createPlainArtifactHomeFixture('https://selected-plugin-themes.test', { currentAccount: true });
    onTestFinished(() => fixture.dispose());
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing admitted theme Account');
    const { scope } = lifetime;
    const entry = (pluginId: string, name: string): PluginUiThemeProjection => ({
        id: `${pluginId}/palette`, pluginId, pluginVersion: '1.0.0',
        definition: { id: 'palette', theme: createThemeProfileDraft({ id: 'palette', name, now: '2026-11-17' }) },
    });
    const value: AppShellPluginUiProjectionValue = {
        pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, themesById: {
            'light.palette/palette': entry('light.palette', 'Light palette'),
            'dark.palette/palette': entry('dark.palette', 'Dark palette'),
        } },
        pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web', accountLifetime: lifetime, connectedAccountProjectionRevision: 0,
        reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
    };
    storage.getState().applyLocalSettings({ themeProfileSelection: {
        light: { kind: 'plugin', pluginId: 'light.palette', contributionId: 'palette' },
        dark: { kind: 'plugin', pluginId: 'dark.palette', contributionId: 'palette' },
    } });
    let selected: ReturnType<typeof useSelectedThemeProfiles> | null = null;
    function Probe() { selected = useSelectedThemeProfiles(useThemeProfileReferenceSelection(), scope); return null; }
    await renderScreen(<><Probe /><AppShellPluginUiProjectionValueProvider value={value}>{null}</AppShellPluginUiProjectionValueProvider></>);
    const profiles = selected as ReturnType<typeof useSelectedThemeProfiles> | null;
    expect(profiles && findActiveThemeProfileForMode(profiles, 'light')?.name).toBe('Light palette');
    expect(profiles && findActiveThemeProfileForMode(profiles, 'dark')?.name).toBe('Dark palette');
    await act(async () => storage.getState().applyLocalSettings({ themeProfileSelection: {
        light: { kind: 'plugin', pluginId: 'light.palette', contributionId: 'palette' },
        dark: { contributionId: 'palette', pluginId: 'light.palette', kind: 'plugin' },
    } }));
    // The same reference in both slots remains one paint profile even if field order differs.
    expect((selected as ReturnType<typeof useSelectedThemeProfiles> | null)?.profiles).toHaveLength(1);
});
