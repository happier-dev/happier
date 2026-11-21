import { HappierDivider } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

import { StepOrDivider } from './StepFormParts';
import { StepRowWayButton } from './stepBack';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(standardCleanup);

describe('StepOrDivider', () => {
  // The one centred "or" is drawn from the shared divider: two strokes assistive technology skips, the word between.
  it('draws the word between two decorative shared hairlines', async () => {
    const screen = await renderScreen(<StepOrDivider label="or" />);
    const strokes = screen.findAllByType(HappierDivider as never);
    expect(strokes).toHaveLength(2);
    expect(strokes.every((stroke) => stroke.props.decorative === true)).toBe(
      true,
    );
    expect(
      screen.findAllByType('Text' as never).map((node) => node.props.children),
    ).toContain('or');
  });
});

it('lets the resting glass well show through while keeping the way operable', async () => {
  const onPress = vi.fn();
  const screen = await renderScreen(
    <StepRowWayButton testID="step-way" iconName="link" accessibilityLabel="Pairing link" onPress={onPress} />,
  );
  const buttonPaint = flattenTestStyle(screen.findByTestId('step-way-surface')!.props.style);
  expect(buttonPaint.width).toBe(44);
  expect(buttonPaint.borderRadius).toBe(buttonPaint.width / 2);
  expect(buttonPaint.borderWidth).toBeUndefined();
  expect(buttonPaint.backgroundColor).toBeUndefined();
  await screen.pressByTestIdAsync('step-way');
  expect(onPress).toHaveBeenCalledOnce();
});
