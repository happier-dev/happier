import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BackdropCanvas } from '../BackdropCanvas';
import { GlyphSurface } from '../glyph/GlyphSurface';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import { planetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { pictureBackdropProps, releaseLook } from '../pictureBackdrop';
import { useAtmosphere, type AtmosphereTarget } from '../useAtmosphere';
import { useAtmospherePictureCatalog } from '../useAtmospherePictureCatalog';
import { atmospherePageRgb } from '../atmospherePage';
import { effectivePictureLook } from './atmosphereEdits';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS, resolveHappierPublicProfilePlanetBand } from '@happier-dev/plugin-ui/presentation';
import type { PublicProfilePictureDescriptorV1 } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import type { PictureRecord } from '../pictureStore.types';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';
import { useDeviceType } from '@/utils/platform/responsive';

/** In a small window preview the Horizon band covers the top of the page, as it does on Home. */
const PREVIEW_BAND_SHARE = 0.62;
/** Without a measured headline, the picture's horizon sits mid-band (Home measures its own). */
const PREVIEW_HORIZON_AT = 0.5;
/** A profile header band uses the public page's own horizon, so app and server paint the same band. */
const BAND_HORIZON_AT = HAPPIER_PUBLIC_PROFILE_HERO_METRICS.horizonAt;

/**
 * An atmosphere drawn static and decorative: by default the user's current Home behind a window
 * preview (Settings → Glass and backdrop, the glass material tiles). A public profile passes its own
 * draft and draws the whole box as its header band. The page, then the planet or the picture, exactly
 * as that target resolves on this device.
 */
export const AtmospherePreview = React.memo(function AtmospherePreview(
  props: Readonly<{
    target?: AtmosphereTarget;
    /** `band`: a Horizon picture fills the whole box (a header band), not the top of a window. */
    frame?: 'window' | 'band';
  }>,
) {
  const { theme } = useUnistyles();
  const mode = theme.dark ? 'dark' : 'light';
  const atmosphere = useAtmosphere(props.target ?? 'home');
  const bandFrame = props.frame === 'band';
  const phone = useDeviceType() === 'phone';
  const pictures = useAtmospherePictureCatalog();
  const [size, setSize] = React.useState<Readonly<{
    width: number;
    height: number;
  }> | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) =>
      previous && previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  }, []);
  const pageColor = theme.colors.surface.base;
  const page = React.useMemo(() => atmospherePageRgb(pageColor), [pageColor]);
  const record = atmosphere.pictureRecord;
  // The small preview draws from the cached thumbnail when there is one; the full picture otherwise.
  const source = React.useMemo(
    () =>
      record && record.thumb !== undefined
        ? { ...record, data: record.thumb }
        : record,
    [record],
  );
  let art: React.ReactNode = null;
  if (size && size.width > 0 && size.height > 0) {
    if (atmosphere.source === 'planet') {
      const pane = { width: size.width, height: size.height };
      art = (
        <GlyphSurface
          width={size.width}
          height={size.height}
          style={StyleSheet.absoluteFill}
          theme={mode}
          scene={[planetGlyphLayer({
            geometry: horizonPlanetGeometry(pane, { ...(bandFrame ? resolveHappierPublicProfilePlanetBand(pane) : undefined), phone }),
            ...atmosphere.planet,
          })]}
        />
      );
    } else if (atmosphere.source === 'picture' && source) {
      const wallpaper = atmosphere.picture.layout === 'wallpaper';
      const band = {
        width: size.width,
        height:
          wallpaper || bandFrame
            ? size.height
            : Math.round(size.height * PREVIEW_BAND_SHARE),
      };
      const backdrop = pictureBackdropProps({
        picture: atmosphere.builtinPicture,
        look: effectivePictureLook(atmosphere, pictures),
        theme: mode,
        page,
        layout: atmosphere.picture.layout,
        horizonAt: bandFrame ? BAND_HORIZON_AT : PREVIEW_HORIZON_AT,
      });
      art = (
        <BackdropCanvas
          resettle={false}
          source={source}
          size={band}
          {...backdrop}
          style={styles.band}
        />
      );
    }
  }
  return (
    <View
      style={styles.page}
      onLayout={onLayout}
      pointerEvents="none"
      aria-hidden
    >
      <LazyMountOnScreen unmountWhenHidden rootMargin="0px" style={{ position: 'absolute', inset: 0 }}>
        {art}
      </LazyMountOnScreen>
    </View>
  );
});

/**
 * A public profile's reviewed picture copy (the applied edition, or the prepared copy under review)
 * as a header band: its frozen descriptor through the same Brand paint as candidates and the cold
 * public page, never the raw stored bytes.
 */
export const PublicPictureBand = React.memo(function PublicPictureBand(
  props: Readonly<{
    picture: Readonly<{
      layout: 'horizon' | 'wallpaper';
      descriptor: PublicProfilePictureDescriptorV1;
    }>;
    /** Local bytes as a `data:` URI; nothing while they are still being read. */
    data: string | null;
    /** Stable identity of these bytes, so the band's renders are cached per copy. */
    copyId: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [size, setSize] = React.useState<Readonly<{
    width: number;
    height: number;
  }> | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) =>
      previous && previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  }, []);
  const pageColor = theme.colors.surface.base;
  const page = React.useMemo(() => atmospherePageRgb(pageColor), [pageColor]);
  const source = React.useMemo<PictureRecord | null>(
    () =>
      props.data
        ? {
            localId: `public-profile-copy:${props.copyId}`,
            kind: 'user',
            createdAtMs: 0,
            size: props.data.length,
            data: props.data,
          }
        : null,
    [props.copyId, props.data],
  );
  const mode = theme.dark ? 'dark' : 'light';
  const { descriptor, layout } = props.picture;
  const backdrop = React.useMemo(
    () =>
      pictureBackdropProps({
        picture: descriptor,
        look: releaseLook(descriptor),
        theme: mode,
        page,
        layout,
        horizonAt: BAND_HORIZON_AT,
      }),
    [descriptor, layout, mode, page],
  );
  return (
    <View
      testID="public-picture-band"
      style={styles.page}
      onLayout={onLayout}
      pointerEvents="none"
      aria-hidden
    >
      <LazyMountOnScreen unmountWhenHidden rootMargin="0px" style={{ position: 'absolute', inset: 0 }}>
        {size && size.width > 0 && size.height > 0 && source ? (
          <BackdropCanvas
            resettle={false}
            source={source}
            size={size}
            {...backdrop}
            style={styles.band}
          />
        ) : null}
      </LazyMountOnScreen>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  page: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface.base,
    overflow: 'hidden',
  },
  band: { position: 'absolute', left: 0, top: 0 },
}));
