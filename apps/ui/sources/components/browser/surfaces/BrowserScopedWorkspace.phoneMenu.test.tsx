import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { BrowserShell } from '@/components/browser/BrowserShell';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import {
  useAppPaneScope,
  type AppPaneScopeApi,
} from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
  createRetainedPresentationSlotsStore,
  RetainedPresentationSlotsProvider,
} from '@/components/ui/presentation/retainedPresentationSlots';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { BrowserScopedWorkspace } from './BrowserScopedWorkspace';
import {
  createBrowserLaunchpadDetailsTab,
  createBrowserViewDetailsTab,
} from './browserSurfaceDetailsTabModel';

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

// A 390-wide phone window: the Browser's chrome density and the Details workspace's device class read the window
// (canonical React Native boundary mock).
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  const window = { width: 390, height: 844, scale: 3, fontScale: 1 };
  return createReactNativeWebMock({
    useWindowDimensions: () => window,
    Dimensions: { get: () => window, addEventListener: () => ({ remove: () => {} }) },
  });
});
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;
beforeEach(async () => {
  connection = await restoreServerAccountForTest({
    serverUrl: 'https://phone-menu.example.test',
    serverIdentityId: 'srv_phone_menu',
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

/** The phone More → Browser composition (`BrowserMobileSurfaceScreen`): a collapsed single-group workspace. */
function PhoneBrowser(
  props: Readonly<{ pane: { current?: AppPaneScopeApi }; onCloseLast?: () => void }>,
) {
  props.pane.current = useAppPaneScope('session:phone-menu');
  return (
    <BrowserScopedWorkspace
      scopeId="session:phone-menu"
      scope={{
        kind: 'session',
        sessionId: 'session-1',
        serverId: connection!.serverId,
      }}
      localServicePreviewServerId={connection!.serverId}
      openScope="sessionMobile"
      platform="web"
      collapseSingleTab
      closeLastTab={props.onCloseLast}
      keepAliveAboveRouter
      presentationSlotId="phone-menu-slot"
      testID="phone-browser"
    />
  );
}

function menuItemIds(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): string[] {
  const menus = screen.findAll(
    (node) =>
      typeof node.props?.testID === 'string' &&
      node.props.testID.endsWith('-overflow') &&
      Array.isArray(node.props.items),
  );
  return menus.flatMap((menu) =>
    (menu.props.items as { id: string }[]).map((item) => item.id),
  );
}

describe('the phone Browser offers Pin and Close on every path (DESIGN-ACCEPT-142 item 3)', () => {
  it.each([
    [
      'a page',
      () =>
        createBrowserViewDetailsTab({
          browserSessionId: 'phone-browser',
          viewId: 'phone-view',
          target: {
            kind: 'externalUrl',
            targetId: 'page-1',
            url: 'https://en.wikipedia.org/wiki/Price_point',
          },
          currentUrl: 'https://en.wikipedia.org/wiki/Price_point',
        }),
    ],
    ['the launchpad tab', () => createBrowserLaunchpadDetailsTab()],
  ] as const)(
    "More → Browser showing %s: its one ⋯ carries the tab's pin and close",
    async (_label, createTab) => {
      const pane: { current?: AppPaneScopeApi } = {};
      const store = createRetainedPresentationSlotsStore();
      const onCloseLast = vi.fn();
      const screen = await renderScreen(
        <AppPaneProvider>
          <RetainedPresentationSlotsProvider store={store}>
            <PhoneBrowser pane={pane} onCloseLast={onCloseLast} />
          </RetainedPresentationSlotsProvider>
        </AppPaneProvider>,
      );
      try {
        await flushHookEffects();
        await act(async () =>
          pane.current!.openDetailsTab(createTab(), { intent: 'preview' }),
        );
        await flushHookEffects({ cycles: 10 });
        expect(screen.findByType(BrowserShell)).not.toBeNull();
        // One tab bar on a phone: no strip above the Browser's own chrome.
        expect(
          screen.findAll(
            (node) =>
              node.props?.testID === 'phone-browser-tab-strip' ||
              node.props?.testID === 'details-tab-strip',
          ),
        ).toHaveLength(0);
        const ids = menuItemIds(screen);
        expect(ids).toContain('details-tab-pin');
        expect(ids).toContain('details-tab-close');
        await act(async () =>
          pane.current!.pinDetailsTab(
            pane.current!.scopeState!.details.tabs[0]!.key,
          ),
        );
        await flushHookEffects({ cycles: 10 });
        expect(menuItemIds(screen)).toContain('details-tab-unpin');
        // Closing the last page leaves the Browser for the chat, as a phone Details pane does; it never strands the
        // person on a page that no longer has a tab.
        const close = screen.findAll((node) => typeof node.props?.testID === 'string' && node.props.testID.endsWith('-overflow')
          && Array.isArray(node.props.items))[0]!.props.items.find((item: { id: string }) => item.id === 'details-tab-close');
        await act(async () => { close.onPress(); });
        await flushHookEffects({ cycles: 5 });
        expect(onCloseLast).toHaveBeenCalledTimes(1);
      } finally {
        await screen.unmount();
      }
    },
  );
});
