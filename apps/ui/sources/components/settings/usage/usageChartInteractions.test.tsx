import * as React from 'react';
import { View } from 'react-native';
import { ChartDatum } from '@happier-dev/plugin-ui/presentation';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// The portal is a platform boundary; datum state and mounted command admission stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 200, maxWidth: 320, placement: 'bottom' }));

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
const storage = installLocalStorageMock();
afterAll(() => storage.restore());
const serveDatumHome = () => serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-datum.test', accountId: 'account-a' }],
    route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
// Restore the genuine Home before runtime imports; cold graph transformation belongs to collection.
home = await serveDatumHome();
publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { UsageChartInteractions } = await import('./usageChartInteractions');
const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { Popover } = await import('@/components/ui/popover');
await home.dispose();
home = undefined;
afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
});

it('reveals and dismisses the same exact datum through its UI trigger and mounted agent command', async () => {
    home = await serveDatumHome();
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const screen = await renderMountedCurrentUiContext(<UsageChartInteractions>
        <ChartDatum testID="usage.exact" datum={{ label: 'Cache hit', value: '69.8811%', subtitle: 'Measured tokens' }}><View /></ChartDatum>
    </UsageChartInteractions>);
    const port = readCurrentUiContextActionReader({ surface: 'agent' });
    const executor = createDefaultActionExecutor();
    const read = () => port!.readCurrentUiContext()!;
    const reveal = read().commands.find(command => command.title.includes('Cache hit') && command.title.includes('69.8811%'));
    expect(reveal).toBeDefined();
    const tooltipOpen = () => screen.findAllByType(Popover).some(node => node.props.open === true);
    expect(tooltipOpen()).toBe(false);
    await screen.pressByTestIdAsync('usage.exact');
    expect(tooltipOpen()).toBe(true);
    const dismiss = read().commands.find(command => command.title === 'Close Cache hit');
    expect(dismiss).toBeDefined();
    await act(async () => {
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: dismiss!.id }, { surface: 'agent' }))
            .toMatchObject({ ok: true });
    });
    expect(tooltipOpen()).toBe(false);
    await act(async () => {
        const current = read().commands.find(command => command.title.includes('69.8811%'))!;
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: current.id }, { surface: 'agent' }))
            .toMatchObject({ ok: true });
    });
    expect(tooltipOpen()).toBe(true);
    await screen.unmount();
});

it.each(['hover', 'focus'] as const)('keeps a datum closed when %s leaves before its mounted reveal settles', async (interaction) => {
    home = await serveDatumHome();
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const screen = await renderMountedCurrentUiContext(<UsageChartInteractions>
        <ChartDatum testID="usage.rapid" datum={{ label: 'Cache hit', value: '69.8811%' }}><View /></ChartDatum>
    </UsageChartInteractions>);
    const trigger = screen.findByTestId('usage.rapid');
    expect(trigger).toBeDefined();
    await act(async () => {
        if (interaction === 'hover') {
            trigger!.props.onHoverIn();
            trigger!.props.onHoverOut();
        } else {
            trigger!.props.onFocus();
            trigger!.props.onBlur();
        }
    });
    expect(screen.findAllByType(Popover).some(node => node.props.open === true)).toBe(false);
    await screen.unmount();
});
