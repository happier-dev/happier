// Vitest/node stub for `react-native`.
// This avoids Vite trying to parse the real React Native entrypoint (Flow syntax).

// Provide basic host components so tests that rely on `react-test-renderer` can render trees
// without having to mock `react-native` in every file.
export const View = 'View' as any;
export const Text = 'Text' as any;
export const Image = 'Image' as any;
export const ScrollView = 'ScrollView' as any;
export const KeyboardAvoidingView = 'KeyboardAvoidingView' as any;
export const FlatList = 'FlatList' as any;
export const SectionList = 'SectionList' as any;
export const Pressable = 'Pressable' as any;
export const TouchableOpacity = 'TouchableOpacity' as any;
export const TextInput = 'TextInput' as any;
export const ActivityIndicator = 'ActivityIndicator' as any;
export const Switch = 'Switch' as any;
export const Touchable = { Mixin: {} } as any;
export const PanResponder = { create: () => ({ panHandlers: {} }) } as any;

export const Dimensions = {
    get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
} as const;

export const PixelRatio = {
    get: () => 2,
    getFontScale: () => 1,
    roundToNearestPixel: (value: number) => value,
} as const;

export const Platform = { OS: 'node', select: (x: any) => x?.default ?? x?.web ?? x?.ios ?? x?.android } as const;
export const AppState = { addEventListener: () => ({ remove: () => {} }) } as const;
export const InteractionManager = { runAfterInteractions: (fn: () => void) => fn() } as const;
export const StyleSheet = { create: (styles: any) => styles } as const;
export const TurboModuleRegistry = { getEnforcing: () => ({}) } as const;
export const registerCallableModule = () => {};

export function useWindowDimensions() {
    return { width: 800, height: 600 };
}

export const findNodeHandle = () => null;

export function processColor(value: any) {
    return value as any;
}
