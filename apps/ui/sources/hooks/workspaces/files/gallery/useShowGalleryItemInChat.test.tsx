import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { SessionCockpitSurfaceNavigationProvider } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { AppPaneScopeLayoutProvider, type AppPaneScopeLayoutState } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useShowGalleryItemInChat } from './useShowGalleryItemInChat';

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});

await loadSyncSingletonForTests();
const account = createProviderSettingsAccountHarness();
afterEach(async () => {
  await standardCleanup();
  await account.reset();
});

it('brings the chat forward on a phone before the transcript jumps to the picture’s message (lab pr974 SM1jp)', async () => {
  // The message isn't loaded on this device: the exact transcript read answers through the Home's HTTP boundary.
  const home = await account.restore({
    accountId: 'chat-account',
    currentAccount: true,
    serverIdentityId: 'srv_chat_home',
    httpAnswers: {
      'GET /v2/sessions/session/messages/by-local-id/shots': { body: { message: { localId: 'shots', seq: 7 } } },
    },
  });
  const switchSurface = vi.fn();
  let show!: ReturnType<typeof useShowGalleryItemInChat>;
  function Test() {
    const lifetime = useActiveServerAccountScopeLifetime(true);
    show = useShowGalleryItemInChat(
      { sessionId: 'session', serverId: home.serverId },
      lifetime,
    );
    return null;
  }
  await renderScreen(
    <InjectedAuthProvider credentials={null}>
      <AppPaneProvider>
        <SessionCockpitSurfaceNavigationProvider
          value={{ switchSurface, returnToPreviousSurface() {} }}
        >
          <Test />
        </SessionCockpitSurfaceNavigationProvider>
      </AppPaneProvider>
    </InjectedAuthProvider>,
  );
  let result: Awaited<ReturnType<typeof show>> | undefined;
  await act(async () => {
    result = await show({ messageLocalId: 'shots' });
  });
  expect(switchSurface).toHaveBeenCalledExactlyOnceWith('chat');
  expect(result).toEqual({ ok: true, query: { jumpSeq: 7 } });
});

it('closes a Details drawer that covers the chat on a desktop and keeps the docked Files pane beside it open (rounds 2-3 B2)', async () => {
  const home = await account.restore({
    accountId: 'chat-account',
    currentAccount: true,
    serverIdentityId: 'srv_chat_home',
    httpAnswers: {
      'GET /v2/sessions/session/messages/by-local-id/shots': { body: { message: { localId: 'shots', seq: 7 } } },
    },
  });
  const scopeId = createSessionPaneScopeId('session', home.serverId);
  // The Media tab is open in a Details drawer over the Session (1440 with Files docked beside it).
  const drawerOverChat: AppPaneScopeLayoutState = {
    arrangement: 'session', mainHidden: false, mainDrawerOpen: false, effectiveDetailsOpen: true, detailsAvailable: false,
    containerWidthPx: 1100, containerHeightPx: 860, mainRegionWidthPx: 700, mainRegionHeightPx: 860,
    multiPaneEnabled: true, deviceType: 'tablet', bottomPresentation: 'hidden',
    layout: { kind: 'twoPane', main: 'docked', right: 'docked', details: 'overlay' },
  };
  let detailsOpen: boolean | undefined;
  let filesOpen: boolean | undefined;
  let show!: ReturnType<typeof useShowGalleryItemInChat>;
  function Test() {
    const context = useAppPaneContext();
    detailsOpen = context.state.scopes[scopeId]?.details.isOpen;
    filesOpen = context.state.scopes[scopeId]?.right.isOpen;
    React.useEffect(() => {
      context.dispatch({ type: 'activateScope', scopeId });
      context.dispatch({ type: 'openRight', scopeId, tabId: 'files' });
      context.dispatch({ type: 'openDetailsTab', scopeId, tab: { key: 'session-media', kind: 'session-gallery', title: 'Media', resource: {} }, openAs: 'pinned' });
    }, [context.dispatch]);
    const lifetime = useActiveServerAccountScopeLifetime(true);
    show = useShowGalleryItemInChat({ sessionId: 'session', serverId: home.serverId }, lifetime);
    return null;
  }
  await renderScreen(
    <InjectedAuthProvider credentials={null}>
      <AppPaneProvider>
        <AppPaneScopeLayoutProvider value={drawerOverChat}>
          <Test />
        </AppPaneScopeLayoutProvider>
      </AppPaneProvider>
    </InjectedAuthProvider>,
  );
  expect(detailsOpen).toBe(true);
  expect(filesOpen).toBe(true);
  let result: Awaited<ReturnType<typeof show>> | undefined;
  await act(async () => {
    result = await show({ messageLocalId: 'shots' });
  });
  expect(result).toEqual({ ok: true, query: { jumpSeq: 7 } });
  expect(detailsOpen).toBe(false);
  // The docked Files pane never covered the chat: it stays, with the Media grid and its ringed tile in it.
  expect(filesOpen).toBe(true);
});
