import { HappierDivider } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { StepOrDivider } from './StepFormParts';

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
