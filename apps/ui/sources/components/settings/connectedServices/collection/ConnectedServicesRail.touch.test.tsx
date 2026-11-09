import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(() => vi.unstubAllGlobals());

it("splits the navigation bar's action gap with the folded menu instead of reaching into it", async () => {
  // The primary pointer is read once per app load, so this lives in its own file.
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const { NavigationTitleChromeProvider } =
    await import('@/components/ui/layout/navigationTitleChrome');
  const { ConnectedServicesRailView } = await import('./ConnectedServicesRail');
  const model = buildConnectedServicesIndexModel({
    transport: 'advertised-v4',
    entries: [],
    qualifiedAccounts: [],
    qualifiedGroups: [],
    legacyServices: [],
    defaultAccountByServiceKey: {},
    resolveLabel: () => '',
    resolveFallbackEntry: () => null,
    presentDiagnostics: () => ({ primary: null, supportDetails: null }),
    loadingLabel: 'Loading',
    agentUses: [],
  });
  const phone = await renderScreen(
    <NavigationTitleChromeProvider showsTitle>
      <ConnectedServicesRailView
        model={model}
        labelsByKey={{}}
        selection={{ kind: 'index' }}
        variant="page"
        present={(input) =>
          ({ title: input.label ?? '', subtitle: null }) as never
        }
        identitiesHidden={false}
        onSetIdentitiesHidden={() => {}}
        onConnect={() => {}}
        onOpenIndex={() => {}}
        onOpenService={() => {}}
        onOpenAccount={() => {}}
        onOpenPool={() => {}}
        onOpenAgentSignIn={() => {}}
        renderAccountMeta={() => null}
      />
    </NavigationTitleChromeProvider>,
  );
  const bar = phone.root.findAll(
    (node) => node.props.primary === null && node.props.trailing !== undefined,
  )[0]!;
  const trailing = await renderScreen(bar.props.trailing as React.ReactElement);
  const connect = trailing.findHostByTestId('connected-services-rail:connect')!;
  await act(async () =>
    connect.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 28, height: 28 } },
    }),
  );
  const frame = trailing.root.findAll(
    (node) => node.props?.dataSet?.happierHitArea === 'true',
  )[0]!;
  // Half of the bar's 8 px action gap on each side; the 44 px target alone would reach 8.
  expect([-frame.props.style.left, -frame.props.style.right]).toEqual([4, 4]);
});

// The bar names the parent on a phone (owner 11-05), so the list names the page. Without it this page had no name.
it('names the Credentials page in the list when the bar above names only the parent', async () => {
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const { ConnectedServicesRailView } = await import('./ConnectedServicesRail');
  const { NavigationTitleChromeProvider, NavigationLargeTitleProvider } = await import('@/components/ui/layout/navigationTitleChrome');
  const model = buildConnectedServicesIndexModel({
    transport: 'advertised-v4', entries: [], qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
    defaultAccountByServiceKey: {}, resolveLabel: () => '', resolveFallbackEntry: () => null,
    presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: [],
  });
  const screen = await renderScreen(
    <NavigationTitleChromeProvider showsTitle><NavigationLargeTitleProvider largeTitle>
      <ConnectedServicesRailView
        model={model} labelsByKey={{}} selection={{ kind: 'index' }} variant="page"
        present={(input) => ({ title: input.label ?? '', subtitle: null }) as never}
        identitiesHidden={false} onSetIdentitiesHidden={() => {}} onConnect={() => {}} onOpenIndex={() => {}}
        onOpenService={() => {}} onOpenAccount={() => {}} onOpenPool={() => {}} onOpenAgentSignIn={() => {}}
        renderAccountMeta={() => null} gateways={[]} onAddGateway={() => {}}
      />
    </NavigationLargeTitleProvider></NavigationTitleChromeProvider>,
  );
  const { t } = await import('@/text');
  expect(screen.getTextContent()).toContain(t('connectedServicesCollection.indexTitle'));
});

it("gives a group's add the height of its label row, and no further: the first row is directly beneath", async () => {
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const { ConnectedServicesRailView } = await import('./ConnectedServicesRail');
  const model = buildConnectedServicesIndexModel({
    transport: 'advertised-v4', entries: [], qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
    defaultAccountByServiceKey: {}, resolveLabel: () => '', resolveFallbackEntry: () => null,
    presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: [],
  });
  const screen = await renderScreen(
    <ConnectedServicesRailView
      model={model} labelsByKey={{}} selection={{ kind: 'index' }} variant="page"
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
