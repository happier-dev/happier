// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

/**
 * A failed start as a browser lays out the composer's notice seat (visual acceptance, owner 2026-11-11). A live
 * start failure was not reachable on the QA stacks (a missing Agent is refused before a Session exists; a rejected
 * model fails the first turn), so this renders the real banner owner with a closed-catalog cause.
 */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const {
    View: WebView,
    ScrollView,
    Text,
  } = await vi.importActual<typeof import('react-native-web')>(
    'react-native-web',
  );
  const mock = createReanimatedModuleMock();
  const animated = { ...mock.default, View: WebView, ScrollView, Text };
  return { ...mock, ...animated, default: animated };
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});
// The icon SDK draws through native SVG; a browser only needs its box.
vi.mock('@hugeicons/react-native', async () => {
  const { View: WebView } =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  return {
    HugeiconsIcon: (props: { size?: number }) =>
      React.createElement(WebView, {
        style: { width: props.size ?? 16, height: props.size ?? 16 },
      }),
  };
});

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const EVIDENCE = process.env.HAPPIER_COMPOSER_CALM_EVIDENCE_DIR;
const TITLE = 'Couldn’t start this session';

async function renderSeat(width: number) {
  const { SessionStartFailureBanner } =
    await import('./SessionStartFailureBanner');
  const { resolveSessionStartFailureNotice } =
    await import('./sessionStartFailureNotice');
  const issue = SessionRuntimeIssueV1Schema.parse({
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    occurredAt: 1,
    code: 'mcp_tool_catalog_unavailable',
    source: 'dependency_failure',
    failureCause: {
      phase: 'client_start',
      failureReason: 'unknown',
      requestId: 'req-start-1',
    },
  });
  const notice = resolveSessionStartFailureNotice({
    issue,
    sessionActive: false,
  });
  expect(notice).not.toBeNull();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <View testID="frame" style={{ width }}>
        {/* SessionView's notice seat, directly above the composer column. */}
        <View testID="session-notices">
          <SessionStartFailureBanner
            notice={notice!}
            retry={{ run: () => {}, busy: false }}
          />
        </View>
        <View testID="composer" style={{ height: 120 }} />
      </View>,
    );
  });
  return {
    notice: notice!,
    layout: await measureWebLayout(host, {
      viewport: { width, height: 400 },
      texts: [TITLE, notice!.message],
      settle: (replay) => act(replay),
      ...(EVIDENCE
        ? { screenshotPath: `${EVIDENCE}/startfail-banner-${width}-light.png` }
        : {}),
    }),
  };
}

describe('a failed start in the composer notice seat, as a browser lays it out', () => {
  for (const width of [1440, 390]) {
    it(`states the closed cause once with its retry, inside the seat, at ${width}`, async () => {
      const { notice, layout } = await renderSeat(width);
      const frame = layout.rect('frame');
      const banner = layout.rect('session-start-failure');
      const retry = layout.rect('session-start-failure-retry');
      expect(notice.message).toBe(
        'An MCP tool catalog could not be read before Agent startup. Check the selected MCP servers, then retry the session.',
      );
      // One statement: one title and one cause sentence, with the retry inside the banner and the banner inside the seat.
      expect(layout.textRects(TITLE)).toHaveLength(1);
      expect(layout.textRects(notice.message)).toHaveLength(1);
      expect(retry.right).toBeLessThanOrEqual(banner.right + 0.5);
      expect(banner.left).toBeGreaterThanOrEqual(frame.left - 0.5);
      expect(banner.right).toBeLessThanOrEqual(frame.right + 0.5);
      expect(banner.bottom).toBeLessThanOrEqual(
        layout.rect('composer').top + 0.5,
      );
    });
  }
});
