import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import {
  DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  type PublicProfileField,
} from '@happier-dev/protocol/account/publicProfile';

import { renderScreen } from '@/dev/testkit';
import { publicProfileFigureControls } from './PublicProfileFigureEye';

describe('publicProfileFigureControls', () => {
  it('flips only the pressed figure’s own field, and quiets exactly the figures visitors don’t see', async () => {
    const toggled: Array<[PublicProfileField, boolean]> = [];
    const policy = {
      ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: {
        ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
        agentTime: true,
        currentStreak: false,
        bestStreak: true,
      },
    };
    const controls = publicProfileFigureControls({
      policy,
      disabled: false,
      onToggle: (field, shown) => toggled.push([field, shown]),
    });
    const screen = await renderScreen(
      <>
        {controls.renderFigureControl!('agentTimeMs')}
        {controls.renderFigureControl!('currentStreakDays')}
        {controls.renderFigureControl!('bestStreakDays')}
      </>,
    );
    for (const figure of ['agentTimeMs', 'currentStreakDays'] as const) {
      await act(async () => {
        screen
          .findByTestId(`public-profile-figure-eye-${figure}`)!
          .props.onPress();
      });
    }
    // Two streak figures, two fields: Current streak flips alone, Best streak is untouched.
    expect(toggled).toEqual([
      ['agentTime', false],
      ['currentStreak', true],
    ]);
    expect(controls.hiddenFigures?.has('currentStreakDays')).toBe(true);
    expect(controls.hiddenFigures?.has('bestStreakDays')).toBe(false);
  });
});
