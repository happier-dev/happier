// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

import { MultiPaneHost } from './MultiPaneHost';
import { MultiPaneHostWithBottom } from './MultiPaneHostWithBottom';
import type { ResolvedPaneLayout } from './paneBreakpoints';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const OVERLAY: ResolvedPaneLayout = { main: 'docked', kind: 'overlayStack', right: 'overlay', details: 'hidden' };
const DOCKED: ResolvedPaneLayout = { main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' };

async function measure(element: React.ReactElement, edgeProbeTestIds: readonly string[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <View testID="host" style={{ width: 1200, height: 600, flexDirection: 'row' }}>
        {element}
      </View>,
    );
  });
  // Let the presence motion settle on its open frame.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  return measureWebLayout(host, { viewport: { width: 1200, height: 700 }, edgeProbeTestIds });
}

function Host(props: Readonly<{ layout: ResolvedPaneLayout; inMain?: boolean }>) {
  return (
    <MultiPaneHost
      main={<View testID="session-content" style={{ flex: 1 }} />}
      rightPane={props.inMain ? null : <View style={{ flex: 1 }} />}
      rightSurfaces={props.inMain ? [{ id: 'info', placement: 'main', content: <View style={{ flex: 1 }} /> }] : undefined}
      mirrored={props.inMain === true}
      detailsPane={null}
      layout={props.layout}
      mainDockWidthPx={640}
      rightDockWidthPx={360}
      detailsDockWidthPx={520}
      onCloseRight={() => {}}
      onCloseDetails={() => {}}
      onCommitRightDockWidthPx={() => {}}
      onCommitDetailsDockWidthPx={() => {}}
      onCommitMainDockWidthPx={() => {}}
    />
  );
}

/**
 * The resize handle's web target is centred on the edge it resizes, so half of it lies outside the pane.
 * A clipping ancestor would cut that half off and leave only the drawn edge grabbable; a pointer just
 * past the edge must still reach the handle.
 */
describe('a pane resize edge, as a browser hit-tests it', () => {
  it.each([
    ['overlay', OVERLAY, false, 'multi-pane-right-overlay', 'left'],
    ['mirrored in-main', DOCKED, true, 'multi-pane-right-main', 'left'],
  ] as const)('the %s pane takes a pointer just outside its edge', async (_name, layout, inMain, paneId, edge) => {
    const result = await measure(<Host layout={layout} inMain={inMain} />, [`${paneId}-resize-${edge}`]);
    const pane = result.rect(paneId);
    const handle = result.rect(`${paneId}-resize-${edge}`);
    // The target straddles the edge: its centre sits outside the pane.
    expect(handle.left).toBeLessThan(pane.left - 6);
    expect(handle.left + handle.width / 2).toBeLessThan(pane.left);
    expect(handle.receivesPointerAtEdges?.left).toBe(true);
  });

  it('the bottom overlay pane takes a pointer just above its top edge', async () => {
    const result = await measure(
      <MultiPaneHostWithBottom
        main={<View style={{ flex: 1 }} />}
        rightPane={null}
        detailsPane={null}
        layout={{ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' }}
        rightDockWidthPx={360}
        detailsDockWidthPx={520}
        onCloseRight={() => {}}
        onCloseDetails={() => {}}
        onCommitRightDockWidthPx={() => {}}
        onCommitDetailsDockWidthPx={() => {}}
        bottomPane={<View style={{ flex: 1 }} />}
        bottomPresentation="overlay"
        bottomDockHeightPx={320}
        bottomDockMinHeightPx={200}
        bottomDockMaxHeightPx={600}
        onCloseBottom={() => {}}
        onCommitBottomDockHeightPx={() => {}}
      />,
      ['multi-pane-bottom-overlay-resize-handle'],
    );
    const pane = result.rect('multi-pane-bottom-overlay-pane');
    const handle = result.rect('multi-pane-bottom-overlay-resize-handle');
    expect(handle.top).toBeLessThan(pane.top - 3);
    // The target's outermost row, above the pane's top edge.
    expect(handle.receivesPointerAtEdges?.top).toBe(true);
  });
});
