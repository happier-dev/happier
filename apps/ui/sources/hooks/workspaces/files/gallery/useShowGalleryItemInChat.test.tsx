import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { SessionCockpitSurfaceNavigationProvider } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
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
    <SessionCockpitSurfaceNavigationProvider
      value={{ switchSurface, returnToPreviousSurface() {} }}
    >
      <Test />
    </SessionCockpitSurfaceNavigationProvider>
    </InjectedAuthProvider>,
  );
  let result: Awaited<ReturnType<typeof show>> | undefined;
  await act(async () => {
    result = await show({ messageLocalId: 'shots' });
  });
  expect(switchSurface).toHaveBeenCalledExactlyOnceWith('chat');
  expect(result).toEqual({ ok: true, query: { jumpSeq: 7 } });
});
