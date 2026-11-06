import * as React from 'react';
import { PixelRatio, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import type { BotMotion } from '@happier-dev/protocol/account/settings/accountSettings';

import { botFaceHeroPose, botFaceMoodMouth, type BotFaceMood, type BotFaceMutter } from './botFaceGeometry';
import { BOT_FACE_LOOK_REST, registerBotFaceBrain, type BotFaceBrainHandle, type BotFaceLook, type BotFaceTurnKind } from './botFaceIdle';
import { resolveBotFaceArt, type BotFaceIdentity, type BotFaceStyle } from './botFaceIdentity';
import { botFaceArtHash } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
import { botFaceRasterStep, drawBotFaceRaster, type BotFaceRasterImage, type BotFaceRasterInput, type BotFaceTurn } from './botFaceRaster';
import { createBotFaceScene } from './botFaceScene';
import { BotFaceRasterView } from './BotFaceRasterView';
import { BOT_FACE_REST, botFaceMotionTokens } from './botFaceMotionTokens';
import { useBotFaceMoment } from './useBotFaceMoment';
import { useBotFaceMotionEligibility } from './useBotFaceMotionEligibility';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { BotFaceMotion, type BotFaceMotionLayers, type BotFaceMotionMoment } from './BotFaceMotion';

/** Up to 32 px a face draws its list form, still; from here up it is a hero with one bounded moment (lab R6). */
export const BOT_FACE_HERO_MIN_SIZE = 48;

export type BotFaceProps = Readonly<{
  identity: BotFaceIdentity;
  style: BotFaceStyle;
  size: number;
  /** The mouth: quiet, working and needs you from `botActivity`; done for the completion moment. */
  mood: BotFaceMood;
  /** Greyscale. Bot identity surfaces keep colour (lab R6: the state is the mouth); only the desktop notch greys a face that is not live. */
  monochrome?: boolean;
  /** Whether the hosting surface is on screen (list viewability, Home near-viewport). Heroes only. */
  visible?: boolean;
  /** Rail/roster life, or only a finite hover/touch perk for ordinary resting rows. */
  motion?: boolean | 'interaction';
  motionMode?: BotMotion;
  completedAt?: number | null;
  failedAt?: number | null;
  marker?: React.ReactNode;
  testID?: string;
  accessibilityLabel?: string;
}>;

type Frame = Readonly<{
  identity: BotFaceIdentity;
  style: BotFaceStyle;
  size: number;
  mood: BotFaceMood;
  monochrome: boolean;
  theme: 'light' | 'dark';
  dpr: number;
}>;

/**
 * A Living Bot's face: one identity drawn in the chosen style. Dither, Solid and Pixel paint a raster image; Dots and
 * Planet are Brand scenes painted by the canonical PlanetCanvas. Lists are still and redraw only when an input
 * changes; heroes play one moment per appearance or mood change and render zero frames when ineligible.
 */
export const BotFace = React.memo(function BotFace(props: BotFaceProps) {
  const { theme } = useUnistyles();
  const frame: Frame = {
    identity: props.identity,
    style: props.style,
    size: props.size,
    mood: props.mood,
    monochrome: props.monochrome === true,
    theme: theme.dark ? 'dark' : 'light',
    dpr: PixelRatio.get(),
  };
  return (
    <View
      testID={props.testID}
      accessible={Boolean(props.accessibilityLabel)}
      accessibilityRole="image"
      accessibilityLabel={props.accessibilityLabel}
      style={{ width: props.size, height: props.size }}
    >
      {props.motion ? (
        <BotFaceMotion mood={props.mood} mode={props.motionMode ?? 'lively'} size={props.size}
          interactionOnly={props.motion === 'interaction'}
          identity={props.identity.seed} {...motionDrawing(frame)}
          marker={props.marker}
          visible={props.visible !== false} completedAt={props.completedAt} failedAt={props.failedAt}>
          {(mouth, moment, layers) => (moment || layers.turn) && (frame.style === 'dither' || frame.style === 'solid')
            ? <BotFacePosed frame={frame} style={frame.style} moment={moment ?? restingMoment(mouth)} turn={layers.turn} mutter={layers.mutter} />
            : layers.smile ? <BotFaceLayered frame={{ ...frame, mood: mouth }} smile={layers.smile} mutter={layers.mutter} />
            : <BotFaceStill frame={{ ...frame, mood: mouth }} look={layers.look} mutter={layers.mutter} />}
        </BotFaceMotion>
      ) : props.size >= BOT_FACE_HERO_MIN_SIZE ? (
        <BotFaceHero frame={frame} visible={props.visible !== false} mode={props.motionMode ?? 'lively'} />
      ) : (
        <BotFaceStill frame={frame} />
      )}
    </View>
  );
});

/**
 * How each style moves on the rail (lab R7, R8 fixes, R10 A): Dither and Solid redraw the body at each pose of a moment
 * and at each turn of the brain, so the light stays put and cells stay on whole pixels; Pixel steps its own sprite pixel
 * and never stretches, and its face rows look toward a turn; Dots slides its smile with the turn; Planet does not turn
 * (R6). Dots and Planet moments move the cached drawing about its foot.
 */
function motionDrawing(frame: Frame): Readonly<{ posed: boolean; grain?: number; step?: number; stepMoments?: boolean; look?: boolean; slide?: boolean; turns: BotFaceTurnKind }> {
  if (frame.style === 'dots') return { posed: false, slide: true, turns: 'slide' };
  if (frame.style === 'planet') return { posed: false, turns: 'none' };
  // A posed drawing's smallest visible change: one device pixel of Solid's shading, a third of a Dither cell (its 3×3
  // coverage samples).
  if (frame.style === 'solid') return { posed: true, grain: 1 / frame.dpr, turns: 'full' };
  const step = botFaceRasterStep({ ...frame, style: frame.style });
  return frame.style === 'pixel' ? { posed: false, step, stepMoments: true, look: true, turns: 'look' } : { posed: true, grain: step / 3, step, turns: 'full' };
}
const restingMoment = (mood: BotFaceMood): BotFaceMotionMoment => ({ channels: BOT_FACE_REST, from: mood, to: mood, u: 1 });

/**
 * List drawings a face returns to (a turn bucket, a mutter step, a moment's quantised pose), kept per drawn identity
 * (its art and colour, so a remounted row or the same Bot on another surface reuses them): a face takes few positions
 * and a moment replays the same poses, so after its first plays it reuses them instead of drawing again (R7/R8 "cache
 * pose rasters per state", R10 §2.2). Bounded by the Bots shown times their quantised poses.
 */
const listDrawings = new Map<string, Map<string, BotFaceRasterImage>>();
function drawListRaster(input: BotFaceRasterInput): BotFaceRasterImage {
  const owner = `${input.identity.colour}|${botFaceArtHash(resolveBotFaceArt(input.identity))}`;
  let drawings = listDrawings.get(owner);
  if (!drawings) { drawings = new Map(); listDrawings.set(owner, drawings); }
  const m = input.moment;
  const key = [input.style, input.size, input.dpr, input.theme, input.mood, input.monochrome ? 1 : 0, input.look ?? 0, input.mutter ?? '',
    m ? [m.from, m.to, m.u, m.pad, m.channels.tx, m.channels.ty, m.channels.sx, m.channels.sy, m.channels.rot, m.turn?.yaw, m.turn?.pitch, m.turn?.roll].join(',') : ''].join('|');
  let image = drawings.get(key);
  if (!image) { image = drawBotFaceRaster(input); drawings.set(key, image); }
  return image;
}

/** A Dots face mid-moment (R8 C): the body and its smile as two layers, the smile sliding with the turn. */
function BotFaceLayered(props: Readonly<{ frame: Frame; smile: NonNullable<BotFaceMotionLayers['smile']>; mutter: BotFaceMutter | null }>) {
  const { identity, size, mood, monochrome, theme, dpr } = props.frame;
  const mutter = props.mutter ?? undefined;
  const [body, smile] = React.useMemo(() => (['body', 'smile'] as const).map(layer =>
    createBotFaceScene({ style: 'dots', identity, size, mood, monochrome, theme, dpr, layer, mutter })), [identity, size, mood, monochrome, theme, dpr, mutter]);
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: 'absolute' }}><PlanetCanvas width={size} height={size} scene={body} /></View>
      <Animated.View style={props.smile}><PlanetCanvas width={size} height={size} scene={smile} /></Animated.View>
    </View>
  );
}

/** The stage around a moving rail face (R7 `stageScale`), whole device pixels on each side so the cells stay put. */
function stagePad(frame: Frame): number {
  return Math.round(frame.size * ((botFaceMotionTokens.stageScale - 1) / 2) * frame.dpr) / frame.dpr;
}

/**
 * A rail face mid-moment or turned by its brain, redrawn at its pose; it paints only when the pose visibly changes. A
 * resting turn is one of the face's few cached drawings.
 */
function BotFacePosed(props: Readonly<{ frame: Frame; style: 'dither' | 'solid'; moment: BotFaceMotionMoment; turn: BotFaceTurn | null; mutter: BotFaceMutter | null }>) {
  const { identity, size, monochrome, theme, dpr, mood } = props.frame;
  const { style, turn } = props;
  const mutter = props.mutter ?? undefined;
  const { channels, from, to, u } = props.moment;
  const pad = stagePad(props.frame);
  const image = React.useMemo(() => {
    const input: BotFaceRasterInput = { identity, style, size, monochrome, theme, dpr, mood, mutter, moment: { channels, from, to, u, pad, ...(turn ? { turn } : {}) } };
    return drawListRaster(input);
  }, [identity, style, size, monochrome, theme, dpr, mood, mutter, channels, from, to, u, pad, turn]);
  const frame = props.frame;
  return (
    <View style={{ width: frame.size, height: frame.size }}>
      <View pointerEvents="none" style={{ position: 'absolute', left: -pad, top: -pad }}>
        <BotFaceRasterView image={image} size={frame.size + 2 * pad} />
      </View>
    </View>
  );
}

function BotFaceStill(props: Readonly<{ frame: Frame; look?: -1 | 0 | 1; mutter?: BotFaceMutter | null }>) {
  const { identity, style, size, mood, monochrome, theme, dpr } = props.frame;
  const look = props.look ?? 0;
  const mutter = props.mutter ?? undefined;
  return (
    <BotFacePaint
      frame={props.frame}
      draw={React.useCallback(
        () => ({
          identity,
          style,
          size,
          mood,
          monochrome,
          theme,
          dpr,
          hero: undefined,
          ...(look ? { look } : {}),
          ...(mutter !== undefined ? { mutter } : {}),
        }),
        [identity, style, size, mood, monochrome, theme, dpr, look, mutter],
      )}
    />
  );
}

/**
 * A hero (48 px and up): one bounded moment per appearance or mood change (its own frame clock, this leaf only), then,
 * in Lively, the attention brain turns it (hero turn step) and it breathes (R10 A §1: sy 1.2% over 3.4 s, a compositor
 * loop). Reactions only, Still, Reduce motion and hidden heroes register nothing and rest.
 */
function BotFaceHero(props: Readonly<{ frame: Frame; visible: boolean; mode: BotMotion }>) {
  const { ref, measure, eligible } = useBotFaceMotionEligibility(props.visible, props.mode);
  const { identity, style, size, mood, monochrome, theme, dpr } = props.frame;
  const t = useBotFaceMoment(mood, eligible, props.mode === 'reactions');
  const lively = eligible && props.mode === 'lively';
  const [look, setLook] = React.useState<BotFaceLook>(BOT_FACE_LOOK_REST);
  const brain = React.useRef<BotFaceBrainHandle | null>(null);
  const moodNow = React.useRef(mood);
  moodNow.current = mood;
  React.useEffect(() => {
    if (!lively) return;
    const handle = registerBotFaceBrain({
      seed: identity.seed, mode: 'lively', turns: 'full', hero: true, mood: moodNow.current,
      onLook: setLook, onGesture: () => {},
      locate: () => {
        const box = (ref.current as unknown as { getBoundingClientRect?: () => DOMRect } | null)?.getBoundingClientRect?.();
        return box ? { x: box.left + box.width / 2, y: box.top + box.height * 0.45 } : null;
      },
    });
    brain.current = handle;
    return () => { handle.release(); brain.current = null; setLook(BOT_FACE_LOOK_REST); };
  }, [identity.seed, lively, ref]);
  const seenMood = React.useRef(mood);
  React.useEffect(() => {
    const fact = seenMood.current !== mood;
    seenMood.current = mood;
    brain.current?.setMood(mood, fact);
  }, [mood]);
  const breath = useSharedValue(0);
  React.useEffect(() => {
    if (!lively) { cancelAnimation(breath); breath.set(0); return; }
    breath.set(withRepeat(withTiming(1, { duration: botFaceMotionTokens.alive.heroBreath.periodMs / 2, easing: Easing.inOut(Easing.sin) }), -1, true));
    return () => cancelAnimation(breath);
  }, [breath, lively]);
  const breathStyle = useAnimatedStyle(() => ({ transformOrigin: '50% 90%', transform: [{ scaleY: 1 + botFaceMotionTokens.alive.heroBreath.sy * breath.get() }] }));
  const resting = t === null;
  const lookYaw = resting ? look.yaw : 0, lookPitch = resting ? look.pitch : 0, lookRoll = resting ? look.roll : 0, mutter = resting ? look.mutter : null;
  return (
    <View ref={ref} collapsable={false} onLayout={measure}>
      <Animated.View testID={lively ? 'bot-face-hero-breath' : undefined} style={breathStyle}>
      <BotFacePaint
        frame={props.frame}
        draw={React.useCallback(
          () => {
            const pose = botFaceHeroPose(mood, t ?? 0, identity.seed, t === null);
            return {
              identity,
              style,
              size,
              mood,
              monochrome,
              theme,
              dpr,
              hero: {
                pose: { ...pose, yaw: pose.yaw + lookYaw, pitch: pose.pitch + lookPitch, roll: pose.roll + lookRoll,
                  ...(mutter !== null && mood === 'working' ? { mouth: botFaceMoodMouth('working', mutter) } : {}) },
                t: t ?? 0,
                rest: t === null,
              },
            };
          },
          [identity, style, size, mood, monochrome, theme, dpr, t, lookYaw, lookPitch, lookRoll, mutter],
        )}
      />
      </Animated.View>
    </View>
  );
}

type Draw = () => Frame &
  Readonly<{
    hero:
      | { pose: ReturnType<typeof botFaceHeroPose>; t: number; rest: boolean }
      | undefined;
    look?: -1 | 0 | 1;
    mutter?: BotFaceMutter;
  }>;
function BotFacePaint(props: Readonly<{ frame: Frame; draw: Draw }>) {
  const { draw } = props;
  const output = React.useMemo(() => {
    const input = draw();
    return input.style === 'dots' || input.style === 'planet'
      ? {
          kind: 'scene' as const,
          scene: createBotFaceScene({ ...input, style: input.style }),
        }
      : {
          kind: 'raster' as const,
          image: input.hero ? drawBotFaceRaster({ ...input, style: input.style }) : drawListRaster({ ...input, style: input.style }),
        };
  }, [draw]);
  const size = props.frame.size;
  return output.kind === 'scene' ? (
    <PlanetCanvas width={size} height={size} scene={output.scene} />
  ) : (
    <BotFaceRasterView image={output.image} size={size} />
  );
}
