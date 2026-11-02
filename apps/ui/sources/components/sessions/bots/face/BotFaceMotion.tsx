import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming } from 'react-native-reanimated';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import type { BotMotion } from '@happier-dev/protocol/account/settings/accountSettings';

import { createSessionFinishedRippleObserver } from '@/components/atmosphere/sessionFinishedRippleObserver';
import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import type { BotFaceMood } from './botFaceGeometry';
import { noteBotFaceReaction, registerRestingBotFace } from './botFaceIdle';
import { BOT_FACE_REST, botFaceMoment, botFaceMotionChannels, botFaceMomentMs, botFaceMotionPose, botFaceMotionTokens, botFaceMouthLayers, botFacePixelLook, botFaceSmileSlide, type BotFaceChannels, type BotFaceReaction } from './botFaceMotionTokens';

/** A moment drawn as a pose (Dither, Solid): the R7 channels and how far the mouth has morphed `from` → `to`. */
export type BotFaceMotionMoment = Readonly<{ channels: BotFaceChannels; from: BotFaceMood; to: BotFaceMood; u: number }>;
/**
 * R8 direction C's turn for the styles that do not redraw a pose: Pixel's face rows `look` one sprite pixel toward it,
 * and Dots' smile layer slides against the body by `smile` (an animated transform, present only while a moment plays).
 */
export type BotFaceMotionLayers = Readonly<{ look: -1 | 0 | 1; smile: ReturnType<typeof useAnimatedStyle<ViewStyle>> | null }>;
const STILL_LAYERS: BotFaceMotionLayers = { look: 0, smile: null };
type PoseKey = Readonly<{ channels: BotFaceChannels; u: number }>;
/** The drawing changes only when a channel moves by a visible amount, so a moment repaints far fewer times than it has frames. */
function poseKey(channels: BotFaceChannels, u: number): PoseKey {
  'worklet';
  const q = (v: number, step: number) => Math.round(v / step) * step;
  return { channels: { tx: q(channels.tx, 0.004), ty: q(channels.ty, 0.004), sx: q(channels.sx, 0.004), sy: q(channels.sy, 0.004), rot: q(channels.rot, 0.25) }, u: q(u, 0.1) };
}
function sameKey(a: PoseKey | null, b: PoseKey): boolean {
  'worklet';
  return !!a && a.u === b.u && a.channels.tx === b.channels.tx && a.channels.ty === b.channels.ty
    && a.channels.sx === b.channels.sx && a.channels.sy === b.channels.sy && a.channels.rot === b.channels.rot;
}

/**
 * Playback is local to the drawing leaf. Its children paint only when their real drawing inputs change: at rest never,
 * and during a posed moment (`posed`, Dither and Solid) once per visible change of the pose. Other faces move as their
 * cached drawing; `step` (css px) keeps a stepping face (Pixel's moves, Dither's breath) on its own grid.
 */
export function BotFaceMotion(props: Readonly<{
  mood: BotFaceMood;
  mode: BotMotion;
  visible: boolean;
  size: number;
  /** Moments redraw the body at each pose (R7 Dither and Solid) instead of moving the cached drawing. */
  posed?: boolean;
  /** Moves without a pose step in whole units of the drawing's grid: always for Pixel, the breath for Dither. */
  step?: number;
  /** Pixel: every move steps, never stretches or tilts. Otherwise only the breath steps. */
  stepMoments?: boolean;
  /** Pixel: its face rows look toward the moment's turn (at most three redraws per moment). */
  look?: boolean;
  /** Dots: the smile slides against the body with the moment's turn. */
  slide?: boolean;
  identity?: number;
  marker?: React.ReactNode;
  completedAt?: number | null;
  failedAt?: number | null;
  children: (mouth: BotFaceMood, moment: BotFaceMotionMoment | null, layers: BotFaceMotionLayers) => React.ReactNode;
}>) {
  const reduced = useReducedMotionPreference();
  const viewed = useHostActivelyViewed();
  const tracker = useOptionalPluginUiScrollActivityTracker();
  const ref = React.useRef<View>(null);
  const id = React.useId();
  const { near, measure } = useMeasuredNearViewport(tracker, ref, props.visible, id);
  const eligible = props.visible && viewed && near && !reduced && props.mode !== 'still';
  const breathing = eligible && props.mode === 'lively' && props.mood === 'working';
  const breath = useSharedValue(breathing);
  const reaction = useSharedValue<BotFaceReaction | null>(null);
  const elapsed = useSharedValue(0);
  const from = useSharedValue(BOT_FACE_REST);
  const currentPose = useSharedValue(BOT_FACE_REST);
  const restingFade = useSharedValue(1);
  const [playing, setPlaying] = React.useState(false);
  const posed = props.posed === true;
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
  const keepBreathing = React.useRef(breathing);
  keepBreathing.current = breathing;
  const finish = React.useCallback(() => {
    setPlaying(false);
    setPose(null);
    setLook(0);
    displayedMouth.current = restingMouth.current;
    setMouths({ from: restingMouth.current, to: restingMouth.current });
    if (!keepBreathing.current) frameRef.current?.setActive(false);
  }, []);
  const frame = useFrameCallback(info => {
    'worklet';
    const kind = reaction.get();
    elapsed.set(elapsed.get() + (info.timeSincePreviousFrame ?? 16));
    currentPose.set(botFaceMotionChannels(kind, elapsed.get(), breath.get(), from.get()));
    if (posed && kind && elapsed.get() < botFaceMomentMs(kind)) {
      const key = poseKey(currentPose.get(), botFaceMouthLayers(kind, elapsed.get(), 1).incoming);
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
    if (kind === 'working' || kind === 'needsYou' || kind === 'done' || kind === 'failed') noteBotFaceReaction();
  }, [currentPose, elapsed, frame, from, reaction]);
  latest.current = { eligible, start };
  React.useEffect(() => {
    breath.set(breathing);
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
      if (!props.visible || !viewed || !near) restingFade.set(1);
    }
    frame.setActive(eligible && (breathing || playing));
    return () => frame.setActive(false);
  }, [breath, breathing, currentPose, elapsed, eligible, frame, lastLook, lastPose, near, playing, props.visible, reaction, restingFade, viewed]);
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
    if (eligible && changed && (props.mood === 'working' || props.mood === 'needsYou'
      || (props.mood === 'failed' && props.failedAt == null))) start(props.mood);
    // Keep learning while hidden, Still or reduced, so a missed finish is never replayed.
    observe({ enabled: true, visible: eligible, states: new Map([[id, {
      lastTurnCompletedAt: props.completedAt ?? null,
      failedAt: props.failedAt,
      pendingApproval: props.mood === 'needsYou',
    }]]) });
    if (reaction.get() === null) {
      const before = displayedMouth.current;
      displayedMouth.current = props.mood;
      setMouths({ from: before, to: props.mood });
      const fade = props.visible && viewed && near && before !== props.mood;
      restingFade.set(fade ? 0 : 1);
      if (fade) restingFade.set(withTiming(1, { duration: botFaceMotionTokens.stillCrossFadeMs }));
    }
  }, [eligible, id, near, observe, props.completedAt, props.failedAt, props.mood, props.visible, reaction, restingFade, start, viewed]);
  React.useEffect(() => {
    if (!eligible || props.mode !== 'lively' || props.mood !== 'quiet') return;
    return registerRestingBotFace(gesture => start(gesture), props.identity ?? id);
  }, [eligible, id, props.identity, props.mode, props.mood, start]);
  const size = props.size;
  const step = props.step;
  const stepMoments = props.stepMoments === true;
  const style = useAnimatedStyle(() => {
    const kind = reaction.get();
    // A posed moment is drawn by the face itself; the leaf only moves a drawing at rest or for the other styles.
    if (posed && kind) return { transformOrigin: '50% 90%', transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: '0deg' }, { scaleX: 1 }, { scaleY: 1 }] };
    const stepped = step !== undefined && (stepMoments || !kind);
    const pose = botFaceMotionPose(kind, elapsed.get(), size, breath.get(), from.get(), stepped, step ?? 1);
    return { transformOrigin: '50% 90%', transform: [{ translateX: pose.x }, { translateY: pose.y }, { rotate: `${pose.rotation}deg` }, { scaleX: pose.sx }, { scaleY: pose.sy }] };
  });
  // The incoming mouth fades over the outgoing face, which stays opaque underneath. Each updater reads its shared
  // values itself: Reanimated subscribes a style only to the values in its own closure.
  const newMouthStyle = useAnimatedStyle(() => ({ opacity: botFaceMouthLayers(reaction.get(), elapsed.get(), restingFade.get()).incoming }));
  const smileStyle = useAnimatedStyle<ViewStyle>(() => {
    const slide = reaction.get() ? botFaceSmileSlide(currentPose.get()) : { x: 0, y: 0 };
    return { transform: [{ translateX: slide.x }, { translateY: slide.y }] };
  });
  const layers = React.useMemo<BotFaceMotionLayers>(() => (look === 0 && !(props.slide && playing) ? STILL_LAYERS
    : { look, smile: props.slide && playing ? smileStyle : null }), [look, playing, props.slide, smileStyle]);
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
