import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming } from 'react-native-reanimated';
import type { BotMotion } from '@happier-dev/protocol/account/settings/accountSettings';

import { createSessionFinishedRippleObserver } from '@/components/atmosphere/sessionFinishedRippleObserver';

import type { BotFaceMood } from './botFaceGeometry';
import type { BotFaceMutter } from './botFaceGeometry';
import { BOT_FACE_LOOK_REST, registerBotFaceBrain, type BotFaceBrainHandle, type BotFaceLook, type BotFaceTurnKind } from './botFaceIdle';
import { BOT_FACE_REST, botFaceMoment, botFaceMotionChannels, botFaceMomentMs, botFaceMotionPose, botFaceMotionTokens, botFaceMouthLayers, botFacePixelLook, botFaceSmileSlide, type BotFaceChannels, type BotFaceReaction } from './botFaceMotionTokens';
import type { BotFaceTurn } from './botFaceRaster';
import { useBotFaceMotionEligibility } from './useBotFaceMotionEligibility';

/** A moment drawn as a pose (Dither, Solid): the R7 channels and how far the mouth has morphed `from` → `to`. */
export type BotFaceMotionMoment = Readonly<{ channels: BotFaceChannels; from: BotFaceMood; to: BotFaceMood; u: number }>;
/**
 * What the face draws besides a moment's pose. R8 direction C's turn for the styles that do not redraw a pose: Pixel's
 * face rows `look` one sprite pixel toward it, and Dots' smile layer slides against the body by `smile` (an animated
 * transform, present only while the face is turned). R10 A's brain adds `turn` (Dither and Solid redraw the turned body)
 * and R9's `mutter` (the working "…" mouth's raised dot, Lively only).
 */
export type BotFaceMotionLayers = Readonly<{
  look: -1 | 0 | 1;
  smile: ReturnType<typeof useAnimatedStyle<ViewStyle>> | null;
  turn: BotFaceTurn | null;
  mutter: BotFaceMutter | null;
}>;
const STILL_LAYERS: BotFaceMotionLayers = { look: 0, smile: null, turn: null, mutter: null };
type PoseKey = Readonly<{ channels: BotFaceChannels; u: number }>;
/**
 * The drawing changes only when a channel moves by a visible amount: `grain` css px at the face's `size` (a third of a
 * Dither cell, one Solid device pixel). A lift or shift moves the body by `grain`; a stretch moves its top (about 0.8 of
 * the face) by it; a lean moves its edge (half the face) by it. A moment therefore redraws once per visible step and
 * replays the same poses each time it plays, so its drawings are reused (R7/R8: cache pose rasters per state).
 */
function poseKey(channels: BotFaceChannels, u: number, size: number, grain: number): PoseKey {
  'worklet';
  const q = (v: number, step: number) => Math.round(v / step) * step + 0; // + 0 folds -0 into 0
  const move = grain / size, stretch = grain / (0.8 * size), lean = (grain / (0.5 * size)) * (180 / Math.PI);
  return { channels: { tx: q(channels.tx, move), ty: q(channels.ty, move), sx: 1 + q(channels.sx - 1, stretch), sy: 1 + q(channels.sy - 1, stretch), rot: q(channels.rot, lean) }, u: q(u, 0.2) };
}
function sameKey(a: PoseKey | null, b: PoseKey): boolean {
  'worklet';
  return !!a && a.u === b.u && a.channels.tx === b.channels.tx && a.channels.ty === b.channels.ty
    && a.channels.sx === b.channels.sx && a.channels.sy === b.channels.sy && a.channels.rot === b.channels.rot;
}

/**
 * Playback is local to the drawing leaf. Its children paint only when their real drawing inputs change: during a posed
 * moment (`posed`, Dither and Solid) once per visible change of the pose, and between facts once per quantised step of
 * its brain (a turn bucket or a mutter step, from the shared attention clock in `botFaceIdle`). Other faces move as their
 * cached drawing; `step` (css px) keeps a stepping face (Pixel's moves) on its own grid.
 */
export function BotFaceMotion(props: Readonly<{
  mood: BotFaceMood;
  mode: BotMotion;
  visible: boolean;
  size: number;
  /** Ordinary rows borrow only the finite pointer perk; no automatic reactions, brain or mutter. */
  interactionOnly?: boolean;
  /** Moments redraw the body at each pose (R7 Dither and Solid) instead of moving the cached drawing. */
  posed?: boolean;
  /** A posed drawing's smallest visible change, css px (pose quantisation). */
  grain?: number;
  /** Moves without a pose step in whole units of the drawing's grid (Pixel). */
  step?: number;
  /** Pixel: every move steps, never stretches or tilts. */
  stepMoments?: boolean;
  /** Pixel: its face rows look toward the moment's turn (at most three redraws per moment). */
  look?: boolean;
  /** Dots: the smile slides against the body with the moment's turn. */
  slide?: boolean;
  /** How this style shows the brain's turn (R10 A). */
  turns: BotFaceTurnKind;
  identity?: number;
  marker?: React.ReactNode;
  completedAt?: number | null;
  failedAt?: number | null;
  children: (mouth: BotFaceMood, moment: BotFaceMotionMoment | null, layers: BotFaceMotionLayers) => React.ReactNode;
}>) {
  const { ref, id, measure, presented, eligible } = useBotFaceMotionEligibility(props.visible, props.mode);
  const activityEligible = eligible && !props.interactionOnly;
  const reaction = useSharedValue<BotFaceReaction | null>(null);
  const elapsed = useSharedValue(0);
  const from = useSharedValue(BOT_FACE_REST);
  const currentPose = useSharedValue(BOT_FACE_REST);
  const restingFade = useSharedValue(1);
  const [playing, setPlaying] = React.useState(false);
  const posed = props.posed === true;
  const faceSize = props.size;
  const grain = props.grain ?? 0.004 * props.size;
  const [pose, setPose] = React.useState<PoseKey | null>(null);
  const lastPose = useSharedValue<PoseKey | null>(null);
  const looks = props.look === true;
  const [look, setLook] = React.useState<-1 | 0 | 1>(0);
  const lastLook = useSharedValue<-1 | 0 | 1>(0);
  const latest = React.useRef<{ eligible: boolean; start: (kind: BotFaceReaction) => void }>({ eligible, start: () => {} });
  const [mouths, setMouths] = React.useState({ from: props.mood, to: props.mood });
  const restingMouth = React.useRef(props.mood);
  restingMouth.current = props.mood;
  const displayedMouth = React.useRef(props.mood);
  const frameRef = React.useRef<ReturnType<typeof useFrameCallback> | null>(null);
  const [brainLook, setBrainLook] = React.useState<BotFaceLook>(BOT_FACE_LOOK_REST);
  const brainSlide = useSharedValue({ x: 0, y: 0 });
  const finish = React.useCallback(() => {
    setPlaying(false);
    setPose(null);
    setLook(0);
    displayedMouth.current = restingMouth.current;
    setMouths({ from: restingMouth.current, to: restingMouth.current });
    frameRef.current?.setActive(false);
  }, []);
  const frame = useFrameCallback(info => {
    'worklet';
    const kind = reaction.get();
    elapsed.set(elapsed.get() + (info.timeSincePreviousFrame ?? 16));
    currentPose.set(botFaceMotionChannels(kind, elapsed.get(), from.get()));
    if (posed && kind && elapsed.get() < botFaceMomentMs(kind)) {
      const key = poseKey(currentPose.get(), botFaceMouthLayers(kind, elapsed.get(), 1).incoming, faceSize, grain);
      if (!sameKey(lastPose.get(), key)) { lastPose.set(key); runOnJS(setPose)(key); }
    }
    if (looks && kind && elapsed.get() < botFaceMomentMs(kind)) {
      const next = botFacePixelLook(currentPose.get());
      if (next !== lastLook.get()) { lastLook.set(next); runOnJS(setLook)(next); }
    }
    if (kind && elapsed.get() >= botFaceMomentMs(kind)) {
      lastPose.set(null);
      lastLook.set(0);
      // A moment that hands its mouth back keeps showing the resting layer until React drops the borrowed one.
      if (botFaceMoment(kind).mouthBackAtMs !== undefined) restingFade.set(0);
      reaction.set(null);
      elapsed.set(0);
      currentPose.set(BOT_FACE_REST);
      runOnJS(finish)();
    }
  }, false);
  frameRef.current = frame;
  const start = React.useCallback((kind: BotFaceReaction) => {
    from.set(currentPose.get());
    reaction.set(kind);
    elapsed.set(0);
    const mouth = kind === 'smile' || kind === 'perk' ? 'done'
      : kind === 'working' || kind === 'needsYou' || kind === 'done' || kind === 'failed' ? kind : restingMouth.current;
    setMouths({ from: displayedMouth.current, to: mouth });
    displayedMouth.current = mouth;
    setPlaying(true);
    frame.setActive(true);
  }, [currentPose, elapsed, frame, from, reaction]);
  latest.current = { eligible, start };
  React.useEffect(() => {
    if (!eligible) {
      reaction.set(null);
      elapsed.set(0);
      currentPose.set(BOT_FACE_REST);
      lastPose.set(null);
      setPose(null);
      lastLook.set(0);
      setLook(0);
      setPlaying(false);
      displayedMouth.current = restingMouth.current;
      setMouths({ from: restingMouth.current, to: restingMouth.current });
      if (!presented) restingFade.set(1);
    }
    frame.setActive(eligible && playing);
    return () => frame.setActive(false);
  }, [currentPose, elapsed, eligible, frame, lastLook, lastPose, playing, presented, reaction, restingFade]);
  /**
   * Hover perk: a mouse or pen hover-in, or a touch press-in; a fact's reaction keeps playing. The browser re-sends
   * enter without a leave when the mouth layers swap under a resting pointer, so only an enter after a leave counts.
   */
  const hovered = React.useRef(false);
  const perk = React.useCallback((event: Readonly<{ nativeEvent?: { pointerType?: string } }>, pressIn: boolean) => {
    if ((event.nativeEvent?.pointerType === 'touch') !== pressIn) return;
    if (!pressIn) {
      if (hovered.current) return;
      hovered.current = true;
    }
    if (!latest.current.eligible) return;
    const playing = reaction.get();
    if (playing === 'working' || playing === 'needsYou' || playing === 'done' || playing === 'failed') return;
    latest.current.start('perk');
  }, [reaction]);
  const previousMood = React.useRef(props.mood);

  const observe = React.useMemo(() => createSessionFinishedRippleObserver(
    () => {},
    () => latest.current.start('done'),
    () => latest.current.start('failed'),
  ), []);
  React.useEffect(() => {
    const changed = previousMood.current !== props.mood;
    previousMood.current = props.mood;
    if (activityEligible && changed && (props.mood === 'working' || props.mood === 'needsYou'
      || (props.mood === 'failed' && props.failedAt == null))) start(props.mood);
    // Keep learning while hidden, Still or reduced, so a missed finish is never replayed.
    observe({ enabled: true, visible: activityEligible, states: new Map([[id, {
      lastTurnCompletedAt: props.completedAt ?? null,
      failedAt: props.failedAt,
      pendingApproval: props.mood === 'needsYou',
    }]]) });
    if (reaction.get() === null) {
      const before = displayedMouth.current;
      displayedMouth.current = props.mood;
      setMouths({ from: before, to: props.mood });
      const fade = presented && before !== props.mood;
      restingFade.set(fade ? 0 : 1);
      if (fade) restingFade.set(withTiming(1, { duration: botFaceMotionTokens.stillCrossFadeMs }));
    }
  }, [activityEligible, id, observe, presented, props.completedAt, props.failedAt, props.mood, reaction, restingFade, start]);
  /**
   * R10 A: an eligible Lively or Reactions-only face registers its brain with the shared attention clock while it is
   * visible; leaving eligibility releases it and the face rests at its list pose. The brain reads the mood through
   * `setMood`, so a state change keeps its springs (no jump back to centre).
   */
  const brain = React.useRef<BotFaceBrainHandle | null>(null);
  const brainMode = activityEligible && (props.mode === 'lively' || props.mode === 'reactions') ? props.mode : null;
  const turns = props.turns;
  const seed = props.identity ?? 0;
  React.useEffect(() => {
    if (!brainMode) return;
    const handle = registerBotFaceBrain({
      seed, mode: brainMode, turns, mood: restingMouth.current,
      onLook: setBrainLook,
      onGesture: gesture => { if (reaction.get() === null) latest.current.start(gesture); },
      locate: () => {
        const node = ref.current as unknown as { getBoundingClientRect?: () => DOMRect } | null;
        const box = node?.getBoundingClientRect?.();
        return box ? { x: box.left + box.width / 2, y: box.top + box.height * 0.45 } : null;
      },
    });
    brain.current = handle;
    // Keyboard focus on the Bot's pin or row (web and desktop): the perk, then it looks at you while focused. The DOM is
    // the platform boundary; the focusable host is the nearest pressable around the face.
    type FocusHost = { addEventListener: (type: string, fn: () => void) => void; removeEventListener: (type: string, fn: () => void) => void; matches?: (selector: string) => boolean };
    const node = ref.current as unknown as { closest?: (selector: string) => FocusHost | null } | null;
    const host = node?.closest?.('button,[role="button"],[role="menuitem"],[role="link"],a[href],[tabindex]') ?? null;
    const onFocus = () => {
      if (host?.matches?.(':focus-visible') === false) return; // a click's focus is not keyboard focus
      handle.setFocused(true);
      const playing = reaction.get();
      if (latest.current.eligible && playing !== 'working' && playing !== 'needsYou' && playing !== 'done' && playing !== 'failed') latest.current.start('perk');
    };
    const onBlur = () => handle.setFocused(false);
    host?.addEventListener('focus', onFocus);
    host?.addEventListener('blur', onBlur);
    return () => {
      host?.removeEventListener('focus', onFocus);
      host?.removeEventListener('blur', onBlur);
      handle.release();
      brain.current = null;
      setBrainLook(BOT_FACE_LOOK_REST);
    };
  }, [brainMode, reaction, seed, turns]);
  const seenMood = React.useRef(props.mood);
  React.useEffect(() => {
    const fact = seenMood.current !== props.mood;
    seenMood.current = props.mood;
    brain.current?.setMood(props.mood, fact);
  }, [props.mood]);
  const slideX = turns === 'slide' ? brainLook.yaw * 2.6 : 0, slideY = turns === 'slide' ? brainLook.pitch * 2.6 : 0;
  React.useEffect(() => { brainSlide.set({ x: slideX, y: slideY }); }, [brainSlide, slideX, slideY]);
  const size = props.size;
  const step = props.step;
  const stepMoments = props.stepMoments === true;
  const style = useAnimatedStyle(() => {
    const kind = reaction.get();
    // A posed moment is drawn by the face itself; the leaf only moves a drawing at rest or for the other styles.
    if (posed && kind) return { transformOrigin: '50% 90%', transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: '0deg' }, { scaleX: 1 }, { scaleY: 1 }] };
    const stepped = step !== undefined && (stepMoments || !kind);
    const pose = botFaceMotionPose(kind, elapsed.get(), size, from.get(), stepped, step ?? 1);
    return { transformOrigin: '50% 90%', transform: [{ translateX: pose.x }, { translateY: pose.y }, { rotate: `${pose.rotation}deg` }, { scaleX: pose.sx }, { scaleY: pose.sy }] };
  });
  // The incoming mouth fades over the outgoing face, which stays opaque underneath. Each updater reads its shared
  // values itself: Reanimated subscribes a style only to the values in its own closure.
  const newMouthStyle = useAnimatedStyle(() => ({ opacity: botFaceMouthLayers(reaction.get(), elapsed.get(), restingFade.get()).incoming }));
  const smileStyle = useAnimatedStyle<ViewStyle>(() => {
    const slide = reaction.get() ? botFaceSmileSlide(currentPose.get()) : { x: 0, y: 0 };
    const turned = brainSlide.get();
    return { transform: [{ translateX: slide.x + turned.x }, { translateY: slide.y + turned.y }] };
  });
  const turned = brainLook.yaw !== 0 || brainLook.pitch !== 0 || brainLook.roll !== 0;
  const sliding = props.slide === true && (playing || turned);
  const shownLook = look !== 0 ? look : turns === 'look' ? (brainLook.yaw as -1 | 0 | 1) : 0;
  const turn = turns === 'full' && turned ? brainLook : null;
  const turnKey = turn ? `${turn.yaw}|${turn.pitch}|${turn.roll}` : '';
  const layers = React.useMemo<BotFaceMotionLayers>(() => (shownLook === 0 && !sliding && !turnKey && brainLook.mutter === null ? STILL_LAYERS
    : { look: shownLook, smile: sliding ? smileStyle : null, turn: turnKey ? { yaw: brainLook.yaw, pitch: brainLook.pitch, roll: brainLook.roll } : null, mutter: brainLook.mutter }),
  // The turn is keyed by its quantised value, so an equal look keeps the same layers object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [shownLook, sliding, smileStyle, turnKey, brainLook.mutter]);
  const markerStyle = useAnimatedStyle(() => {
    const kind = reaction.get();
    return { opacity: kind && elapsed.get() < (botFaceMoment(kind).markerAtMs ?? 0) ? 0 : 1 };
  });
  return <>
    <Animated.View ref={ref} collapsable={false} onLayout={measure} style={style}
      onPointerEnter={event => perk(event, false)} onPointerLeave={() => { hovered.current = false; }}
      onPointerDown={event => perk(event, true)}>
    {pose ? props.children(mouths.to, { channels: pose.channels, from: mouths.from, to: mouths.to, u: pose.u }, layers)
      : mouths.from === mouths.to ? props.children(mouths.to, null, layers) : <>
      <View style={{ position: 'absolute' }}>{props.children(mouths.from, null, layers)}</View>
      <Animated.View style={newMouthStyle}>{props.children(mouths.to, null, layers)}</Animated.View>
    </>}
    </Animated.View>
    {props.marker ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', inset: 0 }, markerStyle]}>{props.marker}</Animated.View> : null}
  </>;
}
