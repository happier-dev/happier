import { createReanimatedModuleMock, type ReanimatedSharedValue } from './testkit/mocks/reanimated';

type ReanimatedModuleMock = ReturnType<typeof createReanimatedModuleMock>;

const mock = createReanimatedModuleMock() as ReanimatedModuleMock;

export type SharedValue<T> = ReanimatedSharedValue<T>;

export default mock.default;
export const View = mock.View;
export const ScrollView = mock.ScrollView;
export const Text = mock.Text;
export const createAnimatedComponent = mock.createAnimatedComponent;
export const cancelAnimation = mock.cancelAnimation;
export const runOnJS = mock.runOnJS;
export const runOnUI = mock.runOnUI;
export const useAnimatedProps = mock.useAnimatedProps;
export const useAnimatedReaction = mock.useAnimatedReaction;
export const useAnimatedStyle = mock.useAnimatedStyle;
export const useDerivedValue = mock.useDerivedValue;
export const useSharedValue = mock.useSharedValue;
export const withRepeat = mock.withRepeat;
export const withSpring = mock.withSpring;
export const withTiming = mock.withTiming;
export const Easing = mock.Easing;
export const interpolate = mock.interpolate;
export const interpolateColor = mock.interpolateColor;
