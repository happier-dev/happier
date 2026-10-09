import { act, useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  FloatingFrame,
  resolveFloatingFrameBodyRect,
  resolveFloatingFrameHeight,
  type FloatingFrameProps,
  type HappierFloatingFramePointerBinding,
} from './FloatingFrame.js';
import type { FrameRect } from './floatingFrameGeometry.js';

/**
 * Plan 70s3: the one neutral floating frame. The browser pointer/listener boundary is the only
 * platform piece supplied here; drag, release and placement run through the real shared owners.
 */
type Listening = {
  addEventListener: (name: string, listener: EventListener) => void;
  removeEventListener: (name: string, listener: EventListener) => void;
};

const readPoint = (event: unknown) => {
  const record = event as { clientX?: unknown; clientY?: unknown };
  return {
    x: typeof record.clientX === 'number' ? record.clientX : null,
    y: typeof record.clientY === 'number' ? record.clientY : null,
  };
};

const DOM_POINTER: HappierFloatingFramePointerBinding = {
  readClientPoint: readPoint,
  readScreenPoint: readPoint,
  pointerHost: {
    capturePointer: () => {},
    releasePointer: () => {},
    listenForStart(target, start) {
      const node = target as Listening | null;
      node?.addEventListener('pointerdown', start as EventListener);
      return () =>
        node?.removeEventListener('pointerdown', start as EventListener);
    },
    listenForActive(_target, handlers) {
      window.addEventListener('pointermove', handlers.move as EventListener);
      window.addEventListener('pointerup', handlers.end as EventListener);
      window.addEventListener(
        'pointercancel',
        handlers.cancel as EventListener,
      );
      return () => {
        window.removeEventListener(
          'pointermove',
          handlers.move as EventListener,
        );
        window.removeEventListener('pointerup', handlers.end as EventListener);
        window.removeEventListener(
          'pointercancel',
          handlers.cancel as EventListener,
        );
      };
    },
  },
};

const AVAILABLE: FrameRect = { x: 16, y: 16, width: 1000, height: 700 };
const ASPECT = 16 / 10;
const WIDTH = 400;
const START: FrameRect = {
  x: AVAILABLE.x + AVAILABLE.width - WIDTH,
  y: AVAILABLE.y + AVAILABLE.height - resolveFloatingFrameHeight(WIDTH, ASPECT),
  width: WIDTH,
  height: resolveFloatingFrameHeight(WIDTH, ASPECT),
};

function mount(
  overrides: Partial<FloatingFrameProps> = {},
  controlRole: 'button' | 'tab' = 'button',
) {
  const onRectChange = vi.fn();
  const onModeChange = vi.fn();
  const onBodyPress = vi.fn();
  const control = (
    <Pressable
      testID="take-control"
      accessibilityRole={controlRole}
      onPress={onBodyPress}
    >
      <Text>{controlRole === 'tab' ? 'Browser source' : 'Take control'}</Text>
    </Pressable>
  );
  const view = mountThroughReactNativeWeb(
    <FloatingFrame
      testID="frame"
      mode="floating"
      rect={START}
      availableRect={AVAILABLE}
      aspectRatio={ASPECT}
      moveInput="surface"
      onRectChange={onRectChange}
      onModeChange={onModeChange}
      controls={
        <>
          <Pressable
            testID="close"
            accessibilityRole="button"
            accessibilityLabel="Close view"
            onPress={() => {}}
          >
            <Text>x</Text>
          </Pressable>
          {controlRole === 'tab' ? control : null}
        </>
      }
      accessibilityLabel="Watching Browser on fly-bot-1"
      resizeLabel="Resize view"
      pointer={DOM_POINTER}
      {...overrides}
    >
      <Text testID="picture">picture</Text>
      {controlRole === 'button' ? control : null}
    </FloatingFrame>,
  );
  const byId = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  return { view, byId, onRectChange, onModeChange, onBodyPress };
}

function pointer(
  target: Element | Window,
  type: string,
  x: number,
  y: number,
  timeStamp = 0,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  act(() => {
    target.dispatchEvent(event);
  });
}

function drag(from: Element, dx: number, dy: number) {
  pointer(from, 'pointerdown', 500, 500, 0);
  pointer(window, 'pointermove', 500 + dx / 2, 500 + dy / 2, 200);
  pointer(window, 'pointermove', 500 + dx, 500 + dy, 400);
  pointer(window, 'pointerup', 500 + dx, 500 + dy, 600);
}

function key(target: Element, value: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('FloatingFrame', () => {
  it('moves 1:1 by its picture while watching and settles into the nearest corner on release', () => {
    const { view, byId, onRectChange } = mount();
    drag(byId('picture'), -400, -300);

    const moves = onRectChange.mock.calls
      .filter(([, change]) => change.kind === 'move')
      .map(([rect]) => rect);
    expect(moves.at(-1)).toMatchObject({ x: START.x - 400, y: START.y - 300 });
    const [settled, change] = onRectChange.mock.calls.at(-1)!;
    expect(change).toEqual({ kind: 'settle' });
    expect(settled).toEqual({ ...START, x: AVAILABLE.x, y: AVAILABLE.y });
    view.unmount();
  });

  it('leaves picture input to the content while controlling; the controls band and the grip still move it', () => {
    const { view, byId, onRectChange } = mount({ moveInput: 'chrome' });
    drag(byId('picture'), -300, 0);
    expect(onRectChange).not.toHaveBeenCalled();

    drag(byId('frame-controls'), -700, 0);
    expect(onRectChange.mock.calls.at(-1)).toEqual([
      { ...START, x: AVAILABLE.x },
      { kind: 'settle' },
    ]);

    onRectChange.mockClear();
    drag(byId('frame-grip'), -100, 0);
    const grown = onRectChange.mock.calls
      .filter(([, change]) => change.kind === 'move')
      .at(-1)![0] as FrameRect;
    expect(grown.width).toBe(WIDTH + 100);
    expect(grown.x + grown.width).toBe(START.x + START.width);
    view.unmount();
  });

  it.each(['button', 'tab'] as const)(
    'never starts a move from a %s control, so its press still lands',
    (role) => {
      const { view, byId, onRectChange, onBodyPress } = mount(
        { moveInput: role === 'tab' ? 'chrome' : 'surface' },
        role,
      );
      const control = byId('take-control');
      expect(control.getAttribute('role')).toBe(role);
      pointer(control, 'pointerdown', 500, 500);
      pointer(window, 'pointermove', 300, 300, 50);
      pointer(window, 'pointerup', 300, 300, 100);
      expect(onRectChange).not.toHaveBeenCalled();
      act(() => {
        control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onBodyPress).toHaveBeenCalledTimes(1);
      view.unmount();
    },
  );

  it('snaps to corners with arrow keys and resizes from the grip without a pointer', () => {
    const { view, byId, onRectChange } = mount({ pointer: undefined });
    key(byId('frame'), 'ArrowLeft');
    expect(onRectChange.mock.calls.at(-1)).toEqual([
      { ...START, x: AVAILABLE.x },
      { kind: 'settle' },
    ]);
    key(byId('frame'), 'ArrowUp');
    expect(onRectChange.mock.calls.at(-1)).toEqual([
      { ...START, y: AVAILABLE.y },
      { kind: 'settle' },
    ]);

    key(byId('frame-grip'), 'ArrowLeft');
    const [larger] = onRectChange.mock.calls.at(-1)!;
    expect(larger.width).toBeCloseTo(WIDTH * 1.1);
    expect(larger.height).toBeCloseTo(
      resolveFloatingFrameHeight(WIDTH * 1.1, ASPECT),
    );
    view.unmount();
  });

  it('settles beside obstacles, and asks to dock when no floating placement fits', () => {
    const orb: FrameRect = {
      x: AVAILABLE.x + AVAILABLE.width - 60,
      y: AVAILABLE.y + AVAILABLE.height - 60,
      width: 60,
      height: 60,
    };
    const first = mount({ avoidRects: [orb] });
    key(first.byId('frame'), 'ArrowDown');
    const [settled] = first.onRectChange.mock.calls.at(-1)!;
    expect(
      settled.x + settled.width <= orb.x || settled.y + settled.height <= orb.y,
    ).toBe(true);
    first.view.unmount();

    const crowded = mount({ avoidRects: [AVAILABLE] });
    key(crowded.byId('frame'), 'ArrowLeft');
    expect(crowded.onModeChange).toHaveBeenCalledWith('docked');
    expect(crowded.onRectChange).not.toHaveBeenCalled();
    crowded.view.unmount();
  });

  it('keeps the same outcome under reduced motion, without travel', () => {
    const { view, byId, onRectChange } = mount({ reducedMotion: true });
    expect(byId('frame').style.transitionProperty).toBe('');
    key(byId('frame'), 'ArrowLeft');
    expect(onRectChange.mock.calls.at(-1)).toEqual([
      { ...START, x: AVAILABLE.x },
      { kind: 'settle' },
    ]);
    view.unmount();
  });

  it('keeps one body mounted across floating, expanded and docked, and renders nothing when closed', async () => {
    let mounts = 0;
    function Body() {
      useEffect(() => { mounts += 1; }, []);
      return <Text testID="retained">body</Text>;
    }
    const body = <Body />;
    const frame = (mode: FloatingFrameProps['mode']) => (
      <FloatingFrame
        testID="frame"
        mode={mode}
        rect={START}
        availableRect={AVAILABLE}
        aspectRatio={ASPECT}
        moveInput="surface"
        onRectChange={() => {}}
        onModeChange={() => {}}
        controls={null}
        accessibilityLabel="viewer"
      >
        {body}
      </FloatingFrame>
    );
    const view = mountThroughReactNativeWeb(frame('floating'));
    await view.render(frame('expanded'));
    await view.render(frame('docked'));
    expect(mounts).toBe(1);
    await view.render(frame('closed'));
    expect(view.container.querySelector('[data-testid="retained"]')).toBeNull();
    view.unmount();
  });

  it('draws a footer below the body and keeps the body aspect, including while resizing', () => {
    const height = resolveFloatingFrameHeight(WIDTH, ASPECT, { footer: true });
    const rect = { ...START, y: AVAILABLE.y + AVAILABLE.height - height, height };
    const { view, byId, onRectChange } = mount({
      rect,
      footer: <Text testID="presence">Claude is working</Text>,
    });
    const body = resolveFloatingFrameBodyRect(rect, { footer: true });
    expect(body.width / body.height).toBeCloseTo(ASPECT);
    expect(byId('frame-footer').contains(byId('presence'))).toBe(true);
    expect(byId('frame-body').contains(byId('presence'))).toBe(false);

    key(byId('frame-grip'), 'ArrowLeft');
    const [larger] = onRectChange.mock.calls.at(-1)!;
    const largerBody = resolveFloatingFrameBodyRect(larger, { footer: true });
    expect(largerBody.width / largerBody.height).toBeCloseTo(ASPECT);
    view.unmount();
  });

  it('never resizes below the usable minimum width the host measured', () => {
    const { view, byId, onRectChange } = mount({ minWidth: 380 });
    drag(byId('frame-grip'), 300, 0);
    const moves = onRectChange.mock.calls.filter(([, change]) => change.kind === 'move');
    expect(Math.min(...moves.map(([rect]) => (rect as FrameRect).width))).toBe(380);
    view.unmount();
  });

  it('expands on a double-click of the watched picture and restores on a second one or Escape', () => {
    const watching = mount();
    act(() => {
      watching.byId('picture').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(watching.onModeChange).toHaveBeenLastCalledWith('expanded');
    watching.view.unmount();

    const expanded = mount({ mode: 'expanded' });
    act(() => {
      expanded.byId('picture').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(expanded.onModeChange).toHaveBeenLastCalledWith('floating');
    expanded.onModeChange.mockClear();
    key(expanded.byId('frame'), 'Escape');
    expect(expanded.onModeChange).toHaveBeenLastCalledWith('floating');
    expanded.view.unmount();

    // Controlling: the picture's clicks belong to the content.
    const controlling = mount({ moveInput: 'chrome' });
    act(() => {
      controlling.byId('picture').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(controlling.onModeChange).not.toHaveBeenCalled();
    controlling.view.unmount();
  });
});
