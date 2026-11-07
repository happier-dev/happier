import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResizableSize, type ResizableSizeInput, type ResizableSizeResult } from './useResizableSize.js';
import { useResizableListDetailGeometry } from '../../collection/useResizableListDetailGeometry.js';

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); vi.unstubAllGlobals(); });

async function mount(options: Partial<ResizableSizeInput> = {}) {
  await act(async () => root?.unmount());
  let current!: ResizableSizeResult;
  const commits = vi.fn();
  const collapsed = vi.fn();
  const armed = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  function Surface() {
    current = useResizableSize({ axis: 'x', resizeEdge: 'end', sizePx: 320, minSizePx: 200, maxSizePx: 480,
      onCommitSizePx: commits, onCollapse: collapsed, onCollapseArmedChange: armed, ...options });
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => { root!.render(<Surface />); });
  await act(async () => { (current.webHandleProps.onPointerDown as (event: unknown) => void)({ clientX: 320 }); });
  const move = async (clientX: number) => { await act(async () => window.dispatchEvent(new MouseEvent('pointermove', { clientX }))); };
  const release = async () => { await act(async () => window.dispatchEvent(new MouseEvent('pointerup'))); };
  const flush = async () => { await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(0)); }); };
  return { commits, collapsed, armed, frames, move, release, flush, read: () => current };
}

describe('shared resize gesture', () => {
  it('exposes current rail overshoot to its wrapper and clears it at release, cancellation and reset', async () => {
    let current!: ReturnType<typeof useResizableListDetailGeometry>;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(1, callback); return 1; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    function Rail() {
      current = useResizableListDetailGeometry({ availableWidth: 1000, minListWidth: 200,
        minDetailWidth: 400, preferredListRatio: 0.3, gap: 0, listWidthPx: 300 });
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Rail />));
    const move = async (x: number) => {
      await act(async () => window.dispatchEvent(new MouseEvent('pointermove', { clientX: x })));
      await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); });
    };
    for (const finish of ['pointerup', 'pointercancel', 'reset']) {
      await act(async () => current.resize.webHandleProps.onPointerDown({ clientX: 300 }));
      await move(150);
      expect(current.dragMeta).toEqual(expect.objectContaining({ overshootPx: -50, collapseArmed: false }));
      await move(220);
      expect(current.dragMeta).toEqual(expect.objectContaining({ overshootPx: 0, collapseArmed: false }));
      await move(150);
      await act(async () => {
        if (finish === 'reset') current.resize.webHandleProps.onDoubleClick();
        else window.dispatchEvent(new MouseEvent(finish));
      });
      expect(current.dragMeta).toBeNull();
      if (finish === 'reset') await act(async () => window.dispatchEvent(new MouseEvent('pointercancel')));
    }
  });

  it('uses only the current move for overshoot and collapse, including a reversal before release', async () => {
    const drag = await mount({ collapse: true });
    await drag.move(99);
    await drag.flush();
    expect(drag.armed).toHaveBeenLastCalledWith(true);
    await drag.move(150);
    await drag.release();
    expect(drag.collapsed).not.toHaveBeenCalled();
    expect(drag.commits).toHaveBeenLastCalledWith(200, expect.objectContaining({ attemptedSizePx: 150, collapseArmed: false, exceededMinPx: true }));
    const returned = await mount({ collapse: true });
    await returned.move(99);
    await returned.move(220);
    await returned.release();
    expect(returned.commits).toHaveBeenLastCalledWith(220, expect.objectContaining({ exceededMinPx: false, collapseArmed: false, overshootPx: 0 }));
  });

  it('collapses only when opted in and released strictly past half the minimum', async () => {
    const drag = await mount({ collapse: true });
    await drag.move(100);
    await drag.release();
    expect(drag.collapsed).not.toHaveBeenCalled();
    const armed = await mount({ collapse: true });
    await armed.move(99);
    await armed.release();
    expect(armed.collapsed).toHaveBeenCalledOnce();
    expect(armed.commits).not.toHaveBeenCalled();
    const rail = await mount();
    await rail.move(1);
    await rail.release();
    expect(rail.collapsed).not.toHaveBeenCalled();
    expect(rail.commits).toHaveBeenCalledWith(200, expect.objectContaining({ collapseArmed: false }));
  });

  it('coalesces live sizes to one frame while committing the latest move synchronously', async () => {
    const live = vi.fn();
    const drag = await mount({ onDragSizePx: live });
    live.mockClear();
    await drag.move(340);
    await drag.move(360);
    expect(live).not.toHaveBeenCalled();
    expect(drag.frames.size).toBe(1);
    await drag.flush();
    expect(drag.read().effectiveSizePx).toBe(360);
    expect(live).toHaveBeenCalledWith(360, expect.objectContaining({ attemptedSizePx: 360 }));
    await drag.move(380);
    await drag.release();
    expect(drag.commits).toHaveBeenCalledWith(380, expect.objectContaining({ attemptedSizePx: 380 }));
    expect(drag.frames.size).toBe(0);
  });

  it('grows a centred surface from either edge by both edges\' travel', async () => {
    const start = await mount({ resizeEdge: 'both' });
    await start.move(300);
    await start.release();
    expect(start.commits).toHaveBeenLastCalledWith(360, expect.objectContaining({ attemptedSizePx: 360 }));
    const end = await mount({ resizeEdge: 'both' });
    await end.release();
    end.commits.mockClear();
    await act(async () => { (end.read().endHandle!.webHandleProps.onPointerDown as (event: unknown) => void)({ clientX: 320 }); });
    await end.move(340);
    await end.release();
    expect(end.commits).toHaveBeenLastCalledWith(360, expect.objectContaining({ attemptedSizePx: 360 }));
    await act(async () => { (end.read().endHandle!.webHandleProps.onPointerDown as (event: unknown) => void)({ clientX: 320 }); });
    await end.move(290);
    await end.release();
    expect(end.commits).toHaveBeenLastCalledWith(260, expect.objectContaining({ attemptedSizePx: 260 }));
  });

  it('requests an owner reset on double-click', async () => {
    const reset = vi.fn();
    const drag = await mount({ onResetRequest: reset });
    await act(async () => { (drag.read().webHandleProps.onDoubleClick as () => void)(); });
    expect(reset).toHaveBeenCalledOnce();
  });

  it('cancels an armed drag without collapsing or committing', async () => {
    const drag = await mount({ collapse: true });
    await drag.move(99);
    await act(async () => window.dispatchEvent(new MouseEvent('pointercancel')));
    expect(drag.collapsed).not.toHaveBeenCalled();
    expect(drag.commits).not.toHaveBeenCalled();
    expect(drag.frames.size).toBe(0);
  });
});
