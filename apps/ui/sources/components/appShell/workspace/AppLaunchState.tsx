import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { finishLaunchCurtain, useLaunchCurtainHold, useLaunchCurtainState } from '@/boot/launchCurtain';

/** Above the app's own surfaces, below the step stage's frozen and painted layers. */
const CURTAIN_Z = 999;

/**
 * A surface that is still loading at launch (boot, Account restore). It holds the launch curtain, which draws
 * the still boot mark, and keeps its own words (a credential wait) above it.
 */
export const AppLaunchState = React.memo(function AppLaunchState(
  { testID, children }: React.PropsWithChildren<Readonly<{ testID: string }>>,
) {
  useLaunchCurtainHold(true);
  return (
    <View testID={testID} style={styles.state} pointerEvents="box-none"
      accessibilityRole="progressbar" accessibilityLabel={t('common.loading')}>
      {children}
    </View>
  );
});

/**
 * The launch curtain (web) continues the HTML shell's still boot mark in the same rect. It fades out
 * once the first destination has drawn and nothing holds it. Boot and Account restore mount it once.
 */
export function LaunchCurtain() {
  const state = useLaunchCurtainState();
  return state === 'gone' ? null : <CurtainLayer leaving={state === 'leaving'} />;
}

function CurtainLayer({ leaving }: Readonly<{ leaving: boolean }>) {
  const { theme } = useUnistyles();
  const colourScheme = theme.dark ? 'dark' : 'light';
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
      <StillPlanet theme={colourScheme} />
    </View>
  );
}

/** The HTML shell's own Still frame (`public/index.html`): the same image, rect and paint, with nothing to load. */
function StillPlanet({ theme }: Readonly<{ theme: 'light' | 'dark' }>) {
  return React.createElement('div', { className: 'launch-planet-still', 'data-theme': theme, 'data-testid': 'launch-curtain-still' });
}

const styles = StyleSheet.create((theme) => ({
  state: { ...StyleSheet.absoluteFillObject, zIndex: CURTAIN_Z + 1 },
  curtain: {
    ...StyleSheet.absoluteFillObject,
    zIndex: CURTAIN_Z,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background.canvas,
  },
}));
