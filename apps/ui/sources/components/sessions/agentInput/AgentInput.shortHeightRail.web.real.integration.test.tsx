/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installWebLayoutBridge();
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
vi.mock(
  '@/components/ui/forms/MultiTextInput',
  async () => import('@/components/ui/forms/MultiTextInput.web'),
);
installAgentInputCommonModuleMocks({
  reactNative: async () => import('@/platform/shims/reactNativeWebShim'),
});
vi.doMock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const mock = createReanimatedModuleMock();
  const rn =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  const hosts = { View: rn.View, ScrollView: rn.ScrollView, Text: rn.Text };
  return { ...mock, ...hosts, default: { ...mock.default, ...hosts } };
});
const { installSessionPaneRuntimeTestHarness } =
  await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();
const { AgentInput } = await import('./AgentInput');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

const VIEWPORT = { width: 720, height: 450 } as const;
const PROMPT = 'Build a tiny, private bakery website with a menu and opening hours.';
const SETUP_CHIP = [{ kind: 'badge' as const, key: 'setup', label: 'Reviewed app setup', testID: 'rail-setup-chip' }];

function setWindow() {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: VIEWPORT.height });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  window.dispatchEvent(new Event('resize'));
}

/** A seeded draft composer at 200% zoom: the host leaves the card little room, and a chip rides above the prompt. */
async function measureShortComposer(maxPanelHeight: number) {
  setWindow();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const suggestions = async () => [];
  await act(async () => {
    root!.render(
      <runtime.Wrapper>
        <div style={{ width: VIEWPORT.width, padding: '0 16px', boxSizing: 'border-box' }}>
          <AgentInput
            value={PROMPT}
            placeholder="Message"
            onChangeText={() => {}}
            onSend={() => {}}
            attachmentRowItems={SETUP_CHIP}
            maxPanelHeight={maxPanelHeight}
            panelMaxHeightMode="host-constrained"
            autocompleteKinds={[]}
            autocompleteSuggestions={suggestions}
          />
        </div>
      </runtime.Wrapper>,
    );
  });
  const layout = await measureWebLayout(container, {
    viewport: VIEWPORT,
    edgeProbeTestIds: ['new-session-composer-input-viewport'],
    settle: (replay) => act(replay),
    ...(process.env.HAPPIER_TEST_SHORT_RAIL_SHOT ? { screenshotPath: process.env.HAPPIER_TEST_SHORT_RAIL_SHOT } : {}),
  });
  return { field: layout.rect('new-session-composer-input-viewport') };
}

describe('the composer prompt when the host leaves it little height', () => {
  // DESIGN-ACCEPT-4 R1: at 200% zoom the chip rail kept its height and the prompt collapsed to its descenders.
  it('keeps one full line of the prompt visible under the attachment rail', async () => {
    const { field } = await measureShortComposer(150);
    // The field's own viewport (what the person sees of the prompt) holds a 22.4 px line of the composer's
    // 16 px type, and no section or card edge cuts into it from above or below (its trailing side sits under the
    // field's own read-aloud and voice tools, so only its top and bottom are probed).
    expect(field.height).toBeGreaterThanOrEqual(22.4);
    expect(field.receivesPointerAtEdges).toMatchObject({ top: true, bottom: true });
  });
});
