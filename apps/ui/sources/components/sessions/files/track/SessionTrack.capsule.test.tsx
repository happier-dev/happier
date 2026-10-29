// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  renderScreen,
  pressTestInstanceAsync,
  invokeTestInstanceHandler,
} from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const { TrackCapsule, TrackInputBoundary } = await import('./SessionTrack');
type Model = React.ComponentProps<typeof TrackCapsule>['track'];

function model(overrides: Partial<Model>): Model {
  return {
    enabled: false,
    paused: false,
    pauseReason: null,
    target: {
      path: 'src/a.ts',
      write: { toolCallId: 't', sessionId: 's', startedAt: 1 },
    },
    setEnabled: vi.fn(),
    toggle: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    agentId: null,
    agentTitle: 'Claude',
    ...overrides,
  } as Model;
}

describe('Track strip capsule (lab tr T0–T2)', () => {
  it('receives browser wheel/touch intent even when the editor stops bubbling, and ignores programmatic scroll', async () => {
    const pause = vi.fn();
    const following = model({ enabled: true, pause });
    const root = document.createElement('div');
    const editor = document.createElement('div');
    root.append(editor);
    for (const kind of ['wheel', 'pointerdown', 'keydown']) editor.addEventListener(kind, event => event.stopPropagation());
    const screen = await renderScreen(<TrackInputBoundary track={following}><></></TrackInputBoundary>, {
      createNodeMock: () => root,
    });
    try {
      editor.dispatchEvent(new Event('scroll', { bubbles: true }));
      expect(following.pause).not.toHaveBeenCalled();
      editor.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 50 }));
      expect(following.pause).toHaveBeenLastCalledWith('scroll');
      pause.mockClear();
      editor.dispatchEvent(new Event('touchmove', { bubbles: true }));
      expect(following.pause).toHaveBeenLastCalledWith('touch');
      pause.mockClear();
      editor.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(pause).toHaveBeenLastCalledWith('selection');
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
      expect(pause).toHaveBeenLastCalledWith('typing');
    } finally { await screen.unmount(); }
    pause.mockClear();
    editor.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 50 }));
    expect(following.pause).not.toHaveBeenCalled();
  });
  it('is absent while nobody writes, and each state does what its label says', async () => {
    const idle = await renderScreen(
      <TrackCapsule track={model({ target: null })} />,
    );
    expect(idle.findByTestId('session-details-track-capsule')).toBeFalsy();

    const off = model({});
    const offScreen = await renderScreen(<TrackCapsule track={off} />);
    await pressTestInstanceAsync(
      offScreen.findByTestId('session-details-track-capsule'),
    );
    expect(off.setEnabled).toHaveBeenCalledWith(true);

    const paused = model({
      enabled: true,
      paused: true,
      pauseReason: 'scroll',
    });
    const pausedScreen = await renderScreen(<TrackCapsule track={paused} />);
    await pressTestInstanceAsync(
      pausedScreen.findByTestId('session-details-track-capsule'),
    );
    expect(paused.resume).toHaveBeenCalledTimes(1);
    expect(paused.setEnabled).not.toHaveBeenCalled();

    const on = model({ enabled: true });
    const onScreen = await renderScreen(<TrackCapsule track={on} />);
    await pressTestInstanceAsync(
      onScreen.findByTestId('session-details-track-capsule'),
    );
    expect(on.setEnabled).toHaveBeenCalledWith(false);
    expect(on.resume).not.toHaveBeenCalled();
  });

  it('pauses on person input in the pane but not on a press of the capsule itself', async () => {
    const following = model({ enabled: true });
    const root = document.createElement('div');
    const capsule = document.createElement('button');
    capsule.setAttribute('data-testid', 'session-details-track-capsule');
    root.append(capsule);
    const screen = await renderScreen(
      <TrackInputBoundary track={following}>
        <TrackCapsule track={following} />
      </TrackInputBoundary>, { createNodeMock: () => root },
    );
    try {
      capsule.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      capsule.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
      expect(following.pause).not.toHaveBeenCalled();
      root.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(following.pause).toHaveBeenCalledWith('selection');
    } finally { await screen.unmount(); }
  });

  it('retains the native touch takeover boundary', async () => {
    const { Platform } = await import('react-native');
    const originalOS = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const following = model({ enabled: true });
    try {
      const screen = await renderScreen(<TrackInputBoundary track={following}><></></TrackInputBoundary>);
      try {
        const boundary = screen.tree.root.findAll(node => typeof node.props.onTouchStart === 'function')[0]!;
        await invokeTestInstanceHandler(boundary, 'onTouchStart', {});
        expect(following.pause).toHaveBeenCalledWith('touch');
      } finally { await screen.unmount(); }
    } finally { Object.defineProperty(Platform, 'OS', originalOS); }
  });
});
