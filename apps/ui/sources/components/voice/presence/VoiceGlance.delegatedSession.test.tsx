import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  createSessionFixture,
  renderScreen,
  standardCleanup,
  type RenderScreenResult,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const routerMock = vi.hoisted(() => ({
  current: null as null | { spies: Record<string, ReturnType<typeof vi.fn>> },
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock({ pathname: () => '/' });
  routerMock.current = mock as never;
  return mock.module;
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } =
  await import('@/sync/domains/settings/voiceSettings');
const { setVoiceSessionSnapshot } =
  await import('@/voice/session/voiceSessionStore');
const { useVoiceSurfaceModel } =
  await import('@/components/voice/surface/useVoiceSurfaceModel');
const { VoiceGlance } = await import('./VoiceGlance');

/**
 * The Glance's delegated-work row is the person's way to the Session doing the work. Both real
 * hosts (Companion section and container popover) mount the sidebar surface, where the Voice
 * agent's teleport is not offered; the row still opens the working Session through the ordinary
 * `session.open` Action, on that Session's exact Home.
 */

const WORKING_SESSION_ID = 'working-session';

let screen: RenderScreenResult | null = null;

afterEach(async () => {
  await screen?.unmount();
  screen = null;
  standardCleanup();
  await homes.reset();
});

function SidebarGlance() {
  const model = useVoiceSurfaceModel({ variant: 'sidebar' });
  return model ? <VoiceGlance model={model} presentation="companion" /> : null;
}

describe('VoiceGlance delegated-work row', () => {
  it('opens the working Session from the sidebar Glance', async () => {
    const serverUrl = 'https://voice-delegated-session.test';
    const serverId = await homes.addHome({
      name: 'Voice Home',
      serverUrl,
      accountId: 'account-a',
    });
    const connection = await restoreServerAccountForTest({
      serverUrl,
      accountId: 'account-a',
      request: homes.request,
    });
    onTestFinished(() => connection.dispose());
    getStorage().setState((state) => ({
      ...state,
      isDataReady: true,
      settings: {
        ...state.settings,
        voice: voiceSettingsParse({
          providerId: 'local_conversation',
          ui: { activityFeedEnabled: false },
        }),
      },
      sessions: {
        ...state.sessions,
        [WORKING_SESSION_ID]: createSessionFixture({
          id: WORKING_SESSION_ID,
          serverId,
          thinking: true,
          thinkingAt: 10,
          presence: 'online',
          active: true,
          metadata: {
            path: '/workspace',
            host: 'test',
            summaryText: 'Dashboard auth',
          },
        }),
      },
    }));
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: WORKING_SESSION_ID,
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });
    screen = await renderScreen(<SidebarGlance />);

    const row = screen.findByTestId('voice-glance-handoff');
    expect(row?.props.disabled).toBeFalsy();
    expect(row?.props.accessibilityRole).toBe('button');

    await act(async () => {
      row?.props.onPress?.();
    });
    const navigate = routerMock.current!.spies.navigate!;
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(String(navigate.mock.calls.at(-1)?.[0])).toContain(
      WORKING_SESSION_ID,
    );
  });
});
