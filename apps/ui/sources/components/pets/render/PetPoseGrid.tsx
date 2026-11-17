import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ImageProps } from 'expo-image';
import type { PetCellBoundsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import {
  PET_ANIMATION_STATES_V1,
  PET_ATLAS_V1,
  type PetAnimationStateV1,
} from '@happier-dev/protocol/pets/constants';

import {
  resolvePetStatePlayback,
  type PetPoseOptions,
  type ResolvedPetAnimationFrame,
} from '@/components/pets/animation/resolvePetAnimationTimeline';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { PetSprite, type PetSpriteTrack } from './PetSprite';

/** Columns are the pet box plus this much room for the pose's label (DECISIONS-R12 §6). */
const POSE_LABEL_ROOM_PX = 64;
const POSE_ROWS = [
  PET_ANIMATION_STATES_V1.slice(0, 3),
  PET_ANIMATION_STATES_V1.slice(3, 6),
  PET_ANIMATION_STATES_V1.slice(6, 9),
] as const;

const POSE_LABEL_KEYS = {
  idle: 'settingsPets.store.pose.idle',
  'running-right': 'settingsPets.store.pose.runningRight',
  'running-left': 'settingsPets.store.pose.runningLeft',
  waving: 'settingsPets.store.pose.waving',
  jumping: 'settingsPets.store.pose.jumping',
  failed: 'settingsPets.store.pose.failed',
  waiting: 'settingsPets.store.pose.waiting',
  running: 'settingsPets.store.pose.running',
  review: 'settingsPets.store.pose.review',
} as const satisfies Record<PetAnimationStateV1, string>;

export function petPoseLabel(state: PetAnimationStateV1): string {
  return t(POSE_LABEL_KEYS[state]);
}

/** A pose being made (Hatch pet's progress): drawn plays its row, drawing shows a spinner, pending a quiet dot. */
export type PetPoseStatus = 'drawn' | 'drawing' | 'pending';

export type PetPoseGridProps = Readonly<{
  /** The sheet being shown; absent while a pet is still being made (its drawn poses then show a check). */
  spritesheetSource?: ImageProps['source'];
  opaqueBounds: PetCellBoundsV1 | null;
  spriteVersionNumber?: 1 | 2;
  /** The pet box of each cell: 40 in the listing and the progress plan, 56 (48 on a phone) in the preview card. */
  size: number;
  status?: (state: PetAnimationStateV1) => PetPoseStatus;
  testID?: string;
}>;

/**
 * Every pose of a pet (DECISIONS-R12 §6, round 3): one 3 × 3 grid of equal cells, each the pet box with its label under
 * it, left-aligned, used alike by the Store listing, the Session preview card and Hatch pet's progress. A drawn pose
 * plays its own row on the compositor while the app is viewed; Reduce motion keeps each on its still frame.
 */
export const PetPoseGrid = React.memo(function PetPoseGrid(
  props: PetPoseGridProps,
) {
  const reducedMotion = useReducedMotionPreference();
  const cellWidth = props.size + POSE_LABEL_ROOM_PX;
  return (
    <View
      style={styles.grid}
      testID={props.testID}
      accessibilityRole="list"
      accessibilityLabel={t('settingsPets.store.poses')}
    >
      {POSE_ROWS.map((row, index) => (
        // Rows of three, so the poses always break 3, 3, 3; a narrow column shrinks the label room, never the pet.
        <View key={index} style={styles.row}>
          {row.map((state) => (
            <PoseCell
              key={state}
              state={state}
              width={cellWidth}
              size={props.size}
              still={reducedMotion}
              status={props.status?.(state) ?? 'drawn'}
              spritesheetSource={props.spritesheetSource}
              opaqueBounds={props.opaqueBounds}
              spriteVersionNumber={props.spriteVersionNumber}
              testID={props.testID ? `${props.testID}:${state}` : undefined}
            />
          ))}
        </View>
      ))}
    </View>
  );
});

const PoseCell = React.memo(function PoseCell(
  props: Readonly<{
    state: PetAnimationStateV1;
    width: number;
    size: number;
    still: boolean;
    status: PetPoseStatus;
    spritesheetSource?: ImageProps['source'];
    opaqueBounds: PetCellBoundsV1 | null;
    spriteVersionNumber?: 1 | 2;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const frame = React.useMemo(
    () => petPoseStillFrame(props.state),
    [props.state],
  );
  const track = React.useMemo(
    () =>
      props.still || props.status !== 'drawn'
        ? null
        : petPoseLoopTrack(props.state),
    [props.still, props.status, props.state],
  );
  const label = petPoseLabel(props.state);
  return (
    <View
      style={[styles.cell, { width: props.width, minWidth: props.size }]}
      testID={props.testID}
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <View style={[styles.box, { width: props.size, height: props.size }]}>
        {props.status === 'drawn' && !props.spritesheetSource ? (
          <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
        ) : props.status === 'drawn' ? (
          <PetSprite
            frame={frame}
            spritesheetSource={props.spritesheetSource}
            spriteVersionNumber={props.spriteVersionNumber}
            fit={{ box: props.size, bounds: props.opaqueBounds }}
            track={track}
          />
        ) : props.status === 'drawing' ? (
          <ActivitySpinner size="small" color={theme.colors.text.tertiary} />
        ) : (
          <View style={styles.dot} />
        )}
      </View>
      <Text
        variant="meta"
        numberOfLines={1}
        style={props.status === 'drawn' ? styles.label : styles.labelQuiet}
      >
        {label}
      </Text>
    </View>
  );
});

/** The pose's resting frame, from the pose owner (a v2 face's look cell when `pose` names a direction). */
export function petPoseStillFrame(
  state: PetAnimationStateV1,
  pose?: PetPoseOptions,
): ResolvedPetAnimationFrame {
  const playback = resolvePetStatePlayback(state, pose);
  return {
    state,
    row: playback.row,
    frame: playback.stillFrame,
    cellWidth: PET_ATLAS_V1.cellWidth,
    cellHeight: PET_ATLAS_V1.cellHeight,
  };
}

/**
 * The pose's whole row as a stepped track, from the pose owner's frames and durations: endless by default (a Bot face
 * phases it by its seed), or a finite one-shot that hands back to the still frame and calls `onFinish`.
 */
export function petPoseLoopTrack(
  state: PetAnimationStateV1,
  options: Readonly<{ iterations?: number; phaseOffsetMs?: number; onFinish?: () => void }> = {},
): PetSpriteTrack {
  const playback = resolvePetStatePlayback(state);
  const at: number[] = [];
  let periodMs = 0;
  for (const frame of playback.frames) {
    at.push(periodMs);
    periodMs += frame.durationMs;
  }
  return {
    steps: { periodMs, at, iterations: options.iterations ?? Infinity, phaseOffsetMs: options.phaseOffsetMs ?? 0 },
    cells: playback.frames.map((frame) => ({
      row: playback.row,
      frame: frame.frame,
    })),
    onFinish: options.onFinish,
  };
}

const styles = StyleSheet.create((theme) => ({
  grid: {
    rowGap: theme.space.s8,
  },
  row: {
    flexDirection: 'row',
    columnGap: theme.space.s12,
  },
  cell: {
    flexShrink: 1,
    gap: theme.space.s4,
    alignItems: 'flex-start',
  },
  box: {
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
  label: { color: theme.colors.text.secondary },
  labelQuiet: { color: theme.colors.text.tertiary },
}));
