import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { FloatingFrame, type FrameRect } from '@happier-dev/plugin-ui/presentation';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RetainedPresentationSlotsProvider } from '@/components/ui/presentation/retainedPresentationSlots';

import { useOptionalSessionViewerController, type SessionViewerController } from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import { SessionViewerBody, SessionViewerHost } from './SessionViewerHost';
import { SESSION_VIEWER_EDGE } from './sessionViewerGeometry';

// The platform is the boundary: a native tablet, whose root has no DOM portal.
const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() { return platform.os; },
      select: (spec: Record<string, unknown>) => spec[platform.os] ?? spec.native ?? spec.default,
    },
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A 1440 x 900 tablet window; the Session column is 700 wide at x 300, between the sidebar and Details.
const WINDOW = { x: 0, y: 0, width: 1440, height: 900 };
const COLUMN = { x: 300, y: 40, width: 700, height: 860 };

type Harness = { controller: SessionViewerController | null };

function Probe(props: Readonly<{ harness: Harness }>) {
  props.harness.controller = useOptionalSessionViewerController();
  return null;
}

function Tree(props: Readonly<{ harness: Harness; phone?: boolean; presented?: boolean }>) {
  return (
    <RetainedPresentationSlotsProvider>
      <PluginSurfaceFocusEligibilityProvider active presentationActive={props.presented ?? true}>
        <SessionViewerControllerProvider
          sessionId="session-a"
          serverId="home-a"
          phone={props.phone ?? false}
          canPresentSource={() => true}
          openDocked={() => {}}
        >
          <Probe harness={props.harness} />
          <SessionViewerHost sessionId="session-a" serverId="home-a" />
        </SessionViewerControllerProvider>
      </PluginSurfaceFocusEligibilityProvider>
    </RetainedPresentationSlotsProvider>
  );
}

type MeasureInWindow = (callback: (x: number, y: number, width: number, height: number) => void) => void;
const measured = (rect: typeof WINDOW): { measureInWindow: MeasureInWindow } => ({
  measureInWindow: (callback) => callback(rect.x, rect.y, rect.width, rect.height),
});

async function mount(options: Readonly<{ phone?: boolean; presented?: boolean }> = {}) {
  const harness: Harness = { controller: null };
  const result = await renderWithAppProviders(<Tree harness={harness} {...options} />, {
    createNodeMock: (element) => element.props.testID === 'retained-presentation-floating-layer' ? measured(WINDOW)
      : element.props.testID === 'session-viewer-host' ? measured(COLUMN) : null,
  });
  const layer = () => result.tree.root.find((node) => node.props.testID === 'retained-presentation-floating-layer' && typeof node.props.onLayout === 'function');
  const host = () => result.tree.root.findAll((node) => node.props.testID === 'session-viewer-host' && typeof node.props.onLayout === 'function')[0];
  // The root layer measures itself where the window lays it out.
  await act(async () => { invokeTestInstanceHandler(layer(), 'onLayout', { nativeEvent: { layout: WINDOW } }); });
  await act(async () => { harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' }); });
  const hostNode = host();
  if (hostNode) {
    await act(async () => {
      invokeTestInstanceHandler(hostNode, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: COLUMN.width, height: COLUMN.height } } });
    });
  }
  return { result, harness, layer, host };
}

const within = (root: ReactTestInstance | undefined, type: React.ElementType) => root ? root.findAllByType(type) : [];

describe('SessionViewerHost on a native tablet (plan 63 A1)', () => {
  it('floats over the whole window from the root layer while its retained body stays under the Session\'s providers', async () => {
    const { result, harness, layer, host } = await mount();
    try {
      // The frame is drawn in the app's root floating layer, not inside the Session column.
      expect(within(layer(), FloatingFrame)).toHaveLength(1);
      expect(within(host(), FloatingFrame)).toHaveLength(0);
      const frame = () => layer().findByType(FloatingFrame);
      expect(frame().props.availableRect).toEqual({
        x: SESSION_VIEWER_EDGE, y: SESSION_VIEWER_EDGE,
        width: WINDOW.width - SESSION_VIEWER_EDGE * 2, height: WINDOW.height - SESSION_VIEWER_EDGE * 2,
      });
      // The chrome still reads the Session's viewer owner there: its source switch is drawn.
      expect(layer().findAll((node) => node.props.testID === 'session-viewer-source:computer').length).toBeGreaterThan(0);
      // It opens in the Session's reading corner, in window space.
      const opened = frame().props.rect as FrameRect;
      expect(opened.x).toBeGreaterThanOrEqual(COLUMN.x + SESSION_VIEWER_EDGE);
      expect(opened.x + opened.width).toBeLessThanOrEqual(COLUMN.x + COLUMN.width - SESSION_VIEWER_EDGE);
      // The person drags it over Details on the right and over the sidebar on the left; nothing clamps it to the column.
      const overDetails = { ...opened, x: WINDOW.width - SESSION_VIEWER_EDGE - opened.width };
      await act(async () => { frame().props.onRectChange(overDetails, { kind: 'settle' }); });
      expect(harness.controller!.state.rect).toEqual(overDetails);
      const overSidebar = { ...opened, x: SESSION_VIEWER_EDGE, y: SESSION_VIEWER_EDGE };
      await act(async () => { frame().props.onRectChange(overSidebar, { kind: 'settle' }); });
      expect(harness.controller!.state.rect).toEqual(overSidebar);

      // The retained body never moves into the layer: it stays in the Session's tree, where its
      // Session and Account providers reach it, and keeps its instance across expand and restore.
      expect(within(layer(), SessionViewerBody)).toHaveLength(0);
      const body = host().findByType(SessionViewerBody);
      await act(async () => { harness.controller!.port.apply({ kind: 'viewer.expand' }); });
      expect(layer().findByType(FloatingFrame).props.mode).toBe('expanded');
      await act(async () => { harness.controller!.port.apply({ kind: 'viewer.restore' }); });
      expect(host().findByType(SessionViewerBody)).toBe(body);
    } finally { await result.unmount(); }
  });

  it('presents nothing from a Session that is not on screen', async () => {
    const { result, layer } = await mount({ presented: false });
    try {
      expect(within(layer(), FloatingFrame)).toHaveLength(0);
    } finally { await result.unmount(); }
  });

  it('keeps the phone viewer in its docked reading flow', async () => {
    const { result, harness, layer } = await mount({ phone: true });
    try {
      expect(harness.controller!.state.mode).toBe('docked');
      expect(within(layer(), FloatingFrame)).toHaveLength(0);
      expect(result.tree.root.findAllByType(FloatingFrame)).toHaveLength(0);
    } finally { await result.unmount(); }
  });
});
