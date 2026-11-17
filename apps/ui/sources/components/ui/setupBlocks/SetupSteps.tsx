import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_TONE_COLOR_TOKEN,
  HappierSetupSteps,
  happierPageTextMetrics,
  type HappierSetupStep,
  type HappierSetupStepGlyphState,
  type HappierSetupStepState,
  type HappierSetupStepsVariant,
  type HappierSetupStepTitlePresentation,
} from '@happier-dev/plugin-ui/presentation';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

export type SetupStep = HappierSetupStep;
export type SetupStepState = HappierSetupStepState;

const STATE_GLYPH = {
  done: 'check',
  failed: 'x',
  waiting: 'question',
} as const satisfies Record<HappierSetupStepGlyphState, IconName>;

/** A stable, readable test id segment for a step key a producer reports (system task step ids, stage ids). */
export function encodeSetupStepKeyForTestId(key: string): string {
  return (
    String(key ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

/** `<prefix>-<state>-<key>`: a progress step's test id names where it stands. */
export function setupStepTestID(
  prefix: string,
  key: string,
  state: SetupStepState = 'upcoming',
): string {
  return `${prefix}-${state}-${encodeSetupStepKeyForTestId(key)}`;
}

/** Numbered instructions and quiet flow cues. Reported run progress uses PlanChecklistCard. */
export function SetupSteps(
  props: Readonly<{
    steps: readonly SetupStep[];
    plain?: boolean;
    variant?: HappierSetupStepsVariant;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const presentationTheme = usePluginUiTheme(theme);
  return (
    <HappierSetupSteps
      {...props}
      theme={presentationTheme}
      renderStateGlyph={(glyph) => (
        <Icon
          name={STATE_GLYPH[glyph.state]}
          size={glyph.size}
          color={presentationTheme.colors[HAPPIER_TONE_COLOR_TOKEN[glyph.tone]]}
        />
      )}
      renderTitle={(step, title) =>
        typeof step.title === 'string' ? (
          <Text style={[titleStyle(title), { color: title.color }]}>
            {step.title}
          </Text>
        ) : (
          step.title
        )
      }
      renderDetail={(detail) => <Text style={styles.detail}>{detail}</Text>}
      renderMeta={(meta) => <Text style={styles.meta}>{meta}</Text>}
    />
  );
}

function titleStyle(title: HappierSetupStepTitlePresentation) {
  const weight =
    title.weight === 'regular'
      ? Typography.default()
      : Typography.default(title.weight);
  if (title.variant !== 'numbered' || title.plain)
    return [styles.lineTitle, weight];
  return [styles.title, weight];
}

const styles = StyleSheet.create((theme) => ({
  title: {
    ...happierPageTextMetrics('rowTitle'),
    paddingTop: 1,
  },
  lineTitle: {
    ...happierPageTextMetrics('rowDescription'),
  },
  detail: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    marginTop: theme.space.s2,
    color: theme.colors.text.secondary,
  },
  meta: {
    ...Typography.default(),
    ...Typography.tabular(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
}));
