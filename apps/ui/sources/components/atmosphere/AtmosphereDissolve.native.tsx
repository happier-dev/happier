import * as React from 'react';
import { Animated, PixelRatio, View } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import Reanimated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { AtmosphereDissolveProps } from './atmosphereDissolve.types';
import { orderedDissolve } from './orderedDissolve';
import { renderNativeOrderedMask } from './renderBackdrop.native';

/**
 * Native arrival/reduced departure fade on the native driver. Normal send moves the exact web
 * ordered mask in whole lattice steps on Reanimated, then releases it. No per-frame JS/pixel work.
 */
export function AtmosphereDissolve(props: AtmosphereDissolveProps) {
  const [opacity] = React.useState(
    () => new Animated.Value(props.visible ? 1 : 0),
  );
  const onHidden = React.useRef(props.onHidden);
  onHidden.current = props.onHidden;
  const shown = React.useRef(props.visible);
  const { visible, leave, reducedMotion } = props;
  // Read only at the arrival it describes: changing it alone starts nothing.
  const arrive = React.useRef(props.arrive);
  arrive.current = props.arrive;
  const [width, setWidth] = React.useState(0);
  const [maskUri, setMaskUri] = React.useState<string | null>(null);
  const [maskReady, setMaskReady] = React.useState(false);
  const [climbing, setClimbing] = React.useState(false);
  const [maskError, setMaskError] = React.useState<unknown>(null);
  const dpr = PixelRatio.get();
  const dissolve = React.useMemo(() => orderedDissolve(props.height, dpr), [props.height, dpr]);
  const progress = useSharedValue(0);
  const active = React.useRef(false);
  const maskStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -Math.floor(progress.value * dissolve.steps) * dissolve.mask.period }] }));
  React.useEffect(() => {
    if (width <= 0 || props.height <= 0 || reducedMotion || leave !== 'climb') return;
    let live = true;
    setMaskUri(null);
    setMaskReady(false);
    void renderNativeOrderedMask(width, dissolve.mask.cssHeight, dissolve.from, dissolve.to, dpr).then(uri => { if (live) setMaskUri(uri); }, error => { if (live) setMaskError(error); });
    return () => { live = false; };
  }, [width, props.height, reducedMotion, leave, dissolve, dpr]);
  const finishClimb = React.useCallback(() => { active.current = false; opacity.setValue(0); setClimbing(false); onHidden.current?.(); }, [opacity]);
  React.useEffect(() => {
    if (shown.current === visible && !active.current) return;
    if (!visible && !reducedMotion && leave === 'climb' && props.height > 0 && !maskReady) return;
    shown.current = visible;
    active.current = true;
    cancelAnimation(progress);
    if (!visible && !reducedMotion && leave === 'climb' && props.height > 0) {
      progress.value = 0; setClimbing(true);
      progress.value = withTiming(1, { duration: motionTokens.atmosphere.sendDissolveMs, easing: Easing.linear }, finished => { if (finished) runOnJS(finishClimb)(); });
      return () => cancelAnimation(progress);
    }
    setClimbing(false);
    if (visible && arrive.current === 'instant') {
      active.current = false;
      opacity.setValue(1);
      return;
    }
    const timing = motionTokens.atmosphere;
    const duration = reducedMotion
      ? timing.reducedCrossFadeMs
      : visible
        ? timing.readyFadeMs
        : leave === 'fade'
          ? timing.leaveFadeMs
          : timing.sendDissolveMs;
    const animation = Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration,
      easing: visible ? motionTokens.easing.standard : motionTokens.easing.exit,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) { active.current = false; if (!visible) onHidden.current?.(); }
    });
    return () => animation.stop();
  }, [leave, opacity, reducedMotion, visible, maskReady, props.height, progress, finishClimb]);
  if (maskError) throw maskError;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[props.style, { opacity }]}
      onLayout={event => setWidth(event.nativeEvent.layout.width)}
    >
      {/* Hardware (the default), never "software": RNCMaskedView re-applies its layer type on every draw,
          and a software layer invalidates on each re-apply, so the atmosphere redrew ~60 frames/s at rest.
          The Skia canvases inside are TextureViews, which also cannot draw into a software layer. */}
      <MaskedView style={{ width: '100%', height: props.height }} maskElement={<View style={{ width, height: props.height }}>
        <View style={{ position: 'absolute', left: 0, top: 0, width, height: props.height, backgroundColor: '#000', opacity: climbing ? 0 : 1 }} />
        {maskUri ? <Reanimated.Image source={{ uri: maskUri }} resizeMode="stretch" onLoad={() => setMaskReady(true)} style={[{ width, height: dissolve.mask.cssHeight }, maskStyle]} /> : null}
      </View>}>
        {props.children}
      </MaskedView>
    </Animated.View>
  );
}
