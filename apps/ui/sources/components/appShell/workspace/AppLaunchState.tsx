import * as React from 'react';
import { Image, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { createLoadingPlanetScene, loadingPlanetSize } from '@happier-dev/brand/glyph-scene';

import type { GlyphMotion, GlyphSurfaceProps } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { finishLaunchCurtain, readLaunchShellBreathS, useLaunchCurtainHold, useLaunchCurtainState } from '@/boot/launchCurtain';

/** Above the app's own surfaces, below the step stage's frozen and painted layers. */
const CURTAIN_Z = 999;

/**
 * A surface that is still loading at launch (boot, Account restore). On web it holds the launch curtain, which draws
 * the Loading planet across every launch state. Phones have no curtain (their boot stays under the Expo splash): Account
 * restore draws the same planet itself, continuing the splash's image in the same rect. Its own words (a credential
 * wait) stay above the planet.
 */
export const AppLaunchState = React.memo(function AppLaunchState(
  { testID, children }: React.PropsWithChildren<Readonly<{ testID: string }>>,
) {
  useLaunchCurtainHold(true);
  const phone = Platform.OS !== 'web';
  return (
    <View testID={testID} style={phone ? styles.phoneState : styles.state} pointerEvents="box-none"
      accessibilityRole="progressbar" accessibilityLabel={t('common.loading')}>
      {phone ? <View style={styles.planet} pointerEvents="none"><LaunchPlanet /></View> : null}
      {children}
    </View>
  );
});

/** The Loading planet: live (breathing, digits gathering) unless reduced motion keeps its Still frame. */
function LaunchPlanet() {
  const { theme } = useUnistyles();
  const colourScheme = theme.dark ? 'dark' : 'light';
  return useReducedMotionPreference() ? <StillPlanet theme={colourScheme} /> : <LivePlanet theme={colourScheme} />;
}

/**
 * The launch curtain (web): the Loading planet over the app, from the first React frame until the first destination
 * has drawn. It continues the HTML shell's breathing Still frame in the same rect, swaps to the live planet (breathing,
 * digits gathering) once that has painted, and fades out when nothing holds it. Boot and Account restore mount it once.
 * Reduced motion keeps the Still frame and loads no renderer.
 */
export function LaunchCurtain() {
  const state = useLaunchCurtainState();
  return state === 'gone' ? null : <CurtainLayer leaving={state === 'leaving'} />;
}

function CurtainLayer({ leaving }: Readonly<{ leaving: boolean }>) {
  const reduced = useReducedMotionPreference();
  const layer = React.useRef<View>(null);
  React.useLayoutEffect(() => {
    if (!leaving) return;
    const node = layer.current as unknown as HTMLElement | null;
    if (!node?.animate) {
      finishLaunchCurtain();
      return;
    }
    const { atmosphere, easingCss } = motionTokens;
    const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: reduced ? atmosphere.reducedCrossFadeMs : atmosphere.leaveFadeMs, easing: easingCss.exit, fill: 'forwards',
    });
    fade.finished.then(finishLaunchCurtain, () => {});
    return () => fade.cancel();
  }, [leaving, reduced]);
  return (
    <View ref={layer} testID="launch-curtain" style={styles.curtain} pointerEvents="none"
      aria-hidden importantForAccessibility="no-hide-descendants" {...{ inert: true }}>
      <LaunchPlanet />
    </View>
  );
}

/**
 * The launch poster as the Still frame. Web: the HTML shell's own frame (`public/index.html`), the same image, rect and
 * paint, its CSS breath joining the shell's at the same phase. Phones: the Expo splash's image in the same rect.
 */
function StillPlanet({ theme }: Readonly<{ theme: 'light' | 'dark' }>) {
  const [style] = React.useState(() => ({ animationDelay: `${-readLaunchShellBreathS()}s` }));
  if (Platform.OS !== 'web') {
    const source = theme === 'dark' ? require('../../../../public/launch-planet-dark.png') : require('../../../../public/launch-planet-light.png');
    return <Image testID="launch-curtain-still" source={source} fadeDuration={0} style={StyleSheet.absoluteFill} accessible={false} />;
  }
  return React.createElement('div', { className: 'launch-planet-still', 'data-theme': theme, 'data-testid': 'launch-curtain-still', style });
}

const loadGlyphSurface = () => Platform.OS === 'web'
  ? import('@/components/atmosphere/glyph/GlyphSurface.web')
  : import('@/components/atmosphere/glyph/GlyphSurface');

/** The live Loading planet. Its clock starts where the shell's breath has reached, so the swap keeps the breath. */
function LivePlanet({ theme }: Readonly<{ theme: 'light' | 'dark' }>) {
  const [surface, setSurface] = React.useState<React.ComponentType<GlyphSurfaceProps> | null>(null);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let mounted = true;
    void loadGlyphSurface().then(({ GlyphSurface }) => {
      if (mounted) setSurface(() => GlyphSurface);
    }, () => {});
    return () => { mounted = false; };
  }, []);
  const scene = React.useMemo<GlyphSurfaceProps['scene']>(() => {
    const load = createLoadingPlanetScene();
    return (seconds, readiness) => load(readiness === 'still' ? 0 : seconds);
  }, []);
  const motion = React.useMemo<GlyphMotion>(() => {
    let startMs: number | undefined;
    return { kind: 'sequence', readTimeS: (now) => (now - (startMs ??= now - readLaunchShellBreathS() * 1000)) / 1000, continues: () => true };
  }, []);
  const onReady = React.useCallback<NonNullable<GlyphSurfaceProps['onReady']>>(status => setReady(status === 'ready'), []);
  const Surface = surface;
  return <>
    {!ready && <StillPlanet theme={theme} />}
    {Surface && <View pointerEvents="none" style={[styles.live, { opacity: ready ? 1 : 0 }]}>
      <Surface testID="launch-curtain-live" theme={theme} width={loadingPlanetSize} height={loadingPlanetSize}
        scene={scene} motion={motion} onReady={onReady} />
    </View>}
  </>;
}

const styles = StyleSheet.create((theme) => ({
  state: { ...StyleSheet.absoluteFillObject, zIndex: CURTAIN_Z + 1 },
  phoneState: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background.canvas,
  },
  planet: { width: loadingPlanetSize, height: loadingPlanetSize },
  curtain: {
    ...StyleSheet.absoluteFillObject,
    zIndex: CURTAIN_Z,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background.canvas,
  },
  live: { width: loadingPlanetSize, height: loadingPlanetSize },
}));
