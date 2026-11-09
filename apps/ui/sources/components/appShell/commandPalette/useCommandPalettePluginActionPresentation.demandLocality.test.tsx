import * as React from 'react';
import { expect, it, onTestFinished } from 'vitest';
import { renderHook } from '@/dev/testkit';

const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { CommandPalettePluginActionProjectionDemand } = await import('./useCommandPalettePluginActionPresentation');
type ShellValue = import('@/components/appShell/plugins/AppShellPluginUiProjection').AppShellPluginUiProjectionValue;

// The open palette acquires each Machine's projection, and every answer republishes the AppShell
// projection. The demand reads only the Account lifetime, so those republishes must not redraw it.
it('does not redraw the open palette Machine demand when the AppShell projection republishes for the same Account', async () => {
    let shell: ShellValue = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'establishing', interactionEnabled: false, machineId: null, serverId: null, platform: 'web', accountLifetime: null,
        reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'establishing' }, reloadClientExecutables() {} };
    let demandCommits = 0;
    const demand = React.createElement(React.Profiler, { id: 'demand', onRender: () => { demandCommits += 1; } },
        React.createElement(CommandPalettePluginActionProjectionDemand));
    const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(AppShellPluginUiProjectionValueProvider,
        { value: shell, children: React.createElement(React.Fragment, null, demand, children) });
    const hook = await renderHook(() => null, { wrapper });
    onTestFinished(() => hook.unmount());
    const baseline = demandCommits;
    for (let generation = 1; generation <= 5; generation += 1) {
        shell = { ...shell, phase: generation % 2 ? 'current' : 'establishing', interactionEnabled: generation % 2 === 1,
            connectedAccountProjectionRevision: generation, clientExecutableActivation: { status: generation % 2 ? 'ready' : 'establishing' },
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation } };
        await hook.rerender();
    }
    expect(demandCommits - baseline).toBe(0);
});
