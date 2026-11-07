import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  FloatingFrame,
  resolveFloatingFrameBodyRect,
  type FrameRect,
} from '@happier-dev/plugin-ui/presentation';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { t } from '@/text';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import type { BrowserCopresence } from '@/sync/domains/browser/automation/copresence';

import {
  useOptionalSessionViewerController,
  usePublishSessionViewerPresence,
  usePublishSessionViewerSourceFacts,
  type SessionViewerController,
  type SessionViewerPresence,
} from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import { SessionViewerHost } from './SessionViewerHost';
import { SESSION_VIEWER_EDGE } from './sessionViewerGeometry';
import { RetainedPresentationFloatingLayerContext } from '@/components/ui/presentation/retainedPresentationSlots';
import {
  SessionCockpitBottomChromeHeightContext,
  SessionCockpitChromeRegistryProvider,
  useReportSessionCockpitComposerChromeHeight,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

/**
 * Plan 63s2 / R1-U1–U4: the mounted viewer composition. The source's presence owner and facts are
 * published through the viewer's public hooks (as the Computer and Browser bodies do); controller,
 * host, frame, controls and the presence capsule are the real owners.
 */
type Harness = {
  controller: SessionViewerController | null;
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
  props: Readonly<{ presence: BrowserCopresence; machineName?: string | null; targetTitle?: string | null; aspectRatio?: number; agentTitle?: string }>,
) {
  const watching = props.presence.kind === 'agent';
  usePublishSessionViewerSourceFacts('computer', {
    targetTitle: props.targetTitle ?? null,
    machineName: props.machineName === undefined ? 'fly-bot-1' : props.machineName,
    personInControl: props.presence.kind === 'human',
    watching,
    aspectRatio: props.aspectRatio ?? 2,
  });
  const presence = React.useMemo<SessionViewerPresence>(
    () => ({
      presence: props.presence,
      agent: { name: 'Claude' },
      ...(props.agentTitle ? { agentTitle: props.agentTitle } : {}),
      onTakeControl: () => {},
      onHandBack: () => {},
    }),
    [props.agentTitle, props.presence],
  );
  usePublishSessionViewerPresence('computer', presence);
  return null;
}

function Probe(props: Readonly<{ harness: Harness }>) {
  props.harness.controller = useOptionalSessionViewerController();
  return null;
}

function Tree(
  props: Readonly<{
    harness: Harness;
    presence: BrowserCopresence;
    machineName?: string | null;
    targetTitle?: string | null;
    aspectRatio?: number;
    agentTitle?: string;
    phone?: boolean;
  }>,
) {
  return (
    <SessionViewerControllerProvider
      sessionId="session-a"
      serverId="home-a"
      phone={props.phone === true}
      canPresentSource={() => true}
      openDocked={() => {}}
    >
      <Source presence={props.presence} machineName={props.machineName} targetTitle={props.targetTitle} aspectRatio={props.aspectRatio} agentTitle={props.agentTitle} />
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
  const harness: Harness = { controller: null };
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
  it('names the selected display in the frame while the source switch keeps its short kind label, independently of picture or recovery state', async () => {
    const { result, harness, frame } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    try {
      await result.update(<Tree harness={harness} presence={{ kind: 'unconfirmed', controlEpoch: 2 }} targetTitle="primary" />);
      expect(frame().props.accessibilityLabel).toContain('primary');
      const source = () => result.tree.root.findAll(node => node.props.testID === 'session-viewer-source:computer'
        && typeof node.props.accessibilityLabel === 'string')[0];
      expect(source()?.props.accessibilityLabel).toBe(t('computerUse.presentation.sourceComputer'));
      await result.update(<Tree harness={harness} presence={HUMAN_PRESENCE} targetTitle="secondary" />);
      expect(frame().props.accessibilityLabel).toContain('secondary');
      expect(source()?.props.accessibilityLabel).toBe(t('computerUse.presentation.sourceComputer'));
      await result.update(<Tree harness={harness} presence={AGENT_PRESENCE} />);
      expect(frame().props.accessibilityLabel).not.toContain('secondary');
    } finally { await result.unmount(); }
  });
  it('keeps the transcript from showing behind an expanded viewer\'s controls, and leaves a floating viewer see-through', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, { width: 390, height: 520 });
    const backing = () => result.tree.root.findAll((node) => node.props?.testID === 'session-viewer-expanded-backing');
    try {
      expect(backing()).toHaveLength(0);
      await act(async () => { harness.controller!.port.apply({ kind: 'viewer.expand' }); });
      expect(harness.controller!.state.mode).toBe('expanded');
      expect(backing().length).toBeGreaterThan(0);
      await act(async () => { harness.controller!.port.apply({ kind: 'viewer.restore' }); });
      expect(backing()).toHaveLength(0);
    } finally { await result.unmount(); }
  });

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

  it('says the agent is working on the machine only while it acts; otherwise the source’s own line stands', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    const capsuleTitle = () => result.tree.root.findAll(
      (node) => node.props?.testID === 'session-viewer-presence' && typeof node.props.agentTitle === 'string',
    )[0]?.props.agentTitle as string | undefined;
    try {
      // Shared and allowed, but no action in flight (no turn running): no claim of work.
      await result.update(<Tree harness={harness} presence={AGENT_PRESENCE} agentTitle="Claude can see Safari" />);
      expect(capsuleTitle()).toBe('Claude can see Safari');
      await result.update(<Tree harness={harness} presence={{ ...AGENT_PRESENCE, activity: 'click' }} agentTitle="Claude is using Safari" />);
      expect(capsuleTitle()).toContain('fly-bot-1');
    } finally { await result.unmount(); }
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

  it('sizes the frame to hold the switch, the Machine chip and the buttons side by side', async () => {
    const { result, frame } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    const layOut = async (testID: string, width: number) => {
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.find(
            (node) => node.props?.testID === testID && typeof node.props.onLayout === 'function',
          ),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } },
        );
      });
    };
    await layOut('session-viewer-source-capsule', 150);
    await layOut('session-viewer-buttons-capsule', 90);
    const withoutChip = frame().props.minWidth as number;
    await layOut('session-viewer-machine', 100);
    // The chip's own width and the gap that separates it join the row.
    expect((frame().props.minWidth as number) - withoutChip).toBe(100 + 6);
    await result.unmount();
  });

  it('ends a phone\'s expanded viewer above the floating tab bar, so who acts and Hand back stay reachable', async () => {
    const tabBar = 84;
    const harness: Harness = { controller: null };
    const result = await renderWithAppProviders(
      <SessionCockpitBottomChromeHeightContext.Provider value={tabBar}>
        <Tree harness={harness} presence={HUMAN_PRESENCE} phone />
      </SessionCockpitBottomChromeHeightContext.Provider>,
    );
    try {
      await act(async () => { harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' }); });
      await act(async () => { harness.controller!.port.apply({ kind: 'viewer.expand' }); });
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-host' }),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 760 } } },
        );
      });
      const rect = result.tree.root.findByType(FloatingFrame).props.rect as FrameRect;
      expect(rect.y + rect.height).toBeLessThanOrEqual(760 - tabBar - SESSION_VIEWER_EDGE);
    } finally { await result.unmount(); }
  });

  it('opens in the corner above the composer band, and lets the person settle it over the composer', async () => {
    // Desktop: the workspace frame lifts the composer band off the window edge, so the band's
    // height alone would put a first placement over the composer's status line; the band publishes its top.
    const { Dimensions } = await import('react-native');
    const windowHeight = Dimensions.get('window').height;
    const bandTopFromBottom = 200;
    function Composer() {
      const report = useReportSessionCockpitComposerChromeHeight(true);
      React.useEffect(() => { report(120, bandTopFromBottom); }, [report]);
      return null;
    }
    const harness: Harness = { controller: null };
    const result = await renderWithAppProviders(
      <SessionCockpitChromeRegistryProvider>
        <Composer />
        <Tree harness={harness} presence={AGENT_PRESENCE} />
      </SessionCockpitChromeRegistryProvider>,
    );
    try {
      await act(async () => {
        harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' });
      });
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-host' }),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width: 1400, height: windowHeight } } },
        );
      });
      const frame = () => result.tree.root.findByType(FloatingFrame);
      const rect = frame().props.rect as FrameRect;
      expect(rect.y + rect.height).toBeLessThanOrEqual(windowHeight - bandTopFromBottom - SESSION_VIEWER_EDGE);
      // The only bound of a floating frame is the area: the composer region is inside it.
      const available = frame().props.availableRect as FrameRect;
      expect(available.y + available.height).toBe(windowHeight - SESSION_VIEWER_EDGE);
      const overComposer = { ...rect, y: windowHeight - SESSION_VIEWER_EDGE - rect.height };
      await act(async () => { frame().props.onRectChange(overComposer, { kind: 'settle' }); });
      expect(harness.controller!.state.rect).toEqual(overComposer);
      expect(overComposer.y + overComposer.height).toBeGreaterThan(windowHeight - bandTopFromBottom);
    } finally { await result.unmount(); }
  });

  it('shrinks to a viewport smaller than the frame and stays floating', async () => {
    const { result, harness, frame } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 200 });
    try {
      expect(harness.controller!.state.mode).toBe('floating');
      const rect = frame().props.rect as FrameRect;
      const available = frame().props.availableRect as FrameRect;
      expect(rect.x).toBeGreaterThanOrEqual(available.x);
      expect(rect.y).toBeGreaterThanOrEqual(available.y);
      expect(rect.y + rect.height).toBeLessThanOrEqual(available.y + available.height);
      // The picture keeps its shape while the frame shrinks around it.
      const body = resolveFloatingFrameBodyRect(rect, { footer: true });
      expect(body.width / body.height).toBeCloseTo(2);
      // Growing the viewport back restores the default size; nothing docks.
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-host' }),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } },
        );
      });
      expect(harness.controller!.state.mode).toBe('floating');
      expect((frame().props.rect as FrameRect).width).toBeGreaterThan(rect.width);
    } finally { await result.unmount(); }
  });

  it('settles a frame whose picture shape is not yet reported in an area too small for its state card, without update loops', async () => {
    // No reported shape: the body is a stand-in that is as tall as a state card needs, so shrinking the
    // frame to a small area changes the shape asked for. The settle must still converge.
    const { result, harness, frame } = await mountOpen(AGENT_PRESENCE, { width: 560, height: 200 });
    try {
      await result.update(<Tree harness={harness} presence={AGENT_PRESENCE} aspectRatio={0} />);
      const available = frame().props.availableRect as FrameRect;
      const rect = frame().props.rect as FrameRect;
      expect(harness.controller!.state.mode).toBe('floating');
      expect(rect.y + rect.height).toBeLessThanOrEqual(available.y + available.height);
      expect(rect.x + rect.width).toBeLessThanOrEqual(available.x + available.width);
    } finally { await result.unmount(); }
  });

  it('keeps a frame the person placed where it is when the area grows', async () => {
    const { result, harness, frame } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    try {
      const start = frame().props.rect as FrameRect;
      const placed = { ...start, x: 16, y: 16 };
      await act(async () => { frame().props.onRectChange(placed, { kind: 'settle' }); });
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-host' }),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width: 1600, height: 1000 } } },
        );
      });
      expect(harness.controller!.state.rect).toMatchObject({ x: 16, y: 16 });
    } finally { await result.unmount(); }
  });

  it('docks only on the explicit Dock, which unmounts the frame, and Float brings it back', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    try {
      await act(async () => { harness.controller!.apply({ kind: 'viewer.dock' }); });
      expect(harness.controller!.state.mode).toBe('docked');
      expect(result.tree.root.findAllByType(FloatingFrame)).toHaveLength(0);
      await act(async () => { expect(harness.controller!.apply({ kind: 'viewer.float' }).status).toBe('applied'); });
      expect(harness.controller!.state.mode).toBe('floating');
      // The host mounts again and measures its area like any open.
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-host' }),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } },
        );
      });
      expect(result.tree.root.findAllByType(FloatingFrame)).toHaveLength(1);
    } finally { await result.unmount(); }
  });

  it('fits an unavailable picture using the controls minimum instead of stretching a narrow retained placeholder aspect', async () => {
    const { result, harness } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 450 });
    try {
      await result.update(<Tree harness={harness} presence={AGENT_PRESENCE} aspectRatio={0} />);
      await act(async () => { harness.controller!.setRect({ x: 980, y: 30, width: 200, height: 312 }); });
      const layOut = async (testID: string, width: number) => {
        await act(async () => {
          invokeTestInstanceHandler(
            result.tree.root.find(node => node.props.testID === testID && typeof node.props.onLayout === 'function'),
            'onLayout',
            { nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } },
          );
        });
      };
      await layOut('session-viewer-source-capsule', 300);
      await layOut('session-viewer-machine', 51);
      await layOut('session-viewer-buttons-capsule', 90);
      expect(harness.controller!.state.mode).toBe('floating');
      const frame = result.tree.root.findByType(FloatingFrame);
      // Switch, chip and buttons with the row's gap on each side of the spacer between them.
      expect(frame.props.minWidth).toBe(300 + 51 + 90 + 6 * 3);
      expect(frame.props.rect.width).toBeGreaterThanOrEqual(300 + 51 + 90 + 6 * 3);
      expect(frame.props.rect.height).toBeLessThanOrEqual(frame.props.availableRect.height);
    } finally { await result.unmount(); }
  });

  it('floats over the whole window when the app offers its floating layer: placed outside the Session column, never clamped to it', async () => {
    // Plan 63 A1: the person may put the viewer anywhere in the viewport (over the sidebar or the
    // right pane); only the window's edges and safe areas bound it. The Session column sits at
    // x 300 in a 1440 x 900 window.
    const layer = { present: (node: React.ReactNode) => node, measure: () => ({ x: 0, y: 0, width: 1440, height: 900 }) };
    const harness: Harness = { controller: null };
    const result = await renderWithAppProviders(
      <RetainedPresentationFloatingLayerContext.Provider value={layer}>
        <Tree harness={harness} presence={AGENT_PRESENCE} />
      </RetainedPresentationFloatingLayerContext.Provider>,
      {
        createNodeMock: (element) => element.props.testID === 'session-viewer-host'
          ? { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(300, 40, 700, 860) }
          : null,
      },
    );
    try {
      await act(async () => { harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' }); });
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-host' }),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width: 700, height: 860 } } },
        );
      });
      const frame = () => result.tree.root.findByType(FloatingFrame);
      expect(frame().props.availableRect).toEqual({
        x: SESSION_VIEWER_EDGE, y: SESSION_VIEWER_EDGE, width: 1440 - SESSION_VIEWER_EDGE * 2, height: 900 - SESSION_VIEWER_EDGE * 2,
      });
      // It first opens in the Session's reading corner, in window space.
      const opened = frame().props.rect as FrameRect;
      expect(opened.x).toBeGreaterThanOrEqual(300 + SESSION_VIEWER_EDGE);
      expect(opened.x + opened.width).toBeLessThanOrEqual(300 + 700 - SESSION_VIEWER_EDGE);
      // Over the sidebar on the left and over the right pane: the placement stays the person's.
      const overSidebar = { ...opened, x: SESSION_VIEWER_EDGE, y: SESSION_VIEWER_EDGE };
      await act(async () => { frame().props.onRectChange(overSidebar, { kind: 'settle' }); });
      expect(harness.controller!.state.rect).toEqual(overSidebar);
      const overRightPane = { ...opened, x: 1440 - SESSION_VIEWER_EDGE - opened.width };
      await act(async () => { frame().props.onRectChange(overRightPane, { kind: 'settle' }); });
      expect(harness.controller!.state.rect).toEqual(overRightPane);
    } finally { await result.unmount(); }
  });

  it('gives the controls the glyph-only switch while the frame is narrower than their labelled row, and the labels back when it is wide again', async () => {
    const { result, frame } = await mountOpen(AGENT_PRESENCE, { width: 1200, height: 800 });
    const switchLabels = () => result.tree.root.findAll(
      (node) => node.props?.testIDPrefix === 'session-viewer-source' && 'labels' in node.props,
    )[0]?.props.labels;
    const layOut = async (testID: string, width: number) => {
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.find((node) => node.props?.testID === testID && typeof node.props.onLayout === 'function'),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } },
        );
      });
    };
    const area = async (width: number, height: number) => {
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-host' }),
          'onLayout',
          { nativeEvent: { layout: { x: 0, y: 0, width, height } } },
        );
      });
    };
    try {
      await layOut('session-viewer-source-capsule', 220);
      await layOut('session-viewer-machine', 100);
      await layOut('session-viewer-buttons-capsule', 90);
      expect(switchLabels()).toBeUndefined();
      // A short window: the picture's shape narrows the frame below the labelled row.
      await area(1200, 200);
      expect((frame().props.rect as FrameRect).width).toBeLessThan(frame().props.minWidth as number);
      expect(switchLabels()).toBe('none');
      // Its glyph-only measurement does not become the frame's minimum (no measure-own-output loop).
      await layOut('session-viewer-source-capsule', 80);
      expect(frame().props.minWidth).toBe(220 + 100 + 90 + 6 * 3);
      await area(1200, 800);
      expect(switchLabels()).toBeUndefined();
    } finally { await result.unmount(); }
  });

});
