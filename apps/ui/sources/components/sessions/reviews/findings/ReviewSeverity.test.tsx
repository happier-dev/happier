import React from 'react';
import { StyleSheet } from 'react-native';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { ReviewSeverityLabel } from './ReviewSeverity';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

it('draws each severity in the colour role the shared severity owner gives it, Low in quiet ink rather than the accent', async () => {
  const theme = createThemeFixture() as ReturnType<
    typeof createThemeFixture
  > & {
    colors: {
      text: Record<string, string>;
      state: Record<string, { foreground: string }>;
      accent: Record<string, string>;
    };
  };
  const screen = await renderScreen(
    <>
      {(['blocker', 'high', 'medium', 'low', 'nit'] as const).map(
        (severity) => (
          <ReviewSeverityLabel
            key={severity}
            severity={severity}
            label={`${severity} words`}
          />
        ),
      )}
    </>,
  );
  const colorOf = (label: string) => {
    const node = screen.root.findAll(
      (candidate) =>
        typeof candidate.type === 'string' &&
        candidate.props.children === label,
    )[0];
    return StyleSheet.flatten(node?.props.style)?.color;
  };
  expect(colorOf('blocker words')).toBe(theme.colors.state.danger.textForeground);
  expect(colorOf('high words')).toBe(theme.colors.state.danger.textForeground);
  expect(colorOf('medium words')).toBe(theme.colors.state.warning.textForeground);
  expect(colorOf('low words')).toBe(theme.colors.text.secondary);
  expect(colorOf('nit words')).toBe(theme.colors.text.tertiary);
  expect(colorOf('low words')).not.toBe(theme.colors.accent.blue);
});
