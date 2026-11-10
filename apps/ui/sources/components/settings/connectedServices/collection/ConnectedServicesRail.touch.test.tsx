import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
// Collected with the file, so the one case's budget is spent on the rail, not on loading it.
import { ConnectedServicesRailView } from './ConnectedServicesRail';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

// The third-party recycler is the viewport boundary; the rail's rows, groups and selection stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});

afterEach(() => vi.unstubAllGlobals());

it("gives a group's add the height of its label row, and no further: the first row is directly beneath", async () => {
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const model = buildConnectedServicesIndexModel({
    transport: 'advertised-v4', entries: [], qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
    defaultAccountByServiceKey: {}, resolveLabel: () => '', resolveFallbackEntry: () => null,
    presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: [],
  });
  const screen = await renderScreen(
    <ConnectedServicesRailView
      model={model} labelsByKey={{}} selection={{ kind: 'index' }}
      present={(input) => ({ title: input.label ?? '', subtitle: null }) as never}
      identitiesHidden={false} onSetIdentitiesHidden={() => {}} onConnect={() => {}} onOpenIndex={() => {}}
      onOpenService={() => {}} onOpenAccount={() => {}} onOpenPool={() => {}} onOpenAgentSignIn={() => {}}
      renderAccountMeta={() => null} gateways={[]} onAddGateway={() => {}}
    />,
  );
  const add = screen.findHostByTestId('connected-services-rail:add-gateway')!;
  await act(async () => add.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 16, height: 16 } } }));
  const frame = screen.root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true' && node.parent === screen.findHostByTestId('connected-services-rail:add-gateway'))[0]!;
  expect([-frame.props.style.top, -frame.props.style.bottom]).toEqual([8, 8]);
});
