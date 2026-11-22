import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import * as reducer from '@/sync/domains/browser/control/reducer';
import { BrowserSurfaceHost } from './BrowserSurfaceHost';

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;
beforeEach(async () => {
  connection = await restoreServerAccountForTest({
    serverUrl: 'https://detail-title.example.test',
    serverIdentityId: 'srv_detail_title',
    request: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/profile')
        return Response.json({
          profile: AccountProfileSchema.parse({ id: 'account-a' }),
        });
      if (path === '/v1/account/encryption')
        return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness')
        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/features')
        return Response.json(
          createRootLayoutFeaturesResponse({
            features: {
              browser: {
                enabled: true,
                internal: { enabled: true },
                viewTargets: { enabled: true },
              },
            },
          }),
        );
      return null;
    },
  });
});
afterEach(async () => {
  await standardCleanup();
  await connection?.dispose();
  clearBrowserRuntimeControlRegistryForTests();
});

async function keptPage() {
  const { buildBrowserAdapterCapabilities } =
    await import('@/sync/domains/browser/adapters/capabilities');
  return [
    {
      kind: 'sessionCreated',
      eventId: 'e1',
      browserSessionId: 'launchpad',
      profileId: 'profile_1',
      occurredAt: 1,
    },
    {
      kind: 'viewOpened',
      eventId: 'e2',
      browserSessionId: 'launchpad',
      viewId: 'view_1',
      target: {
        kind: 'externalUrl',
        targetId: 'page_1',
        url: 'https://en.wikipedia.org/wiki/Price_point',
        display: { title: 'Price point' },
      },
      platform: 'web',
      currentUrl: 'https://en.wikipedia.org/wiki/Price_point',
      adapterKind: 'externalUrl',
      engineKind: 'webIframe',
      adapterCapabilities: buildBrowserAdapterCapabilities({
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['webIframe'],
      }),
      occurredAt: 2,
    },
    {
      kind: 'viewFocused',
      eventId: 'e3',
      browserSessionId: 'launchpad',
      viewId: 'view_1',
      occurredAt: 3,
    },
  ].reduce(
    (state, event) => reducer.applyBrowserControlEvent(state, event as never),
    reducer.createBrowserControlState(),
  );
}

describe('a Details tab is named by the page its Browser shows (DESIGN-ACCEPT-142 item 13)', () => {
  it('publishes the kept page\'s title on mount, so a reopened launchpad tab no longer reads "Browser"', async () => {
    const setDetailTitle = vi.fn();
    const screen = await renderScreen(
      <NavigationTitleChromeProvider
        showsTitle={false}
        publisher={{ setDetailTitle }}
      >
        <BrowserSurfaceHost
          browserSessionId="launchpad"
          platform="web"
          initialBrowserState={await keptPage()}
          policy={{
            browserEnabled: true,
            viewTargetsEnabled: true,
            diagnosticsEnabled: false,
            contextEnabled: false,
          }}
          testID="title-host"
        />
      </NavigationTitleChromeProvider>,
    );
    try {
      await flushHookEffects();
      expect(setDetailTitle).toHaveBeenLastCalledWith('Price point');
    } finally {
      await screen.unmount();
    }
    // Leaving withdraws the presented name, so the tab falls back to its own title.
    expect(setDetailTitle).toHaveBeenLastCalledWith(null);
  });

  it('a launchpad reports the page it already holds on mount, so the page gets its tab (pin, close)', async () => {
    const onViewStateChange = vi.fn();
    const render = async (reportsShownView: boolean) => renderScreen(
      <BrowserSurfaceHost browserSessionId="launchpad" platform="web" initialBrowserState={await keptPage()}
        policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
        onViewStateChange={onViewStateChange} reportsShownView={reportsShownView} testID="shown-host" />,
    );
    const page = await render(true);
    try {
      await flushHookEffects();
      expect(onViewStateChange).toHaveBeenCalledWith(expect.objectContaining({ viewId: 'view_1', title: 'Price point' }));
    } finally { await page.unmount(); }
    // A page tab only hydrates: its stored resource already names it.
    onViewStateChange.mockClear();
    const tab = await render(false);
    try {
      await flushHookEffects();
      expect(onViewStateChange).not.toHaveBeenCalled();
    } finally { await tab.unmount(); }
  });
});
