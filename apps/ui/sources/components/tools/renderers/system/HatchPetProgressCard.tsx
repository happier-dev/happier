import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_TYPE_SCALE } from '@happier-dev/plugin-ui/presentation';
import type { HatchPetProgressPlanV1 } from '@happier-dev/protocol/pets/hatchPetProgressV1';

import {
  PetPoseGrid,
  type PetPoseStatus,
} from '@/components/pets/render/PetPoseGrid';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

import { ToolSectionView } from '../../shell/presentation/ToolSectionView';

/** The poses are drawn at this size inside the plan (DECISIONS-R12 spec). */
const PLAN_POSE_PX = 40;

/**
 * Hatch pet's own checklist (lab r12-create-W, round 3): one row per step, its glyph in a box one text line high so it
 * centres on the text, the count right after its step, and the poses in the shared 3 × 3 grid on the step text's edge.
 * A failed step turns rose and says what went wrong once, under it. The plan is the skill's own snapshot, projected by
 * its owner; this view only draws it.
 */
export const HatchPetProgressCard = React.memo(function HatchPetProgressCard(
  props: Readonly<{ plan: HatchPetProgressPlanV1 }>,
) {
  const { plan } = props;
  const poseStatus = React.useCallback(
    (state: keyof HatchPetProgressPlanV1['poses']): PetPoseStatus => {
      const pose = plan.poses[state];
      return pose.status === 'drawn'
        ? 'drawn'
        : pose.status === 'drawing'
          ? 'drawing'
          : 'pending';
    },
    [plan.poses],
  );
  return (
    <ToolSectionView>
      <View style={styles.plan} testID="hatch-pet.progress">
        {plan.steps.map((step) => (
          <View
            key={step.id}
            style={styles.step}
            testID={`hatch-pet.progress.${step.id}`}
          >
            <View style={styles.row}>
              <View style={styles.glyph}>
                <StepGlyph status={step.status} />
              </View>
              <Text
                variant="body"
                style={
                  step.status === 'failed'
                    ? styles.failed
                    : step.status === 'pending'
                      ? styles.pending
                      : styles.label
                }
              >
                {step.label}
              </Text>
            </View>
            {step.status === 'failed' ? (
              <Text variant="meta" style={styles.failure}>
                {step.failure.message}
              </Text>
            ) : null}
            {step.id === 'poses' && step.status !== 'pending' ? (
              <View style={styles.poses}>
                <PetPoseGrid
                  opaqueBounds={null}
                  size={PLAN_POSE_PX}
                  status={poseStatus}
                  testID="hatch-pet.progress.poses"
                />
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </ToolSectionView>
  );
});

function StepGlyph(
  props: Readonly<{
    status: HatchPetProgressPlanV1['steps'][number]['status'];
  }>,
) {
  const { theme } = useUnistyles();
  switch (props.status) {
    case 'completed':
      return (
        <Icon
          name="check"
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />
      );
    case 'in_progress':
      return (
        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
      );
    case 'failed':
      return (
        <Icon
          name="x-circle"
          size={ICON_SIZE.xs}
          color={theme.colors.state.danger.foreground}
        />
      );
    case 'pending':
      return <View style={styles.dot} />;
  }
}

const styles = StyleSheet.create((theme) => ({
  plan: {
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
  },
  step: { gap: theme.space.s4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8 },
  // One body line high and one glyph wide: the glyph centres on the step's first line, and the text edge is fixed.
  glyph: {
    width: ICON_SIZE.xs,
    height: HAPPIER_TYPE_SCALE.body.lineHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: theme.space.s6,
    height: theme.space.s6,
    borderRadius: theme.space.s6,
    backgroundColor: theme.colors.text.tertiary,
    opacity: 0.4,
  },
  label: { color: theme.colors.text.primary, flexShrink: 1 },
  pending: { color: theme.colors.text.tertiary, flexShrink: 1 },
  failed: { color: theme.colors.state.danger.foreground, flexShrink: 1 },
  failure: {
    color: theme.colors.text.secondary,
    marginLeft: ICON_SIZE.xs + theme.space.s8,
  },
  // The poses start on the step text's edge.
  poses: {
    marginLeft: ICON_SIZE.xs + theme.space.s8,
    paddingTop: theme.space.s4,
  },
}));
