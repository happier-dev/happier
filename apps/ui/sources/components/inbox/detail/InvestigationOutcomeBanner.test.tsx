import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

afterEach(() => {
  standardCleanup();
});

const { InvestigationOutcomeBanner } =
  await import('./InvestigationOutcomeBanner');
const { PluginSurfaceDestinationNavigationBindingProvider } =
  await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
const { TRIAGE_APP_PAGE_DESTINATION_V1 } = await import('@happier-dev/triage-protocol/v1');

function render(code: string) {
  return renderScreen(
    <InvestigationOutcomeBanner
      outcome={{ kind: 'unavailable', code }}
      serverId="home-a"
      onChoosePlacement={() => {}}
      pending={false}
    />,
  );
}

describe('Investigation outcome banner', () => {
  it('tells the person the catalog could not be reached, not that nothing is set up', async () => {
    // `catalogUnavailable` is the read that did not answer (for example while the Account reconnects).
    const screen = await render('catalogUnavailable');
    expect(screen.getTextContent()).toContain(
      'inbox.work.healthNotice.unavailableTitle',
    );
    expect(screen.getTextContent()).not.toContain(
      'inbox.work.healthNotice.notSetUpTitle',
    );
  });

  it('keeps the set-up step for a catalog that answered with no investigation', async () => {
    const screen = await render('configuredActionUnavailable');
    expect(screen.getTextContent()).toContain(
      'inbox.work.healthNotice.notSetUpTitle',
    );
  });

  // QA-ACTION-PARITY-1109 r117: the Environment's "Set it up" ended on "Set one up in PRs, Issues & Tasks" with no way
  // there. The set-up step opens the one actions editor (Triage's page, the same open as Edit action…) on the record pressed.
  it.each([
    ['the record pressed', 'deployments.set-up', { v: 1, kind: 'actionEditor', actionId: 'deployments.set-up' }],
    ['the actions list when no record answered', undefined, { v: 1, kind: 'actionEditor' }],
  ] as const)('leads the set-up step to the actions editor on %s', async (_case, configuredActionId, input) => {
    const opened: unknown[] = [];
    // The host's destination navigation is the route boundary; the editor is Triage's own page.
    const navigation = { targetKind: 'app' as const, registerOwner: () => () => {},
      openSurface: (request: unknown) => { opened.push(request); return { ok: true as const }; } };
    const screen = await renderScreen(
      <PluginSurfaceDestinationNavigationBindingProvider binding={navigation}>
        <InvestigationOutcomeBanner
          outcome={{ kind: 'unavailable', code: 'configuredActionUnavailable',
            ...(configuredActionId === undefined ? {} : { configuredActionId }) }}
          serverId="home-a" onChoosePlacement={() => {}} pending={false} />
      </PluginSurfaceDestinationNavigationBindingProvider>,
    );
    const open = screen.findByTestId('inbox.notice.investigate.unavailable.action');
    expect(open).not.toBeNull();
    await act(async () => { open!.props.onPress(); });
    expect(opened).toEqual([{ destination: TRIAGE_APP_PAGE_DESTINATION_V1, input, subPath: '' }]);
  });
});
