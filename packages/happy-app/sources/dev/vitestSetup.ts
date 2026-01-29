import { beforeEach, vi } from 'vitest';

// `react-native` includes Flow syntax. Even with Vite aliases, some dependencies still
// resolve it via Node's CJS loader, so we mock it explicitly here as well.
vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
    Dimensions: { get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }) },
    Platform: { OS: 'node', select: (x: any) => x?.default },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    InteractionManager: { runAfterInteractions: (fn: () => void) => fn() },
    StyleSheet: { create: (styles: any) => styles },
    useWindowDimensions: () => ({ width: 800, height: 600 }),
    processColor: (value: any) => value,
}));

// Vitest runs in Node; `react-native-mmkv` depends on React Native internals and can fail to parse.
// Provide a minimal in-memory implementation for tests.
const store = new Map<string, string>();

beforeEach(() => {
    store.clear();
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

// Many UI components depend on `@expo/vector-icons`, but the package's internal entrypoints
// are not reliably resolvable in Vitest's node environment. Provide a minimal stub for tests.
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
    AntDesign: 'AntDesign',
    MaterialIcons: 'MaterialIcons',
}));

// `expo-constants` reads React Native `NativeModules` and isn't safe to import in Vitest.
vi.mock('expo-constants', () => ({
    default: {
        statusBarHeight: 0,
        expoConfig: { extra: {} },
        manifest: null,
        manifest2: null,
    },
}));

// `react-native-unistyles` requires a Babel plugin at runtime which isn't present in Vitest.
// Provide a lightweight mock so view/components can render in tests.
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            surface: '#fff',
            text: '#000',
            textSecondary: '#666',
            box: { error: { background: '#fee', border: '#f99', text: '#900' } },
            permissionButton: {
                allow: { background: '#0f0' },
                deny: { background: '#f00' },
                allowAll: { background: '#00f' },
            },
        },
    };

    return {
        StyleSheet: {
            create: (styles: any) => (typeof styles === 'function' ? styles(theme) : styles),
            configure: () => {},
        },
        useUnistyles: () => ({ theme }),
        UnistylesRuntime: { setRootViewBackgroundColor: () => {} },
    };
});
