import * as React from 'react';
import { Image, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { createLoadingPlanetScene, loadingPlanetSize } from '@happier-dev/brand/glyph-scene';

import type { GlyphMotion, GlyphSurfaceProps } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

/**
 * Startup stays on the shell's Still frame until the Brand surface has painted.
 * Boot and initial Account restore own how long this state stays mounted.
 */
export const AppLaunchState = React.memo(function AppLaunchState(
  { testID, children }: React.PropsWithChildren<Readonly<{ testID: string }>>,
) {
  const { theme } = useUnistyles();
  const colourScheme = theme.dark ? 'dark' : 'light';
  const reduced = useReducedMotionPreference();
  return (
    <View style={styles.root}>
      <View testID={testID} style={styles.planet} accessibilityRole="progressbar" accessibilityLabel={t('common.loading')}>
        {reduced
          ? <StillPlanet theme={colourScheme} testID={`${testID}-planet-still`} />
          : <LivePlanet theme={colourScheme} testID={testID} />}
      </View>
      {children}
    </View>
  );
});

type LaunchPlanetProps = Readonly<{ theme: 'light' | 'dark'; testID: string }>;

function StillPlanet({ theme, testID }: LaunchPlanetProps) {
  const source = { uri: `/launch-planet-${theme}.png` };
  return <Image accessible={false} accessibilityIgnoresInvertColors testID={testID} source={source} fadeDuration={0} style={styles.planet} />;
}

function LivePlanet({ theme, testID }: LaunchPlanetProps) {
  const [surface, setSurface] = React.useState<typeof import('@/components/atmosphere/glyph/GlyphSurface.web').GlyphSurface | null>(null);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let mounted = true;
    void import('@/components/atmosphere/glyph/GlyphSurface.web').then(({ GlyphSurface }) => {
      if (mounted) setSurface(() => GlyphSurface);
    }, () => {});
    return () => { mounted = false; };
  }, []);
  const scene = React.useMemo<GlyphSurfaceProps['scene']>(() => {
    const load = createLoadingPlanetScene();
    return (seconds, readiness) => load(readiness === 'still' ? 0 : seconds);
  }, []);
  const motion = React.useMemo<GlyphMotion>(() => {
    let start: number | undefined;
    return { kind: 'sequence', readTimeS: (now) => (now - (start ??= now)) / 1000, continues: () => true };
  }, []);
  const onReady = React.useCallback<NonNullable<GlyphSurfaceProps['onReady']>>(status => setReady(status === 'ready'), []);
  const Surface = surface;
  return <>
    {!ready && <StillPlanet theme={theme} testID={`${testID}-planet-still`} />}
    {Surface && <View pointerEvents="none" style={[styles.live, { opacity: ready ? 1 : 0 }]}>
      <Surface testID={`${testID}-planet-live`} theme={theme} width={loadingPlanetSize} height={loadingPlanetSize}
        scene={scene} motion={motion} onReady={onReady} />
    </View>}
  </>;
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background.canvas,
  },
  planet: { width: loadingPlanetSize, height: loadingPlanetSize },
  live: { position: 'absolute', top: 0, left: 0 },
}));
