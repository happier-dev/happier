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
export const TouchableWithoutFeedback = 'TouchableWithoutFeedback' as any;
export const RefreshControl = 'RefreshControl' as any;
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
export const Linking = {
    canOpenURL: async () => true,
    openURL: async () => {},
} as const;
function flattenStyle(style: any): any {
    if (style == null) return style;
    if (Array.isArray(style)) {
        return style.reduce((acc, entry) => ({ ...acc, ...(flattenStyle(entry) ?? {}) }), {});
    }
    if (typeof style === 'number') return {};
    if (typeof style === 'object') return style;
    return {};
}
export const StyleSheet = { create: (styles: any) => styles, flatten: flattenStyle } as const;
// Many components spread this object into style definitions.
(StyleSheet as any).absoluteFillObject = {};
export const TurboModuleRegistry = { getEnforcing: () => ({}) } as const;
export const registerCallableModule = () => {};

class AnimatedValue {
    // Minimal stub for tests. Consumers generally call `interpolate` and pass the object through.
    constructor(public _value: number) { }
    interpolate() {
        return this as any;
    }
}

export const Animated = {
    Value: AnimatedValue as any,
    timing: (_value: any, _config: any) => ({
        start: (cb?: any) => {
            cb?.();
        },
    }),
    View: 'Animated.View' as any,
} as const;

export function useWindowDimensions() {
    return { width: 800, height: 600 };
}

export const findNodeHandle = () => null;

export function processColor(value: any) {
    return value as any;
}
