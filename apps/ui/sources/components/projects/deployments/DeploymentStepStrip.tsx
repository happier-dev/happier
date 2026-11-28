import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentStepV1 } from '@happier-dev/deployments/contracts/v1';

import { formatElapsedDuration } from '@/components/machines/durationWords';
import { Text } from '@/components/ui/text/Text';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
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
 * One projection of a deployment's steps (lab `dk-strip`, `siaR3` Q8 strip), drawn where a deploy is summarized: the
 * rail row (`compact`: a glyph per step, joined) and the Environment's deploy card (`full`: one equal track per step
 * that fills as the step does, its glyph, name and time beneath). Done tracks settle to quiet ink, the running one
 * carries the only spinner, a failed one its state colour. On a phone the tracks keep their glyphs and the step being
 * waited on is named beneath them. The receipt page draws its own step rows instead, so the
 * same steps never appear twice on one page.
 */
export const DeploymentStepStrip = React.memo(function DeploymentStepStrip(
  props: Readonly<{
    steps: readonly DeploymentStepV1[];
    variant: 'compact' | 'full';
    testID: string;
    /** A compact strip that stands alone (a phone's serving receipt) carries its own caption. */
    captioned?: boolean;
    /** A full strip on a phone: the tracks keep their glyphs; the step being waited on is named beneath. */
    narrow?: boolean;
  }>,
) {
  if (props.variant === 'full') return <DeploymentStepTracks steps={props.steps} testID={props.testID} narrow={props.narrow === true} />;
  const caption = props.captioned ? deploymentStepCaption(props.steps) : null;
  return (
    <View
      testID={props.testID}
      accessibilityRole="list"
      accessibilityLabel={t('projects.deployments.steps')}
      style={styles.compact}
    >
      {props.steps.map((step, index) => {
        const status = deploymentStepWorkStatus(step);
        return (
          <React.Fragment key={step.id}>
            {index > 0 ? <View style={styles.connector} /> : null}
            <View accessibilityLabel={`${step.label}: ${status.word}`}>
              <WorkStatusGlyph
                status={status}
                testIDSuffix={`deployment-strip-${step.id}`}
              />
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

type TrackTone = 'pending' | 'done' | 'now' | 'failed';

function trackTone(step: DeploymentStepV1): TrackTone {
  switch (step.state) {
    case 'succeeded':
      return 'done';
    case 'running':
      return 'now';
    case 'failed':
    case 'outcome_unknown':
      return 'failed';
    case 'pending':
    case 'skipped':
    case 'cancelled':
      return 'pending';
  }
}

function DeploymentStepTracks(
  props: Readonly<{ steps: readonly DeploymentStepV1[]; testID: string; narrow: boolean }>,
) {
  const { theme } = useUnistyles();
  // A phone's tracks are too narrow for names: each keeps its glyph, and the step being waited on is named beneath.
  const caption = props.narrow ? deploymentStepCaption(props.steps) : null;
  return (
    <View style={styles.tracksBlock}>
    <View
      testID={props.testID}
      accessibilityRole="list"
      accessibilityLabel={t('projects.deployments.steps')}
      style={styles.tracks}
    >
      {props.steps.map((step) => {
        const status = deploymentStepWorkStatus(step);
        const tone = trackTone(step);
        const fill = tone === 'done' ? theme.colors.text.tertiary
          : tone === 'now' ? theme.colors.text.primary
            : tone === 'failed' ? workStatusGlyphColor(theme.colors, status.tone)
              : theme.colors.border.default;
        return (
          <View
            key={step.id}
            testID={`${props.testID}.${step.id}`}
            accessibilityLabel={`${step.label}: ${status.word}`}
            style={styles.track}
          >
            <View style={[styles.bar, { backgroundColor: fill }]} />
            <View style={styles.trackLabel}>
              <WorkStatusGlyph status={status} testIDSuffix={`deployment-strip-${step.id}`} />
              {props.narrow ? null : (
                <Text numberOfLines={1} style={[styles.label, tone === 'now' || tone === 'failed' ? styles.labelNow : null]}>
                  {step.label}
                </Text>
              )}
              {!props.narrow && step.durationMs !== undefined ? (
                <Text numberOfLines={1} style={styles.duration}>{formatElapsedDuration(step.durationMs)}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
    {caption ? <Text numberOfLines={1} style={styles.trackCaption}>{caption}</Text> : null}
    </View>
  );
}

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
  // Equal tracks across the card's width (lab siaR3 `r3-strip`): the bar on top, the step's name and time beneath.
  tracksBlock: {
    gap: theme.space.s8,
  },
  tracks: {
    flexDirection: 'row',
    gap: theme.space.s8,
  },
  trackCaption: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  track: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
    gap: theme.space.s8,
  },
  bar: {
    height: theme.space.s2,
    borderRadius: theme.space.s2,
  },
  trackLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
  },
  label: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  labelNow: {
    color: theme.colors.text.primary,
  },
  caption: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    marginLeft: theme.space.s8,
    flexShrink: 1,
  },
  duration: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
    marginLeft: 'auto',
    paddingLeft: theme.space.s4,
  },
}));
