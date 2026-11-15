// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';
import {
  EmbeddedSessionControllerClaimsScope,
  EmbeddedSessionPartsProvider,
  EmbeddedSessionStandardLayout,
} from './EmbeddedSessionParts';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
// Vitest resolves the scaffold's stable entry to its native build, whose composer floats over a
// full-height content region. The browser ships the web scaffold (content and composer are flex
// siblings), so select it the way Metro's `.web` resolution does.
vi.mock('@/components/sessions/keyboardAvoidance/ComposerKeyboardScaffold', async () =>
  vi.importActual('@/components/sessions/keyboardAvoidance/ComposerKeyboardScaffold.web'),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const web =
    await vi.importActual<typeof import('react-native')>('react-native-web');
  const mock = createReanimatedModuleMock();
  // Animation stays at its platform boundary; the layout hosts are react-native-web's real Views.
  return {
    ...mock,
    View: web.View,
    ScrollView: web.ScrollView,
    default: { ...mock.default, View: web.View, ScrollView: web.ScrollView },
  };
});

installWebLayoutBridge();

// The live linked-Session specimen (READY200): the Session's composer at its natural height in a
// detail slot that has exactly that much room left.
const COMPOSER_HEIGHT = 148;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderInHost(roomHeight: number) {
  await act(async () =>
    root.render(
      <View
        testID="probe-host"
        style={{ height: roomHeight, width: 568, display: 'flex' }}
      >
        <EmbeddedSessionControllerClaimsScope>
          <EmbeddedSessionPartsProvider
            value={{
              transcript: (
                <View testID="probe-transcript" style={{ flex: 1 }} />
              ),
              placeholder: null,
              composer: (
                <View
                  testID="probe-composer"
                  style={{ height: COMPOSER_HEIGHT }}
                />
              ),
              state: 'ready',
              chatBottomSpacing: 'none',
            }}
          >
            <EmbeddedSessionStandardLayout />
          </EmbeddedSessionPartsProvider>
        </EmbeddedSessionControllerClaimsScope>
      </View>,
    ),
  );
  const m = await measureWebLayout(host, {
    viewport: { width: 800, height: 900 },
    settle: async (replay) => {
      await act(replay);
    },
  });
  return m;
}

it("keeps the transcript visible when the host has only the composer's room", async () => {
  const layout = await renderInHost(COMPOSER_HEIGHT);
  // The transcript viewport: what a reader actually sees of the conversation.
  const transcript = layout.rect('agent-content-scroll-region');
  expect(transcript.height).toBeGreaterThan(0);
  // The conversation never gets less room than the box you type into.
  expect(transcript.height).toBeGreaterThanOrEqual(COMPOSER_HEIGHT);
  // The composer is still there, below the conversation, in the same scrolling arrangement.
  expect(layout.rect('probe-composer').top).toBeGreaterThanOrEqual(
    transcript.bottom - 1,
  );
});

it('opens a short host at its end, so the composer (and a pending approval in it) is in view', async () => {
  await renderInHost(COMPOSER_HEIGHT);
  // The browser scroll offset does not cross the harness, so read where the arrangement was scrolled.
  const arrangement = host.querySelector<HTMLElement>('[data-testid="embedded-session-arrangement"]')!;
  expect(arrangement.scrollHeight).toBeGreaterThan(COMPOSER_HEIGHT);
  // Anchored at its end, as a chat is: the visible room is the arrangement's last COMPOSER_HEIGHT pixels.
  expect(arrangement.scrollTop + COMPOSER_HEIGHT).toBeGreaterThanOrEqual(arrangement.scrollHeight - 1);
});

it('fills a roomy host exactly, with the composer pinned at its foot', async () => {
  const layout = await renderInHost(600);
  const hostRect = layout.rect('probe-host');
  const transcript = layout.rect('agent-content-scroll-region');
  const composer = layout.rect('probe-composer');
  expect(Math.abs(composer.bottom - hostRect.bottom)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(transcript.height - (600 - COMPOSER_HEIGHT)),
  ).toBeLessThanOrEqual(1);
});
