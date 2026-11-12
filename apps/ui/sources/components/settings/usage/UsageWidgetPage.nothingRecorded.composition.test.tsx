import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { t } from '@/text';
import { UsageWidgetPage } from './UsageWidgetPage';

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    pathname: '/settings/usage',
    segments: () => ['(app)', 'settings', 'usage'],
    params: () => ({}),
  }).module;
});

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

// A first-use Account: the period was read and nothing was recorded in it.
const nothing: UsageAnalyticsQueryResponse = {
  v: 1,
  totals: {
    eventCount: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
  },
  breakdowns: {},
};

const geometry = {
  measureInWindow: (
    done: (x: number, y: number, width: number, height: number) => void,
  ) => done(0, 0, 1000, 300),
};
const pageGeometry = {
  createNodeMock: (node: Readonly<{ props: Record<string, unknown> }>) =>
    node.props.testID === 'usage-page'
      ? { getInnerViewRef: () => geometry }
      : geometry,
};

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;

afterEach(async () => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
});

describe('a period with nothing recorded', () => {
  it('says so once for the page, with the next step, and the bodies do not repeat it (C first use)', async () => {
    const artifacts = createArtifactStoreBoundary({
      ownerAccountId: () => 'account-a',
      encryptionMode: 'plain',
    });
    home = await serveActionHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://usage-nothing-recorded.test',
          accountId: 'account-a',
        },
      ],
      route: (request) =>
        request.path === '/v1/features' ||
        request.path === '/v1/features/authenticated'
          ? Response.json(createRootLayoutFeaturesResponse())
          : request.path === '/v1/kv/bulk'
            ? Response.json({ values: [] })
            : request.path === '/v2/usage/query'
              ? Response.json(nothing)
              : request.path === '/v2/usage/query-batch'
                ? undefined
                : (artifacts.handle(request.url.toString(), {
                    method: request.method,
                  }) ??
                  createEmptyAccountBootstrapHttpResponse(request.path, {
                    method: request.method,
                  }) ??
                  undefined),
    });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({
      serverId: server.id,
      serverUrl: server.serverUrl,
      generation: 0,
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      server.serverUrl,
    ))!;
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={credentials}>
        <MainAppTabStateProvider>
          <AppPaneProvider>
            <CurrentUiContextProvider>
              <UsageWidgetPage
                initialFilters={{
                  layoutId: 'usage',
                  period: '7days',
                  metric: 'tokens',
                  costMode: 'auto',
                  focus: null,
                }}
              />
            </CurrentUiContextProvider>
          </AppPaneProvider>
        </MainAppTabStateProvider>
      </InjectedAuthProvider>,
      pageGeometry,
    );
    await act(async () =>
      screen
        .findByTestId('usage-page')!
        .props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 900 } },
        }),
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findHostByTestId('usage-page.header.nothingRecorded'),
      ).not.toBeNull(),
    );
    expect(
      screen.findAllHostsByTestId('usage-page.header.nothingRecorded'),
    ).toHaveLength(1);
    expect(
      screen.findHostByTestId('usage-page.header.nothingRecordedAction'),
    ).not.toBeNull();
    // The cause is said once, by the page, short enough for a phone's one header line; each card holds one quiet line.
    const text = screen.getTextContent();
    expect(text.split(t('usage.board.page.noUsageTitle')).length - 1).toBe(1);
    expect(text).not.toContain(t('usage.board.page.noUsageReason'));
  });
});
