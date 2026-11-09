import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { AtmosphereDissolve } from './AtmosphereDissolve.web';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

describe('the atmosphere fade', () => {
  it('arrives on the standard curve and leaves sooner than it arrives, on the exit curve', async () => {
    // The Web Animations API is the platform boundary: record what the layer asks of it.
    const timings: KeyframeAnimationOptions[] = [];
    const node = {
      style: {} as Record<string, string>,
      getAnimations: () => [],
      animate: (_frames: unknown, timing: KeyframeAnimationOptions) => {
        timings.push(timing);
        return {};
      },
    };
    const layer = (visible: boolean) => (
      <AtmosphereDissolve visible={visible} leave="fade" height={400} reducedMotion={false}>{null}</AtmosphereDissolve>
    );
    const screen = await renderScreen(layer(false), { createNodeMock: () => node });
    await screen.update(layer(true));
    await screen.update(layer(false));
    const [arrival, leaving] = timings;
    expect(arrival).toMatchObject({ duration: motionTokens.atmosphere.readyFadeMs, easing: motionTokens.easingCss.standard });
    expect(leaving).toMatchObject({ easing: motionTokens.easingCss.exit });
    expect(Number(leaving.duration)).toBeLessThan(Number(arrival.duration));
  });
});


it('cancels a pending departure when its pane unmounts so it cannot finish a later send', async () => {
  // Web Animations is the physical boundary. Cancellation suppresses its finish event.
  const cancel = vi.fn();
  const hidden = vi.fn();
  const animations: Array<{ cancel: typeof cancel; onfinish?: () => void }> = [];
  const node = {
    style: {} as Record<string, string>,
    getAnimations: () => animations,
    animate: () => {
      const animation = { cancel, onfinish: undefined as (() => void) | undefined };
      animations.push(animation);
      return animation;
    },
  };
  const scene = (visible: boolean) => <AtmosphereDissolve visible={visible} leave="climb"
    height={400} reducedMotion onHidden={hidden}>{null}</AtmosphereDissolve>;
  const screen = await renderScreen(scene(true), { createNodeMock: () => node });
  await screen.update(scene(false));
  expect(animations).toHaveLength(1);
  expect(cancel).not.toHaveBeenCalled();
  await screen.unmount();
  expect(cancel).toHaveBeenCalledOnce();
  expect(hidden).not.toHaveBeenCalled();
});


it('keeps completion with the departure that started it when a hidden planet hands over to a picture send', async () => {
  const beforeSend = vi.fn();
  const send = vi.fn();
  const animations: Array<{ cancel: () => void; onfinish?: () => void }> = [];
  const node = { style: {} as Record<string, string>, getAnimations: () => animations,
    animate: () => {
      const animation = { cancel() {}, onfinish: undefined as (() => void) | undefined };
      animations.push(animation);
      return animation;
    },
  };
  const scene = (visible: boolean, leave: 'climb' | 'fade', onHidden: () => void) =>
    <AtmosphereDissolve visible={visible} leave={leave} height={400} reducedMotion onHidden={onHidden}>{null}</AtmosphereDissolve>;
  const screen = await renderScreen(scene(true, 'fade', beforeSend), { createNodeMock: () => node });
  try {
    await screen.update(scene(false, 'fade', beforeSend));
    // This planet is already hidden for the picture. A send changes its callback without
    // starting another departure; its earlier hand-over cannot complete that picture's send.
    await screen.update(scene(false, 'climb', send));
    animations[0]!.onfinish?.();
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});
