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

// Entering and leaving a Session must not rebuild the app-scope Action presentation (a full schema pass over every
// projected Action) while the app projection itself is unchanged.
it('builds the app-scope Action presentation once per app projection across Session entries and exits', async () => {
    const { vi } = await import('vitest');
    const { InputHintsSchema } = await import('@happier-dev/protocol/inputs/inputFields');
    const { parseDaemonContributionRegistryProjectionDescribeResponse } = await import('@/sync/api/daemon/daemonContributionRegistryProjectionProtocol');
    const { publishDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
    const { useCommandPalettePluginActionPresentation } = await import('./useCommandPalettePluginActionPresentation');
    const parsed = parseDaemonContributionRegistryProjectionDescribeResponse({ protocolVersion: 1, projectionDigest: 'd', projection: {
        v: 2, generation: 3,
        installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true, source: { kind: 'local', locator: '/plugins/review' } } },
        actionsById: { 'acme.review/refresh': { id: 'refresh', pluginId: 'acme.review', occurrenceId: 'review-current',
            title: 'Refresh', scopes: ['global'], surfaces: ['plugin'], execution: { target: 'daemon' }, dangerLevel: 'safe',
            inputHints: { title: 'Refresh', submitLabel: 'Refresh', fields: [{ path: 'reason', title: 'Reason', widget: 'textarea' }] } } },
        familiesById: {},
    } });
    if (!parsed) throw new Error('Expected an admitted describe answer');
    const appProjection = publishDaemonMergedProjectionInputs({ projection: parsed.projection, resourceDeclarations: 'complete' }).pluginUiProjection;
    const shell: ShellValue = { pluginUiProjection: appProjection, pluginBrowserProjection: null,
        phase: 'current', interactionEnabled: true, machineId: null, serverId: null, platform: 'web', accountLifetime: null,
        reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
    const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(AppShellPluginUiProjectionValueProvider, { value: shell, children });
    const parse = vi.spyOn(InputHintsSchema, 'parse');
    onTestFinished(() => parse.mockRestore());
    const hook = await renderHook(({ sessionId }: { sessionId: string | null }) => useCommandPalettePluginActionPresentation(sessionId, false),
        { wrapper, initialProps: { sessionId: null as string | null } });
    onTestFinished(() => hook.unmount());
    const first = parse.mock.calls.length;
    for (const sessionId of ['session-a', null, 'session-b', null]) await hook.rerender({ sessionId });
    expect(first).toBeGreaterThan(0);
    expect(parse.mock.calls.length - first).toBe(0);
});
