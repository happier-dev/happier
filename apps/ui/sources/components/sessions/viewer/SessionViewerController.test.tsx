import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import {
  isSessionViewerPresenting,
  SessionViewerControllerProvider,
  useOptionalSessionViewerController,
  useSessionViewerReadingInset,
} from './SessionViewerController';
import {
  resolveSessionViewerReadingInset,
  SESSION_VIEWER_EDGE,
} from './sessionViewerGeometry';

function mountController(
  input: Readonly<{ phone: boolean; computer?: boolean }>,
) {
  const openDocked = vi.fn();
  const canPresentSource = (source: 'computer' | 'browser') =>
    source === 'browser' || input.computer !== false;
  function Wrapper(props: React.PropsWithChildren) {
    return (
      <SessionViewerControllerProvider
        serverId="home-a"
        phone={input.phone}
        canPresentSource={canPresentSource}
        openDocked={openDocked}
      >
        {props.children}
      </SessionViewerControllerProvider>
    );
  }
  return {
    openDocked,
    render: () =>
      renderHook(
        () => ({
          controller: useOptionalSessionViewerController()!,
          inset: useSessionViewerReadingInset(),
        }),
        { wrapper: Wrapper },
      ),
  };
}

describe('SessionViewerController', () => {
  it('opens floating on desktop through the mounted semantic port and docks into the pane presentation locally', async () => {
    const { render, openDocked } = mountController({ phone: false });
    const hook = await render();
    let result = await act(async () =>
      hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'computer' }),
    );
    expect(result).toEqual({ status: 'applied' });
    expect(hook.getCurrent().controller.state).toMatchObject({
      source: 'computer',
      mode: 'floating',
    });
    expect(
      isSessionViewerPresenting(hook.getCurrent().controller, 'computer'),
    ).toBe(true);
    expect(
      isSessionViewerPresenting(hook.getCurrent().controller, 'browser'),
    ).toBe(false);

    result = await act(async () =>
      hook.getCurrent().controller.apply({ kind: 'viewer.dock' }),
    );
    expect(result).toEqual({ status: 'applied' });
    expect(openDocked).toHaveBeenCalledWith('computer');
    // Docked on desktop: the pane presents the same body, so the viewer no longer does.
    expect(
      isSessionViewerPresenting(hook.getCurrent().controller, 'computer'),
    ).toBe(false);

    // Watch again while docked reveals the pane presentation instead of doing nothing.
    result = await act(async () =>
      hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'computer' }),
    );
    expect(result).toEqual({ status: 'unchanged' });
    expect(openDocked).toHaveBeenCalledTimes(2);
    await hook.unmount();
  });

  it('docks sticky on a phone, expands and restores to the dock, and keeps Close closed', async () => {
    const { render, openDocked } = mountController({ phone: true });
    const hook = await render();
    await act(async () => {
      hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'browser' });
    });
    expect(hook.getCurrent().controller.state.mode).toBe('docked');
    expect(
      isSessionViewerPresenting(hook.getCurrent().controller, 'browser'),
    ).toBe(true);
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.expand' });
    });
    expect(hook.getCurrent().controller.state.mode).toBe('expanded');
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.restore' });
    });
    expect(hook.getCurrent().controller.state.mode).toBe('docked');
    // Corner/size stay desktop-local geometry.
    expect(
      hook
        .getCurrent()
        .controller.apply({ kind: 'viewer.corner.set', corner: 'tl' }),
    ).toEqual({ status: 'unavailable' });
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.close' });
    });
    expect(hook.getCurrent().controller.state.mode).toBe('closed');
    expect(openDocked).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('refuses a source the Session cannot present without changing what is shown', async () => {
    const { render } = mountController({ phone: false, computer: false });
    const hook = await render();
    const result = await act(async () =>
      hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'computer' }),
    );
    expect(result).toEqual({ status: 'unavailable' });
    expect(hook.getCurrent().controller.state.mode).toBe('closed');
    await hook.unmount();
  });

  it('publishes the reading column yield only while a settled viewer floats', async () => {
    const { render } = mountController({ phone: false });
    const hook = await render();
    await act(async () => {
      hook.getCurrent().controller.setReadingInset({ left: 0, right: 320 });
    });
    expect(hook.getCurrent().inset).toEqual({ left: 0, right: 0 });
    await act(async () => {
      hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'browser' });
    });
    expect(hook.getCurrent().inset).toEqual({ left: 0, right: 320 });
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.expand' });
    });
    expect(hook.getCurrent().inset).toEqual({ left: 0, right: 0 });
    await hook.unmount();
  });
});

describe('resolveSessionViewerReadingInset', () => {
  const area = 1200;
  const column = 760;

  it('leaves the column alone when the free margin already clears the viewer', () => {
    // Column spans 220..980; a viewer from 1000 leaves it untouched.
    expect(
      resolveSessionViewerReadingInset({
        areaWidth: area,
        columnMaxWidth: column,
        rect: { x: 1000, y: 300, width: 184, height: 150 },
      }),
    ).toEqual({ left: 0, right: 0 });
  });

  it('recentres the column just enough to clear a right-side viewer, then narrows it', () => {
    const rect = { x: 800, y: 300, width: 384, height: 280 };
    const inset = resolveSessionViewerReadingInset({
      areaWidth: area,
      columnMaxWidth: column,
      rect,
    });
    const remaining = area - inset.right;
    const columnRight = (remaining + Math.min(remaining, column)) / 2;
    expect(inset.left).toBe(0);
    expect(columnRight).toBeLessThanOrEqual(rect.x - SESSION_VIEWER_EDGE);
    expect(remaining).toBeGreaterThanOrEqual(column);

    const wide = { x: 500, y: 300, width: 684, height: 400 };
    const narrowed = resolveSessionViewerReadingInset({
      areaWidth: area,
      columnMaxWidth: column,
      rect: wide,
    });
    expect(area - narrowed.right).toBe(wide.x - SESSION_VIEWER_EDGE);
  });

  it('yields on the left for a left-corner viewer', () => {
    const inset = resolveSessionViewerReadingInset({
      areaWidth: area,
      columnMaxWidth: column,
      rect: { x: 16, y: 300, width: 384, height: 280 },
    });
    expect(inset.right).toBe(0);
    expect(inset.left).toBeGreaterThan(0);
  });
});
