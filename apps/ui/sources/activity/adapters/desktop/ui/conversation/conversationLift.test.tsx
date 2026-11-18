import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
  useDesktopActivityOverlayConversationLift,
  type DesktopActivityOverlayConversationLift,
} from './conversationLift';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
});

const rowAt = (top: number) => ({
  getBoundingClientRect: () => ({ left: 12, top, width: 400, height: 48 }),
});

async function renderLift(): Promise<DesktopActivityOverlayConversationLift> {
  let lift: DesktopActivityOverlayConversationLift | null = null;
  function Probe() {
    lift = useDesktopActivityOverlayConversationLift();
    return null;
  }
  await renderScreen(<Probe />);
  return lift!;
}

describe('conversation lift', () => {
  it('hands the pressed row to the header of that same Session once, and to no other', async () => {
    const lift = await renderLift();

    lift.capture('session-1', rowAt(180));
    expect(lift.take('session-1')).toEqual({
      x: 12,
      y: 180,
      width: 400,
      height: 48,
    });
    expect(lift.take('session-1')).toBeNull();

    // A face or a pin from main opens another Session: the old press never replays for it.
    lift.capture('session-1', rowAt(220));
    expect(lift.take('bot-flake')).toBeNull();
    expect(lift.take('session-1')).toBeNull();
  });
});
