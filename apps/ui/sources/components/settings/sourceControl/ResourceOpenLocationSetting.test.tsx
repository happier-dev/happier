import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createPluginUiResourceProjection } from '@/dev/testkit/fixtures/pluginUiResourceProjection';
import { standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

const { ResourceOpenLocationSetting } = await import('./ResourceOpenLocationSetting');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { storage } = await import('@/sync/domains/state/storageStore');
const initialSettings = storage.getState().settings;

afterEach(async () => {
    await standardCleanup();
    storage.setState({ settings: initialSettings });
});

function renderLocation(available: boolean, onRender?: () => void) {
    const value = {
        pluginUiProjection: createPluginUiResourceProjection(available),
        pluginBrowserProjection: null,
        phase: 'current' as const,
        interactionEnabled: true,
        machineId: 'machine-1', serverId: 'server-1', platform: 'web' as const,
        accountLifetime: null,
        clientExecutableActivation: { status: 'ready' as const },
        reloadClientExecutables() {}, reloadConnectedAccountProjection() {},
    };
    return renderSettingsView(
        <AppShellPluginUiProjectionValueProvider value={value}>
            <React.Profiler id="resource-open-location" onRender={() => onRender?.()}>
                <ResourceOpenLocationSetting />
            </React.Profiler>
        </AppShellPluginUiProjectionValueProvider>,
    );
}

describe('resource open preference', () => {
    it('offers the Account choice only for an available contributed handler', async () => {
        const unavailable = await renderLocation(false);
        expect(unavailable.findAllByType(SegmentedChoiceItem)).toHaveLength(0);
        await unavailable.unmount();

        const available = await renderLocation(true);
        expect(available.findAllByType(SegmentedChoiceItem)).toHaveLength(1);
        expect(available.findAllByType(SegmentedChoiceItem)[0]?.props.value).toBe('happier');
    });

    it('reacts to its Account key and ignores unrelated preference updates', async () => {
        let renders = 0;
        const screen = await renderLocation(true, () => { renders++; });
        const baseline = renders;
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, showLineNumbers: false } }); });
        expect(renders).toBe(baseline);
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, scmResourceOpenLocation: 'github' } }); });
        expect(screen.findAllByType(SegmentedChoiceItem)[0]?.props.value).toBe('github');
    });
});
