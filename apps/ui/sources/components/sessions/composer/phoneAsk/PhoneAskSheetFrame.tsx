import * as React from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  StyleSheet as RNStyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useTheme } from '@react-navigation/native';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { surfaceUsesRim } from '@/components/ui/surfaces/surfaceEdgeTreatment';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSessionCockpitComposerBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { t } from '@/text';

import { usePhoneAskSheet } from './phoneAskSheetState';
import { useDestinationFocusSignal } from '@/components/appShell/workspace/destinationInstanceContext';

/** What the Ask sheet inside the Chat scene tells its frame: its own height and the composer's keyboard lift. */
export type PhoneAskSheetGeometry = Readonly<{
  height: number;
  lift: SharedValue<number> | null;
}>;

const PhoneAskSheetFrameReportContext = React.createContext<
  ((geometry: PhoneAskSheetGeometry) => void) | null
>(null);

export function usePhoneAskSheetFrameReport():
  | ((geometry: PhoneAskSheetGeometry) => void)
  | null {
  return React.useContext(PhoneAskSheetFrameReportContext);
}

/**
 * The phone cockpit's frame around its Chat scene (P5 §3.9, D-4). Not raised, the scene fills the cockpit as the
 * Session screen. Raised — Ask is open over another scene — the cockpit shows the same scene through a bottom
 * window exactly as tall as the Ask sheet (the composer, its keyboard lift and the bottom chrome it sits above),
 * so the page above stays readable
 * and a tap on it closes the sheet. The scene keeps its full-size layout either way: the composer's own keyboard
 * geometry is untouched and nothing inside remounts.
 */
export function PhoneAskSheetFrame(
  props: React.PropsWithChildren<Readonly<{ raised: boolean }>>,
): React.ReactElement {
  const { raised } = props;
  const sheet = usePhoneAskSheet();
  const { theme } = useUnistyles();
  const navigationTheme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  const [layerHeight, setLayerHeight] = React.useState(0);
  const [lift, setLift] = React.useState<SharedValue<number> | null>(null);
  const sheetHeight = useSharedValue(0);
  // The Session screen holds its composer above the floating bottom chrome (0 while the keyboard hides it); the
  // window shows the composer there, so it is that much taller than the sheet itself.
  const composerReservation = useSessionCockpitComposerBottomChromeHeight();
  // The sheet rises from the bottom edge on Ask; reduced motion presents it in place.
  const rise = useSharedValue(raised ? 0 : 1);
  React.useEffect(() => {
    if (!raised) {
      rise.value = 1;
      return;
    }
    rise.value = reducedMotion
      ? 0
      : withTiming(0, {
          duration: reanimatedMotionTokens.durationMs.base,
          easing: reanimatedMotionTokens.easing.standard,
        });
  }, [raised, reducedMotion, rise]);

  // Android Back closes the raised sheet first (the draft stays), before it leaves the page.
  const close = sheet?.close;
  // A retained Session the phone is not showing leaves Back to the one on screen.
  const focus = useDestinationFocusSignal();
  React.useEffect(() => {
    if (!raised || !close || Platform.OS === 'web') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!focus.get()) return false;
      close();
      return true;
    });
    return () => subscription.remove();
  }, [close, focus, raised]);

  const report = React.useCallback(
    (geometry: PhoneAskSheetGeometry) => {
      sheetHeight.value = geometry.height;
      setLift(() => geometry.lift);
    },
    [sheetHeight],
  );
  const onLayerLayout = React.useCallback((event: LayoutChangeEvent) => {
    setLayerHeight(event.nativeEvent.layout.height);
  }, []);

  const windowStyle = useAnimatedStyle(() => {
    // Every key is written in both presentations: a key an animated style stops returning keeps its last value.
    if (!raised) return { height: layerHeight, transform: [{ translateY: 0 }] };
    const height = sheetHeight.value + (lift ? lift.value : 0) + composerReservation;
    return { height, transform: [{ translateY: rise.value * height }] };
  }, [composerReservation, layerHeight, lift, raised]);

  return (
    <PhoneAskSheetFrameReportContext.Provider value={report}>
      <View
        style={[
          RNStyleSheet.absoluteFill,
          raised ? null : { backgroundColor: navigationTheme.colors.background },
        ]}
        pointerEvents="box-none"
        onLayout={onLayerLayout}
      >
        {/* The page above the sheet stays in view; touching it closes the sheet with the draft kept. */}
        {raised ? (
          <Pressable
            testID="phone-ask-sheet.outside"
            style={RNStyleSheet.absoluteFill}
            onPress={sheet?.close}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
        ) : null}
        <Animated.View
          testID={raised ? 'phone-ask-sheet' : undefined}
          style={[
            raised ? styles.window : RNStyleSheet.absoluteFill,
            raised
              ? {
                  backgroundColor: theme.colors.surface.base,
                  ...resolveThemeSurfaceBorderStyle({
                    borderColor: theme.colors.border.modal,
                    edge: resolveThemeRaisedEdge(theme, 'modal'),
                    rim: surfaceUsesRim('floating', theme.dark),
                  }),
                }
              : null,
            windowStyle,
          ]}
          pointerEvents="box-none"
        >
          {/* Full size, bottom-anchored: the window shows the composer where the Session screen holds it. */}
          <View
            style={
              raised
                ? [styles.scene, { height: layerHeight }]
                : RNStyleSheet.absoluteFill
            }
          >
            {props.children}
          </View>
          {raised ? (
            <SurfaceRim
              role="floating"
              radius={theme.borderRadius.modalCard}
              border="modal"
            />
          ) : null}
        </Animated.View>
      </View>
    </PhoneAskSheetFrameReportContext.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  window: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    borderTopLeftRadius: theme.borderRadius.modalCard,
    borderTopRightRadius: theme.borderRadius.modalCard,
    borderBottomWidth: 0,
  },
  scene: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
}));
