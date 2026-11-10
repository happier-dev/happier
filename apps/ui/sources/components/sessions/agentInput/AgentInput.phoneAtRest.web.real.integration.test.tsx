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

/** The window the composer reads its phone/desktop decision from, as a browser at that width reports it. */
function setWindowWidth(width: number) {
  // react-native-web reads the window from the document element when there is no visual viewport (jsdom).
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 844,
  });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

async function measureEmptyComposer(width: number) {
  setWindowWidth(width);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const suggestions = async () => [];
  await act(async () => {
    root!.render(
      <runtime.Wrapper>
        <div style={{ width, padding: '0 16px', boxSizing: 'border-box' }}>
          <AgentInput
            sessionId="s1"
            value=""
            placeholder="Message"
            onChangeText={() => {}}
            onSend={() => {}}
            connectionStatus={{ text: 'Ready', color: 'gray', dotColor: 'gray' }}
            autocompleteKinds={[]}
            autocompleteSuggestions={suggestions}
          />
        </div>
      </runtime.Wrapper>,
    );
  });
  const layout = await measureWebLayout(container, {
    viewport: { width, height: 844 },
    settle: (replay) => act(replay),
  });
  const card = layout.rect('agent-input-material-surface');
  const field = layout.rect('session-composer-input');
  const statusLine = layout.rect('agent-input-connection-line');
  return { contentInset: field.left - card.left, statusLineOffset: statusLine.left - field.left };
}

describe('the empty composer at rest, as a browser lays it out', () => {
  it('on a 390 phone puts its content 12 in from the card, so the card stands on 16 and its content on 28 (lab D13)', async () => {
    const { contentInset } = await measureEmptyComposer(390);
    expect(contentInset).toBeGreaterThanOrEqual(11.5);
    expect(contentInset).toBeLessThanOrEqual(12.5);
  });

  it('on a 390 phone starts the status line above the card on the same content line (lab: status row on 28)', async () => {
    const { statusLineOffset } = await measureEmptyComposer(390);
    expect(Math.abs(statusLineOffset)).toBeLessThanOrEqual(0.5);
  });

  it('keeps the desktop anatomy: content 18 in from the card at 1024', async () => {
    const { contentInset } = await measureEmptyComposer(1024);
    expect(contentInset).toBeGreaterThanOrEqual(17.5);
    expect(contentInset).toBeLessThanOrEqual(18.5);
  });
});
