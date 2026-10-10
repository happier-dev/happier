import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  FloatingFrame,
  resolveFloatingFrameBodyRect,
  type FrameRect,
} from '@happier-dev/plugin-ui/presentation';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import type { BrowserCopresence } from '@/sync/domains/browser/automation/copresence';

import {
  useOptionalSessionViewerController,
  usePublishSessionViewerPresence,
  usePublishSessionViewerSourceFacts,
  useSessionViewerReadingInset,
  type SessionViewerController,
  type SessionViewerPresence,
} from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import { SessionViewerHost } from './SessionViewerHost';

/**
 * Plan 63s2 / R1-U1–U4: the mounted viewer composition. The source's presence owner and facts are
 * published through the viewer's public hooks (as the Computer and Browser bodies do); controller,
 * host, frame, controls and the presence capsule are the real owners.
 */
type Harness = {
  controller: SessionViewerController | null;
  inset: Readonly<{ left: number; right: number }>;
};

const AGENT_PRESENCE: BrowserCopresence = {
  kind: 'agent',
  activity: null,
  target: null,
  controlEpoch: 1,
};
const HUMAN_PRESENCE: BrowserCopresence = {
  kind: 'human',
  controlEpoch: 2,
  interruptedCompletion: null,
};

function Source(
  props: Readonly<{ presence: BrowserCopresence; machineName?: string | null }>,
) {
  const watching = props.presence.kind === 'agent';
  usePublishSessionViewerSourceFacts('computer', {
    machineName: props.machineName === undefined ? 'fly-bot-1' : props.machineName,
    personInControl: props.presence.kind === 'human',
    watching,
    aspectRatio: 2,
  });
  const presence = React.useMemo<SessionViewerPresence>(
    () => ({
      presence: props.presence,
      agent: { name: 'Claude' },
      onTakeControl: () => {},
      onHandBack: () => {},
    }),
    [props.presence],
  );
  usePublishSessionViewerPresence('computer', presence);
  return null;
}

function Probe(props: Readonly<{ harness: Harness }>) {
  props.harness.controller = useOptionalSessionViewerController();
  props.harness.inset = useSessionViewerReadingInset();
  return null;
}

function Tree(
  props: Readonly<{
    harness: Harness;
    presence: BrowserCopresence;
    machineName?: string | null;
  }>,
) {
  return (
    <SessionViewerControllerProvider
      sessionId="session-a"
      serverId="home-a"
      phone={false}
      canPresentSource={() => true}
      openDocked={() => {}}
    >
      <Source presence={props.presence} machineName={props.machineName} />
      <Probe harness={props.harness} />
      <SessionViewerHost sessionId="session-a" serverId="home-a" />
    </SessionViewerControllerProvider>
  );
}

async function mountOpen(
  presence: BrowserCopresence,
  size: Readonly<{ width: number; height: number }>,
  machineName?: string | null,
) {
  const harness: Harness = { controller: null, inset: { left: 0, right: 0 } };
  const result = await renderWithAppProviders(
    <Tree harness={harness} presence={presence} machineName={machineName} />,
  );
  await act(async () => {
    harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' });
  });
  await act(async () => {
    invokeTestInstanceHandler(
      result.tree.root.findByProps({ testID: 'session-viewer-host' }),
      'onLayout',
      { nativeEvent: { layout: { x: 0, y: 0, ...size } } },
    );
  });
  const frame = () => result.tree.root.findByType(FloatingFrame);
  return { result, harness, frame };
}

describe('SessionViewerHost', () => {
  it('moves by the watched picture, keeps the source’s shape and draws who acts below the picture', async () => {
    const { result, frame } = await mountOpen(AGENT_PRESENCE, {
      width: 1200,
      height: 800,
    });
    expect(frame().props.moveInput).toBe('surface');
    const rect = frame().props.rect as FrameRect;
    const body = resolveFloatingFrameBodyRect(rect, { footer: true });
    expect(body.width / body.height).toBeCloseTo(2);
    // The presence capsule stands in the frame's footer, not on the picture.
    const footer = frame().props.footer as React.ReactElement;
    expect(footer).toBeTruthy();
    expect(
      result.tree.root.findAll(
        (node) => node.props?.testID === 'session-viewer-presence',
      ).length,
    ).toBeGreaterThan(0);
    await result.unmount();
  });

  it('names what is watched and where, and never ends on a dangling "on" when its source states no machine', async () => {
    const named = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    expect(named.frame().props.accessibilityLabel).toContain('fly-bot-1');
    await named.result.unmount();

    const unnamed = await mountOpen(
      AGENT_PRESENCE,
      { width: 1200, height: 800 },
      null,
    );
    const label = String(unnamed.frame().props.accessibilityLabel);
    expect(label.length).toBeGreaterThan(0);
    expect(label).toBe(label.trim());
    expect(label).not.toMatch(/\s(on|sur|en|auf)$/);
    await unnamed.result.unmount();
  });

  it('leaves a driven picture its own input and keeps its controls shown', async () => {
    const { result, frame } = await mountOpen(HUMAN_PRESENCE, {
      width: 1200,
      height: 800,
    });
    expect(frame().props.moveInput).toBe('chrome');
    expect(frame().props.controlsAlwaysVisible).toBe(true);
    await result.unmount();
  });

  it('does not reflow the reading column while the frame is dragged; it yields where the frame settles', async () => {
    const { result, harness, frame } = await mountOpen(AGENT_PRESENCE, {
      width: 1400,
      height: 900,
    });
    const settled = harness.inset;
    const start = frame().props.rect as FrameRect;
    await act(async () => {
      frame().props.onRectChange({ ...start, x: 40, y: 40 }, { kind: 'move' });
    });
    expect(harness.inset).toEqual(settled);
    await act(async () => {
      frame().props.onRectChange(
        { ...start, x: 16, y: 16 },
        { kind: 'settle' },
      );
    });
    expect(harness.controller!.state.rect).toMatchObject({ x: 16, y: 16 });
    await result.unmount();
  });

  it('docks when the area cannot hold a usable frame beside the composer', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, {
      width: 1200,
      height: 70,
    });
    expect(harness.controller!.state.mode).toBe('docked');
    await result.unmount();
  });
});
