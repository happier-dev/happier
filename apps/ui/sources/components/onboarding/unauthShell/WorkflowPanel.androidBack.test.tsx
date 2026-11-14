import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

import { WorkflowPanel } from './WorkflowPanel';

type HardwareBackHandler = () => boolean | null | undefined;

// Android's BackHandler is the OS boundary: the newest listener answers first.
const nativeBack = vi.hoisted(() => {
  let handlers: HardwareBackHandler[] = [];
  return {
    addEventListener: (eventName: string, handler: HardwareBackHandler) => {
      if (eventName !== 'hardwareBackPress')
        throw new Error(`Unexpected native BackHandler event: ${eventName}`);
      handlers = [...handlers, handler];
      return {
        remove: () => {
          handlers = handlers.filter((candidate) => candidate !== handler);
        },
      };
    },
    emit(): boolean {
      for (const handler of [...handlers].reverse()) {
        if (handler()) return true;
      }
      return false;
    },
    reset() {
      handlers = [];
    },
  };
});

vi.mock('react-native', async () => {
  const actual =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      OS: 'android',
      select: <T,>(values: { android?: T; native?: T; default?: T }) =>
        values.android ?? values.native ?? values.default,
    },
    BackHandler: { addEventListener: nativeBack.addEventListener },
  };
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

afterEach(() => {
  nativeBack.reset();
  standardCleanup();
});

describe('WorkflowPanel Android Back', () => {
  it('takes the hardware Back the same way as its on-screen Back, and leaves it to the app when there is none', async () => {
    const onBack = vi.fn();
    const panel = (back?: () => void) => (
      <WorkflowPanel
        variant="mobile"
        isWelcomeStep={false}
        onOpenRelayCustomFlow={() => {}}
        onBack={back}
        transitionKey="connect_home"
        transitionDirection="forward"
      >
        <></>
      </WorkflowPanel>
    );

    const screen = await renderScreen(panel(onBack));
    await flushHookEffects();
    expect(nativeBack.emit()).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();

    await screen.update(panel(undefined));
    await flushHookEffects();
    expect(nativeBack.emit()).toBe(false);
    expect(onBack).toHaveBeenCalledOnce();
  });
});
