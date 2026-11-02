import * as React from 'react';
import { PixelRatio, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import type { BotMotion } from '@happier-dev/protocol/account/settings/accountSettings';

import { botFaceHeroPose, type BotFaceMood } from './botFaceGeometry';
import type { BotFaceIdentity, BotFaceStyle } from './botFaceIdentity';
import { botFaceRasterStep, drawBotFaceRaster } from './botFaceRaster';
import { createBotFaceScene } from './botFaceScene';
import { BotFaceRasterView } from './BotFaceRasterView';
import { botFaceMotionTokens } from './botFaceMotionTokens';
import { useBotFaceMoment } from './useBotFaceMoment';
import Animated from 'react-native-reanimated';
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
  /** The rail, roster and summary opt into U5 playback; ordinary Session lists remain still. */
  motion?: boolean;
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
          identity={props.identity.seed} {...motionDrawing(frame)}
          marker={props.marker}
          visible={props.visible !== false} completedAt={props.completedAt} failedAt={props.failedAt}>
          {(mouth, moment, layers) => moment && (frame.style === 'dither' || frame.style === 'solid')
            ? <BotFacePosed frame={frame} style={frame.style} moment={moment} />
            : layers.smile ? <BotFaceLayered frame={{ ...frame, mood: mouth }} smile={layers.smile} />
            : <BotFaceStill frame={{ ...frame, mood: mouth }} look={layers.look} />}
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
 * How each style moves on the rail (lab R7, R8 fixes): Dither and Solid redraw the body at each pose of a moment, so the
 * light stays put and cells stay on whole pixels; Pixel steps its own sprite pixel and never stretches; Dither breathes
 * as one cell step. Dots, Planet and Solid's breath move the cached drawing about its foot.
 */
function motionDrawing(frame: Frame): Readonly<{ posed: boolean; step?: number; stepMoments?: boolean; look?: boolean; slide?: boolean }> {
  if (frame.style === 'dots') return { posed: false, slide: true };
  if (frame.style === 'planet') return { posed: false };
  if (frame.style === 'solid') return { posed: true };
  const step = botFaceRasterStep({ ...frame, style: frame.style });
  return frame.style === 'pixel' ? { posed: false, step, stepMoments: true, look: true } : { posed: true, step };
}

/** A Dots face mid-moment (R8 C): the body and its smile as two layers, the smile sliding with the turn. */
function BotFaceLayered(props: Readonly<{ frame: Frame; smile: NonNullable<BotFaceMotionLayers['smile']> }>) {
  const { identity, size, mood, monochrome, theme, dpr } = props.frame;
  const [body, smile] = React.useMemo(() => (['body', 'smile'] as const).map(layer =>
    createBotFaceScene({ style: 'dots', identity, size, mood, monochrome, theme, dpr, layer })), [identity, size, mood, monochrome, theme, dpr]);
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

/** A rail face mid-moment, redrawn at its pose; it paints only when the pose visibly changes. */
function BotFacePosed(props: Readonly<{ frame: Frame; style: 'dither' | 'solid'; moment: BotFaceMotionMoment }>) {
  const { identity, size, monochrome, theme, dpr, mood } = props.frame;
  const { style } = props;
  const { channels, from, to, u } = props.moment;
  const pad = stagePad(props.frame);
  const image = React.useMemo(
    () => drawBotFaceRaster({ identity, style, size, monochrome, theme, dpr, mood, moment: { channels, from, to, u, pad } }),
    [identity, style, size, monochrome, theme, dpr, mood, channels, from, to, u, pad],
  );
  const frame = props.frame;
  return (
    <View style={{ width: frame.size, height: frame.size }}>
      <View pointerEvents="none" style={{ position: 'absolute', left: -pad, top: -pad }}>
        <BotFaceRasterView image={image} size={frame.size + 2 * pad} />
      </View>
    </View>
  );
}

function BotFaceStill(props: Readonly<{ frame: Frame; look?: -1 | 0 | 1 }>) {
  const { identity, style, size, mood, monochrome, theme, dpr } = props.frame;
  const look = props.look ?? 0;
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
        }),
        [identity, style, size, mood, monochrome, theme, dpr, look],
      )}
    />
  );
}

/** Owns the only frame clock: the moment's `t` re-renders this leaf alone, and only while a moment plays. */
function BotFaceHero(props: Readonly<{ frame: Frame; visible: boolean; mode: BotMotion }>) {
  const reducedMotion = useReducedMotionPreference();
  const viewed = useHostActivelyViewed();
  const { identity, style, size, mood, monochrome, theme, dpr } = props.frame;
  const t = useBotFaceMoment(mood, props.visible && viewed && !reducedMotion && props.mode !== 'still', props.mode === 'reactions');
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
          hero: {
            pose: botFaceHeroPose(mood, t ?? 0, identity.seed, t === null),
            t: t ?? 0,
            rest: t === null,
          },
        }),
        [identity, style, size, mood, monochrome, theme, dpr, t],
      )}
    />
  );
}

type Draw = () => Frame &
  Readonly<{
    hero:
      | { pose: ReturnType<typeof botFaceHeroPose>; t: number; rest: boolean }
      | undefined;
    look?: -1 | 0 | 1;
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
          image: drawBotFaceRaster({ ...input, style: input.style }),
        };
  }, [draw]);
  const size = props.frame.size;
  return output.kind === 'scene' ? (
    <PlanetCanvas width={size} height={size} scene={output.scene} />
  ) : (
    <BotFaceRasterView image={output.image} size={size} />
  );
}
