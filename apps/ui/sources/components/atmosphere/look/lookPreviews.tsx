import * as React from 'react';
import { Animated, Image, Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  AtmosphereDissolve,
  AtmosphereEffectiveLook,
  AtmospherePicture,
} from '@happier-dev/brand/atmosphere';
import { planetGlyphLayer, type PlanetIntensity } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import { GlyphSurface } from '../glyph/GlyphSurface';
import { BackdropCanvas } from '../BackdropCanvas';
import { pictureBackdropProps } from '../pictureBackdrop';
import type { PictureRecord } from '../pictureStore.types';
import { atmospherePageRgb } from '../atmospherePage';
import { usePictureUri } from './usePictureBytes';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';

type Size = Readonly<{ width: number; height: number }>;

/** A preview fills its tile; it draws once the tile has a size (tiles keep their aspect from the owner). */
function Measured(
  props: Readonly<{ children: (size: Size) => React.ReactNode }>,
) {
  const [size, setSize] = React.useState<Size | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) =>
      previous && previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  }, []);
  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout}>
      <LazyMountOnScreen unmountWhenHidden rootMargin="0px" style={{ position: 'absolute', inset: 0 }}>
        {size && size.width > 0 && size.height > 0 ? props.children(size) : null}
      </LazyMountOnScreen>
    </View>
  );
}

function usePreviewTheme(): 'light' | 'dark' {
  const { theme } = useUnistyles();
  return theme.dark ? 'dark' : 'light';
}

/** The pane's page, so a tile reads as a small Home rather than a card. */
function PageGround(props: Readonly<{ children?: React.ReactNode }>) {
  return <View style={styles.page}>{props.children}</View>;
}

/** Home in miniature: the headline and the composer, where the planet sits around them (lab `.at-ptile`). */
function HomeSketch() {
  return (
    <>
      <View style={styles.sketchHeadline} />
      <View style={styles.sketchComposer} />
    </>
  );
}

export const PlanetIntensityPreview = React.memo(function PlanetIntensityPreview(
  { intensity, swatch = true }: Readonly<{ intensity: PlanetIntensity; swatch?: boolean }>,
) {
  const theme = usePreviewTheme();
  return (
    <PageGround>
      <Measured>
        {(pane) => (
          <GlyphSurface
            width={pane.width}
            height={pane.height}
            theme={theme}
            scene={[planetGlyphLayer({
              geometry: horizonPlanetGeometry(pane, swatch ? { limb: -0.08 * pane.height, radius: 0.7 * pane.height } : undefined),
              intensity,
              digits: false,
            })]}
            style={StyleSheet.absoluteFill}
          />
        )}
      </Measured>
    </PageGround>
  );
});

export function PlanetSourcePreview(props: Readonly<{ intensity: PlanetIntensity }>) {
  return <PlanetIntensityPreview intensity={props.intensity} swatch={false} />;
}

/** The plain page: no atmosphere. */
export function PlainPagePreview() {
  return (
    <PageGround>
      <HomeSketch />
    </PageGround>
  );
}

/**
 * A picture as the picker shows it: its own pixels, no look applied. Until they arrive the tile is a
 * quiet ink well (never a blank card that reads as an empty slot); they then fade in, at once under
 * reduced motion.
 */
export const PictureImagePreview = React.memo(function PictureImagePreview(
  props: Readonly<{ bytes: Blob | string | null }>,
) {
  const uri = usePictureUri(props.bytes);
  return (
    <View style={styles.image}>
      {uri ? <ArrivingImage key={uri} uri={uri} /> : null}
    </View>
  );
});

function ArrivingImage(props: Readonly<{ uri: string }>) {
  const reducedMotion = useReducedMotionPreference();
  const [opacity] = React.useState(() => new Animated.Value(reducedMotion ? 1 : 0));
  const onLoad = React.useCallback(() => {
    if (reducedMotion) {
      opacity.setValue(1);
      return;
    }
    Animated.timing(opacity, {
      toValue: 1,
      duration: motionTokens.durationMs.base,
      easing: motionTokens.easing.standard,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [opacity, reducedMotion]);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
      <Image
        source={{ uri: props.uri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        onLoad={onLoad}
        accessibilityIgnoresInvertColors
      />
    </Animated.View>
  );
}

/** The current picture drawn with one look or one fade, by the brand renderer, at tile size. */
export const PictureLookPreview = React.memo(function PictureLookPreview(
  props: Readonly<{
    source: PictureRecord;
    picture: AtmospherePicture | null;
    look: AtmosphereEffectiveLook;
    dissolve?: AtmosphereDissolve | null;
  }>,
) {
  const theme = usePreviewTheme();
  const pageColor = useUnistyles().theme.colors.surface.base;
  const page = React.useMemo(() => atmospherePageRgb(pageColor), [pageColor]);
  return (
    <View style={styles.image}>
      <Measured>
        {(size) => {
          const backdrop = pictureBackdropProps({
            picture: props.picture,
            look: props.look,
            theme,
            page,
            layout: 'wallpaper',
            horizonAt: 0.5,
          });
          return (
            <BackdropCanvas
              resettle={false}
              source={props.source}
              size={size}
              {...backdrop}
              dissolve={props.dissolve ?? null}
              style={StyleSheet.absoluteFill}
            />
          );
        }}
      </Measured>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  page: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface.base,
    overflow: 'hidden',
  },
  image: {
    ...StyleSheet.absoluteFillObject,
    // The ink well a picture lands in (the lab's 6 % fill), quieter than any card.
    backgroundColor: theme.colors.surface.selected,
    overflow: 'hidden',
  },
  // The lab tile's headline bar (36% inset, 40% down) and glass composer (22% inset, 48% down, 15% tall).
  sketchHeadline: {
    position: 'absolute',
    left: '36%',
    right: '36%',
    top: '40%',
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.colors.text.secondary,
    opacity: 0.7,
  },
  sketchComposer: {
    position: 'absolute',
    left: '22%',
    right: '22%',
    top: '48%',
    height: '15%',
    borderRadius: 4,
    backgroundColor: theme.colors.surface.base,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
}));
