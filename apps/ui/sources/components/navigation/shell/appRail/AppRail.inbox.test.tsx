import * as React from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { resolveCompactAppDestinations, useActivateAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';

import { AppRailSurface } from './AppRail';
import { buildAppRailEntries } from './appRailModel';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
    styleSheet: { hairlineWidth: 1 },
  }),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
    { maxHeight: 600, maxWidth: 400, placement: 'bottom' }),
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => standardCleanup());

function entries() {
  return buildAppRailEntries(
    resolveCompactAppDestinations({
      builtins: {
        externalSessions: true,
        inbox: true,
        workflows: true,
        friends: true,
      },
      pages: [],
    }),
  );
}

function Rail(props: Readonly<{ activeId: string | null }>) {
  const onOpen = useActivateAppDestination();
  return <AppRailSurface entries={entries()} activeId={props.activeId} onOpen={onOpen}
    renderFooter={item => <View testID={item.id} />} />;
}

describe('AppRail Inbox', () => {
  it.each([null, 'inbox'])('opens the Inbox page from the pinned link (active=%s)', async activeId => {
    const router = useRouter();
    vi.mocked(router.navigate).mockClear();
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <InboxSummaryProvider><Rail activeId={activeId} /></InboxSummaryProvider>
    </InjectedAuthProvider>);

    expect(screen.findHostByTestId('app-rail:inbox')?.props).toMatchObject({
      role: 'link', accessibilityLabel: 'tabs.inbox',
    });
    await screen.pressByTestIdAsync('app-rail:inbox');
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/inbox');
    expect(screen.findByTestId('inbox.popover.open')).toBeNull();
  });
});
