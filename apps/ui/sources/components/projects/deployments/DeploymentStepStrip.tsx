import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentStepV1 } from '@happier-dev/deployments/contracts/v1';

import { formatElapsedDuration } from '@/components/machines/durationWords';
import { Text } from '@/components/ui/text/Text';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { deploymentStepWorkStatus } from './deploymentPresentation';

/** The step a person is waiting on: the one running, failed or unconfirmed. */
export function currentStep(
  steps: readonly DeploymentStepV1[],
): DeploymentStepV1 | null {
  return (
    steps.find(
      (step) =>
        step.state === 'running' ||
        step.state === 'failed' ||
        step.state === 'outcome_unknown',
    ) ?? null
  );
}

/**
 * The caption a compact strip carries (lab `dk-strip`): the step being waited on and its time, or that every
 * step passed. Nothing when neither is true.
 */
export function deploymentStepCaption(
  steps: readonly DeploymentStepV1[],
): string | null {
  const current = currentStep(steps);
  if (current) {
    return current.durationMs !== undefined
      ? `${current.label} · ${formatElapsedDuration(current.durationMs)}`
      : current.label;
  }
  return steps.length > 0 && steps.every((step) => step.state === 'succeeded')
    ? t('projects.deployments.allStepsPassed', { count: steps.length })
    : null;
}

/**
 * One projection of a deployment's steps (lab `dk-strip`), drawn where a deploy is summarized: the rail row
 * (`compact`: a glyph per step, joined) and the serving receipt (`full`: each step's name and time). The
 * receipt page draws its own step rows instead, so the same steps never appear twice on one page.
 */
export const DeploymentStepStrip = React.memo(function DeploymentStepStrip(
  props: Readonly<{
    steps: readonly DeploymentStepV1[];
    variant: 'compact' | 'full';
    testID: string;
    /** A compact strip that stands alone (a phone's serving receipt) carries its own caption. */
    captioned?: boolean;
  }>,
) {
  const full = props.variant === 'full';
  const caption = props.captioned && !full ? deploymentStepCaption(props.steps) : null;
  return (
    <View
      testID={props.testID}
      accessibilityRole="list"
      accessibilityLabel={t('projects.deployments.steps')}
      style={full ? styles.full : styles.compact}
    >
      {props.steps.map((step, index) => {
        const status = deploymentStepWorkStatus(step);
        return (
          <React.Fragment key={step.id}>
            {index > 0 ? (
              <View style={full ? styles.connectorFull : styles.connector} />
            ) : null}
            <View
              accessibilityLabel={`${step.label}: ${status.word}`}
              style={full ? styles.stepFull : undefined}
            >
              <WorkStatusGlyph
                status={status}
                testIDSuffix={`deployment-strip-${step.id}`}
              />
              {full ? (
                <Text numberOfLines={1} style={styles.label}>
                  {step.label}
                  {step.durationMs !== undefined ? (
                    <Text
                      style={styles.duration}
                    >{`  ${formatElapsedDuration(step.durationMs)}`}</Text>
                  ) : null}
                </Text>
              ) : null}
            </View>
          </React.Fragment>
        );
      })}
      {caption ? (
        <Text numberOfLines={1} style={styles.caption}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  connector: {
    width: 6,
    height: StyleSheet.hairlineWidth * 2,
    marginHorizontal: 2,
    backgroundColor: theme.colors.border.default,
  },
  full: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    rowGap: theme.space.s8,
  },
  stepFull: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
  },
  connectorFull: {
    flexGrow: 1,
    minWidth: 16,
    maxWidth: 96,
    height: StyleSheet.hairlineWidth * 2,
    marginHorizontal: theme.space.s8,
    backgroundColor: theme.colors.border.default,
  },
  label: {
    ...Typography.variant('meta'),
    color: theme.colors.text.primary,
  },
  caption: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    marginLeft: theme.space.s8,
    flexShrink: 1,
  },
  duration: {
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
}));
