// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
  type WebLayoutMeasurement,
} from '@/dev/testkit/render/measureWebLayout';

/** The composer's status row as a browser lays it out: a phone recomposes it rather than overflowing. */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
  // The animation SDK is a boundary, but the strip's entrance wrappers must keep real RNW layout
  // rather than the renderer testkit's symbolic element names (which a browser lays out inline).
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const { View, ScrollView, Text } =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  const mock = createReanimatedModuleMock();
  const animated = { ...mock.default, View, ScrollView, Text };
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

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const REASON = 'Connected services · Unavailable';

/** The New Session strip: a blocked-launch badge plus the draft's own actions ("Start another", "Delete draft"). */
type StripBadge = {
  label: string;
  labelNumberOfLines?: number;
  emphasis?: 'quiet' | 'prominent';
  tone?: 'neutral' | 'warning';
  testID?: string;
};

async function measureStrip(
  width: number,
  badge: StripBadge = { label: REASON, labelNumberOfLines: 0 },
  withActions = true,
  more: readonly StripBadge[] = [],
  statusRegions?: React.ComponentProps<typeof import('./SessionInstrumentStrip').SessionInstrumentStrip>['statusRegions'],
): Promise<WebLayoutMeasurement> {
  const { SessionInstrumentStrip } = await import('./SessionInstrumentStrip');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <View testID="frame" style={{ width }}>
        <SessionInstrumentStrip
          statusRegions={statusRegions}
          statusBadges={[
            {
              key: 'blocked',
              tone: 'warning',
              testID: 'badge',
              ...badge,
            },
            ...more.map((entry, index) => ({
              key: `more-${index}`,
              ...entry,
            })),
          ]}
          statusTrailingActions={
            withActions ? (
              <View testID="actions" style={{ width: 190, height: 20 }} />
            ) : undefined
          }
        />
      </View>,
    );
  });
  return measureWebLayout(host, {
    viewport: { width: Math.max(width, 400), height: 300 },
    texts: [badge.label, ...more.map((entry) => entry.label)],
    settle: (replay) => act(replay),
  });
}

describe('the composer status line on a phone (owner 2026-11-10)', () => {
  it('keeps a trailing instrument on the status line instead of wrapping it to a row of its own', async () => {
    const { SessionInstrumentStrip } = await import('./SessionInstrumentStrip');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <View testID="frame" style={{ width: 358 }}>
          <SessionInstrumentStrip
            connectionStatus={{
              text: 'Machine offline · message queued',
              color: '#b60',
              dotColor: '#b60',
              action: { label: 'Process when online', onPress: () => {} },
            }}
            statusTrailingActions={<View testID="gauge" style={{ width: 24, height: 24 }} />}
          />
        </View>,
      );
    });
    const layout = await measureWebLayout(host, {
      viewport: { width: 400, height: 300 },
      texts: ['Machine offline · message queued'],
      settle: (replay) => act(replay),
    });
    const frame = layout.rect('frame');
    const gauge = layout.rect('gauge');
    // One line: the strip is no taller than its line and the gauge sits on it, inside the edge.
    expect(frame.bottom - frame.top).toBeLessThanOrEqual(40);
    expect(gauge.right).toBeLessThanOrEqual(frame.right + 0.5);
    // The line keeps the room the gauge leaves: no empty half-line between its action and the gauge while its
    // sentence is crushed to a letter a line (native 2026-11-11).
    const sentence = layout.rect('agent-input-connection-status-text');
    const action = layout.rect('agent-input-connection-recovery');
    expect(gauge.left - action.right).toBeLessThanOrEqual(24);
    expect(sentence.right - sentence.left).toBeGreaterThan(100);
  });
});

describe('the status line band (owner 2026-11-11)', () => {
  it('centres its line in the band, so the free space is not all piled up between it and the composer', async () => {
    const { SessionInstrumentStrip } = await import('./SessionInstrumentStrip');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <View testID="frame" style={{ width: 800 }}>
          <SessionInstrumentStrip
            connectionStatus={{ text: 'Inactive (resumable)', color: '#888', dotColor: '#888' }}
          />
        </View>,
      );
    });
    const layout = await measureWebLayout(host, {
      viewport: { width: 800, height: 300 },
      texts: ['Inactive (resumable)'],
      settle: (replay) => act(replay),
    });
    const frame = layout.rect('frame');
    const line = layout.rect('agent-input-connection-line');
    const above = line.top - frame.top;
    const below = frame.bottom - line.bottom;
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
  });
});

describe('the status line right edge (owner 2026-11-11)', () => {
  it('ends the last visible instrument on the composer content edge when a plugin region renders nothing', async () => {
    // A plugin region with nothing to say (a Session with no pull request) must take no slot or gap.
    function EmptyRegion() {
      return null;
    }
    const layout = await measureStrip(800, { label: 'Ready', labelNumberOfLines: 1 }, false, [], [
      { emphasis: 'prominent', node: <EmptyRegion key="empty" /> },
    ]);
    const frame = layout.rect('frame');
    const badge = layout.rect('badge');
    // The strip's content edge is its own horizontal inset in from the frame (20 on a desktop composer).
    expect(frame.right - badge.right).toBeLessThanOrEqual(20.5);
  });
});

describe('the composer status row, as a browser lays it out', () => {
  it('keeps the badge and the draft actions on one line where they fit', async () => {
    const layout = await measureStrip(900);
    const badge = layout.rect('badge');
    const actions = layout.rect('actions');
    expect(
      Math.abs(
        (badge.top + badge.bottom) / 2 - (actions.top + actions.bottom) / 2,
      ),
    ).toBeLessThanOrEqual(3);
    expect(actions.right).toBeLessThanOrEqual(layout.rect('frame').right + 0.5);
  });

  it('on a phone gives the badge its own row and moves the actions beneath, all inside the strip', async () => {
    const layout = await measureStrip(358);
    const frame = layout.rect('frame');
    const badge = layout.rect('badge');
    const actions = layout.rect('actions');
    // Nothing runs past the strip's edge (before: the actions overflowed a 390 phone by ~90 px).
    expect(badge.right).toBeLessThanOrEqual(frame.right + 0.5);
    expect(actions.right).toBeLessThanOrEqual(frame.right + 0.5);
    // The badge stays one line at its natural width rather than squeezing into a multi-line capsule.
    expect(badge.height).toBeLessThanOrEqual(30);
    expect(actions.top).toBeGreaterThanOrEqual(badge.bottom);
    // Both stay right-aligned with the strip's content edge (its 20 px inset).
    expect(frame.right - badge.right).toBeLessThanOrEqual(20.5);
    expect(frame.right - actions.right).toBeLessThanOrEqual(20.5);
  });

  it('on a narrow strip ellipsizes a quiet note and a plain value before it shortens a prominent badge', async () => {
    // The Goal chip (prominent) beside the Session capability note (quiet), at the 388 px composer.
    const layout = await measureStrip(
      388,
      { label: 'Goal paused', testID: 'goal', tone: 'neutral' },
      false,
      [{ label: 'brand-voice turned off \u00b7 applied now to this Session', emphasis: 'quiet', testID: 'note' }],
    );
    expect(layout.rect('goal:label').clipped).not.toBe(true);
    expect(layout.rect('goal:label').text).toBe('Goal paused');
    expect(layout.rect('note:label').clipped).toBe(true);
    expect(layout.rect('note').right).toBeLessThanOrEqual(layout.rect('frame').right + 0.5);
  });

  it('keeps a long sentence badge inside the strip on a phone, wrapping its words instead of running past the edge', async () => {
    // The managed wake failure line: a sentence, passed with no explicit line count.
    const layout = await measureStrip(
      358,
      { label: 'Codex couldn\u2019t start. Your message is still queued. Ask someone who manages this machine to start it.' },
      false,
    );
    expect(layout.rect('badge').right).toBeLessThanOrEqual(layout.rect('frame').right + 0.5);
  });

  it('keeps a prominent admitted plugin badge whole beside a quiet host note', async () => {
    const { definePlugin } = await import('@happier-dev/plugin-sdk');
    const { parsePluginManifest } = await import('@happier-dev/plugin-sdk/manifest');
    const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');
    const { ComposerStatusBadge } = await import('@happier-dev/plugin-ui/components');
    const { HappierUiEnvironmentProvider, projectHappierUiEnvironment } = await import('@happier-dev/plugin-ui/environment');
    const authored = definePlugin({
      id: 'acme.status', version: '1.0.0',
      composer: { regions: { checks: {
        placement: 'statusStrip', emphasis: 'prominent', renderer: { renderer: 'checks-view' },
      } } },
      ui: { renderers: [{ id: 'checks-view', kind: 'reactNative', artifact: 'checks-view' }] },
    });
    const parsed = parsePluginManifest(authored.manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const definition = parsed.manifest.contributes!.composerRegions![0]!;
    const emphasis = definition.emphasis;
    if (emphasis !== 'prominent') throw new Error('The admitted region must retain its prominent emphasis');
    const layout = await measureStrip(388,
      { label: 'brand-voice turned off · applied now to this Session', emphasis: 'quiet', testID: 'note' },
      false, [], [{ emphasis, node: (
        <HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContextFixture())}>
          <ComposerStatusBadge testID="plugin-checks" label="PR checks running" emphasis={emphasis} />
        </HappierUiEnvironmentProvider>
      ) }],
    );
    expect(layout.rect('plugin-checks:label').text).toBe('PR checks running');
    expect(layout.rect('plugin-checks:label').clipped).not.toBe(true);
    expect(layout.rect('note:label').clipped).toBe(true);
    expect(layout.rect('plugin-checks').right).toBeLessThanOrEqual(layout.rect('frame').right + 0.5);
  });
});
