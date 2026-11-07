import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const { RoundButton } = await import('./RoundButton');

describe('RoundButton disabled reason (MR6: a disabled control names its reason at the control)', () => {
  it('gives the reason as the accessibility hint, and only while disabled', async () => {
    const screen = await renderScreen(
      <RoundButton
        testID="start"
        title="Start session"
        disabled
        disabledReason="Lima is asleep."
      />,
    );
    expect(screen.findByTestId('start')?.props.accessibilityHint).toBe(
      'Lima is asleep.',
    );
    await act(async () =>
      screen.update(
        <RoundButton
          testID="start"
          title="Start session"
          disabledReason="Lima is asleep."
        />,
      ),
    );
    expect(
      screen.findByTestId('start')?.props.accessibilityHint,
    ).toBeUndefined();
  });

  it('stays reachable: a press shows the reason instead of acting', async () => {
    const onPress = vi.fn();
    const screen = await renderScreen(
      <RoundButton
        testID="start"
        title="Start session"
        disabled
        disabledReason="Lima is asleep."
        onPress={onPress}
      />,
    );
    expect(screen.findByTestId('start')?.props.tabIndex).not.toBe(-1);
    expect(screen.findByTestId('start-tooltip')).toBeNull();
    await act(async () => {
      screen.findByTestId('start')?.props.onPress?.();
    });
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.findByTestId('start-tooltip')).toBeTruthy();
    expect(screen.findByTestId('start-tooltip')?.props.label).toBe('Lima is asleep.');
  });
});
