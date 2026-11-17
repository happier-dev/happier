import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { ImageProps } from 'expo-image';
import type { BotMotion } from '@happier-dev/protocol/account/settings/accountSettings';
import type { PetCellBoundsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import type { PetAnimationStateV1 } from '@happier-dev/protocol/pets/constants';

import { petFacePose } from '@/components/pets/activity/petActivityPose';
import {
  resolvePetStatePlayback,
  type PetLookDirection,
} from '@/components/pets/animation/resolvePetAnimationTimeline';
import {
  petPoseLoopTrack,
  petPoseStillFrame,
} from '@/components/pets/render/PetPoseGrid';
import {
  PetSprite,
  type PetSpriteTrack,
} from '@/components/pets/render/PetSprite';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { readHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import type { BotFaceMood } from './botFaceGeometry';
import {
  botFaceSeedOffsetMs,
  registerBotFaceBrain,
  type BotFacePointDirection,
} from './botFaceIdle';
import { botFaceMotionTokens } from './botFaceMotionTokens';
import { useBotFaceMotionEligibility } from './useBotFaceMotionEligibility';

/** From this size a face is a hero and moves on any surface (`BotFace`'s `BOT_FACE_HERO_MIN_SIZE`). */
const HERO_MIN_SIZE = 48;

export type BotFacePetProps = Readonly<{
  spritesheetSource: ImageProps['source'];
  /** The pet's opaque bounds over every used cell; without them the whole cell is fitted, which never crops. */
  opaqueBounds: PetCellBoundsV1 | null;
  /** The delivered sheet's atlas (v2 adds the look rows); 1 when unknown. */
  spriteVersionNumber?: 1 | 2;
  /** A v2 sheet that draws its look-at-you cell; without it the pet looks at you from idle frame 0 (R12 §12). */
  hasNeutralLookCell?: boolean;
  size: number;
  mood: BotFaceMood;
  /** The Bot's seed: loops of different Bots never step together, and idle gestures keep their own cadence. */
  seed: number;
  /** As for `BotFace`: rail and roster life (`true`), ordinary rows (`'interaction'`), or still. */
  motion?: boolean | 'interaction';
  motionMode: BotMotion;
  visible?: boolean;
  monochrome?: boolean;
  marker?: React.ReactNode;
  /** The pet arrived after the face mounted (DECISIONS-R11 §17): it fades into its reserved box once. */
  fadeIn?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}>;

/**
 * A Bot's face drawn as its pet (lab R11): the whole pet in the face's square box, trimmed to its opaque bounds, moving
 * with the R10 face system. Each Bot state shows its pose's frames from the pose owner; Lively loops working and
 * needs-you on the compositor; facts, a hop under the pointer and the occasional idle row play once; a resting v2 pet
 * looks toward the pointer (R12); Still, Reduce motion, offscreen and hidden faces rest on the state's still frame.
 */
export const BotFacePet = React.memo(function BotFacePet(
  props: BotFacePetProps,
) {
  const [fadeIn] = React.useState(props.fadeIn === true);
  const moving =
    props.motion === true ||
    props.motion === 'interaction' ||
    props.size >= HERO_MIN_SIZE;
  const face = moving ? (
    <BotFacePetAlive {...props} />
  ) : (
    <PetFaceSprite {...props} look={null} track={null} />
  );
  return (
    <View
      testID={props.testID}
      accessible={Boolean(props.accessibilityLabel)}
      accessibilityRole={props.accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={props.accessibilityLabel}
      style={{ width: props.size, height: props.size }}
    >
      {fadeIn ? <PetFaceFadeIn>{face}</PetFaceFadeIn> : face}
    </View>
  );
});

function PetFaceSprite(
  props: BotFacePetProps &
    Readonly<{ look: PetLookDirection | null; track: PetSpriteTrack | null }>,
) {
  const state = petFacePose[props.mood];
  const { look, spriteVersionNumber, hasNeutralLookCell } = props;
  const frame = React.useMemo(
    () =>
      petPoseStillFrame(
        state,
        look === null
          ? undefined
          : { spriteVersionNumber, lookDirection: look, hasNeutralLookCell },
      ),
    [state, look, spriteVersionNumber, hasNeutralLookCell],
  );
  return (
    <PetSprite
      testID="bot-face-pet"
      frame={frame}
      spritesheetSource={props.spritesheetSource}
      spriteVersionNumber={spriteVersionNumber}
      fit={{ box: props.size, bounds: props.opaqueBounds }}
      track={props.track}
      monochrome={props.monochrome}
    />
  );
}

type OneShot = Readonly<{ state: PetAnimationStateV1; startedAt: number }>;

function BotFacePetAlive(props: BotFacePetProps) {
  const mode = props.motionMode;
  const { ref, measure, eligible } = useBotFaceMotionEligibility(
    props.visible !== false,
    mode,
  );
  // Rails, rosters and heroes take every reaction; ordinary rows only loop their state and hop under the pointer.
  const reacts = props.motion === true || props.size >= HERO_MIN_SIZE;
  const state = petFacePose[props.mood];
  const [oneShot, setOneShot] = React.useState<OneShot | null>(null);
  const live = React.useRef({ eligible, playing: false, lastHopAt: -Infinity });
  live.current.eligible = eligible;
  live.current.playing = eligible && oneShot !== null;
  const play = React.useCallback(
    (next: PetAnimationStateV1) =>
      setOneShot({ state: next, startedAt: Date.now() }),
    [],
  );
  const finish = React.useCallback(() => setOneShot(null), []);
  // Leaving eligibility (offscreen, Still, Reduce motion) ends a one-shot: the face rests on its state's still frame.
  React.useEffect(() => {
    if (!eligible) setOneShot(null);
  }, [eligible]);

  // A fact plays its pose once (Done waves, Failed falls); Reactions only plays working and needs-you once too.
  const seenMood = React.useRef(props.mood);
  React.useEffect(() => {
    if (seenMood.current === props.mood) return;
    seenMood.current = props.mood;
    const playback = resolvePetStatePlayback(state);
    const once =
      state !== 'idle' && (playback.repeat === 'once' || mode === 'reactions');
    if (reacts && live.current.eligible && once && readHostActivelyViewed())
      play(state);
    else setOneShot(null);
    // Only a change of state is a fact; mode and eligibility changes settle through the track below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mood]);

  // The R10 clock: a resting Lively pet plays its idle row now and then (`onGesture`), and a resting v2 pet looks
  // toward the pointer (`onPoint`, R12 §11). One registration, no clock or listener of its own.
  const lively = eligible && mode === 'lively';
  const gestures = reacts && lively && state === 'idle';
  const looks =
    lively &&
    props.spriteVersionNumber === 2 &&
    (props.mood === 'quiet' || props.mood === 'done');
  const [look, setLook] = React.useState<PetLookDirection | null>(null);
  React.useEffect(() => {
    if (!gestures && !looks) return;
    const handle = registerBotFaceBrain({
      seed: props.seed,
      mode: 'lively',
      turns: 'none',
      mood: props.mood === 'done' ? 'done' : 'quiet',
      onLook: () => {},
      onGesture: () => {
        if (gestures && !live.current.playing) play('idle');
      },
      ...(looks
        ? {
            size: props.size,
            onPoint: (direction: BotFacePointDirection | null) =>
              setLook(direction as PetLookDirection | null),
            locate: () => {
              const box = (
                ref.current as unknown as {
                  getBoundingClientRect?: () => DOMRect;
                } | null
              )?.getBoundingClientRect?.();
              return box
                ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
                : null;
            },
          }
        : {}),
    });
    return () => {
      handle.release();
      setLook(null);
    };
  }, [gestures, looks, props.seed, props.mood, props.size, play, ref]);

  // The hop: the face's own hit box only (a pass down a list never ripples), never during another one-shot.
  const hovered = React.useRef(false);
  const hop = React.useCallback(
    (
      event: Readonly<{ nativeEvent?: { pointerType?: string } }>,
      pressIn: boolean,
    ) => {
      if ((event.nativeEvent?.pointerType === 'touch') !== pressIn) return;
      if (!pressIn) {
        if (hovered.current) return;
        hovered.current = true;
      }
      const now = Date.now();
      const current = live.current;
      if (
        !current.eligible ||
        current.playing ||
        now - current.lastHopAt < botFaceMotionTokens.pet.hopRefractoryMs
      )
        return;
      current.lastHopAt = now;
      play('jumping');
    },
    [play],
  );

  const looping = lively && resolvePetStatePlayback(state).repeat === 'loop';
  const shot = eligible ? oneShot : null;
  const phaseOffsetMs = botFaceSeedOffsetMs(props.seed);
  const track = React.useMemo(
    () =>
      shot
        ? petPoseLoopTrack(shot.state, { iterations: 1, onFinish: finish })
        : looping
          ? petPoseLoopTrack(state, { phaseOffsetMs })
          : null,
    [shot, looping, state, phaseOffsetMs, finish],
  );
  return (
    <>
      <View
        ref={ref}
        collapsable={false}
        onLayout={measure}
        onPointerEnter={(event) => hop(event, false)}
        onPointerLeave={() => {
          hovered.current = false;
        }}
        onPointerDown={(event) => hop(event, true)}
      >
        {/* A hop or an idle row plays over the look; the look cell is what it hands back to. */}
        <PetFaceSprite {...props} look={looks ? look : null} track={track} />
      </View>
      {props.marker ? (
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
          {props.marker}
        </View>
      ) : null}
    </>
  );
}

/** A pet that arrives after its box was reserved fades in once; Reduce motion shows it at once. */
function PetFaceFadeIn(props: Readonly<{ children: React.ReactNode }>) {
  const reduced = useReducedMotionPreference();
  const opacity = useSharedValue(reduced ? 1 : 0);
  React.useEffect(() => {
    opacity.set(
      withTiming(1, { duration: botFaceMotionTokens.stillCrossFadeMs }),
    );
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={style}>{props.children}</Animated.View>;
}
