import * as React from 'react';
import { Platform, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';

import {
  RetainedPresentationFloatingLayerContext,
  RetainedPresentationSlotsProvider,
  useRetainedPresentationFloatingBody,
  useRetainedPresentationSlot,
} from './retainedPresentationSlots';

// react-dom is the web platform boundary: its portal mounts the floating chrome into the layer's DOM
// node. The test renderer has no DOM, so the portal renders in place and records its target.
const portalTargets = vi.hoisted(() => [] as unknown[]);
vi.mock('@/utils/web/reactDomCjs', () => ({
  requireReactDOM: () => ({
    createPortal: (node: React.ReactNode, target: unknown) => {
      portalTargets.push(target);
      return node;
    },
  }),
}));

const WINDOW = { x: 0, y: 0, width: 1440, height: 900 };

function Body(
  props: Readonly<{ slotId: string; x: number }>,
): React.ReactElement {
  useRetainedPresentationSlot({
    slotId: props.slotId,
    node: <Text>{props.slotId}</Text>,
    geometry: { x: props.x, y: 100, width: 300, height: 200 },
    visible: true,
  });
  return <></>;
}

// The production composition (SessionViewerHost): the frame's chrome is presented in the layer, while the
// retained body stays in its owner's tree under the body scope, which is what binds it above the chrome.
function FloatingChrome(): React.ReactElement | null {
  const layer = React.useContext(RetainedPresentationFloatingLayerContext);
  const floating = useRetainedPresentationFloatingBody();
  if (!layer) return null;
  return <>
    {layer.present(floating.frame(<Text>viewer frame</Text>))}
    {floating.body(<Body slotId="viewer" x={500} />)}
  </>;
}

function zIndexOf(node: { props: { style?: unknown } } | undefined): number {
  return Number(StyleSheet.flatten(node?.props.style as StyleProp<ViewStyle>)?.zIndex ?? 0);
}

describe('retained presentation floating layer (plan 63 A1)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS');
  beforeEach(() => {
    portalTargets.length = 0;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  });
  afterEach(() => {
    if (originalPlatform)
      Object.defineProperty(Platform, 'OS', originalPlatform);
  });

  it('presents floating chrome over every page and its in-flow bodies, beneath the bodies it presents, measured in window space', async () => {
    const layerNode = {
      getBoundingClientRect: () => ({
        ...WINDOW,
        left: WINDOW.x,
        top: WINDOW.y,
      }),
    };
    let measured: unknown = null;
    function Measure() {
      const layer = React.useContext(RetainedPresentationFloatingLayerContext);
      measured = layer?.measure() ?? null;
      return null;
    }
    const screen = await renderWithAppProviders(
      <RetainedPresentationSlotsProvider>
        <Body slotId="details" x={1000} />
        <FloatingChrome />
        <Measure />
      </RetainedPresentationSlotsProvider>,
      {
        createNodeMock: (element) =>
          element.props.testID === 'retained-presentation-floating-layer'
            ? layerNode
            : null,
      },
    );
    try {
      // The layer exists once the host has mounted; the chrome then portals into it.
      await screen.update(
        <RetainedPresentationSlotsProvider>
          <Body slotId="details" x={1000} />
          <FloatingChrome />
          <Measure />
        </RetainedPresentationSlotsProvider>,
      );
      expect(portalTargets).toContain(layerNode);
      expect(measured).toEqual(WINDOW);
      const find = (testID: string) =>
        screen.tree.root.findAll(
          (node) =>
            node.props?.testID === testID && node.props.style !== undefined,
        )[0];
      const layer = zIndexOf(find('retained-presentation-floating-layer'));
      const page = zIndexOf(find('browser-presentation-portal-slot-details'));
      const presented = zIndexOf(
        find('browser-presentation-portal-slot-viewer'),
      );
      expect(layer).toBeGreaterThan(page);
      expect(presented).toBeGreaterThan(layer);
    } finally {
      await screen.unmount();
    }
  });
});
