import { afterEach, beforeEach, vi } from 'vitest';

import { installVitestRnShim } from './vitestRnShim';

const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return;
    }
    originalConsoleError(...args);
};

installVitestRnShim({ traceFile: process.env.VITEST_TRACE_LOAD ?? null });

// `react-native` includes Flow syntax. Even with Vite aliases, some dependencies still
// resolve it via Node's CJS loader, so we mock it explicitly here as well.
vi.mock('react-native', async () => await import('./reactNativeStub'));

// Vitest runs in Node; `react-native-mmkv` depends on React Native internals and can fail to parse.
// Provide a minimal in-memory implementation for tests.
const store = new Map<string, unknown>();

beforeEach(() => {
    store.clear();
});

afterEach(() => {
    // Many tests use `vi.stubGlobal('fetch', ...)` and other globals. Ensure they don't leak across
    // test files (Vitest workers may reuse the same global between sequential test files).
    vi.unstubAllGlobals();
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            const value = store.get(key);
            if (value == null) return undefined;
            return typeof value === 'string' ? value : undefined;
        }

        getNumber(key: string) {
            const value = store.get(key);
            if (value == null) return undefined;
            if (typeof value === 'number') return value;
            return undefined;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set(key: string, value: any) {
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

// `@shopify/react-native-skia` requires native bindings; stub it for node/Vitest.
vi.mock('@shopify/react-native-skia', () => ({
    Canvas: 'Canvas',
    Rect: 'Rect',
    Group: 'Group',
    Path: 'Path',
    RoundedRect: 'RoundedRect',
    DiffRect: 'DiffRect',
    Skia: {},
    rect: () => ({}),
    rrect: () => ({}),
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

// `expo-updates` is native-oriented and pulls in platform-specific modules that Node/Vitest can't parse.
vi.mock('expo-updates', () => ({
    checkForUpdateAsync: async () => ({ isAvailable: false }),
    fetchUpdateAsync: async () => {},
    reloadAsync: async () => {},
}));

// `expo-image` uses native view managers; stub it for Vitest.
vi.mock('expo-image', () => ({
    Image: 'Image',
}));

// `expo-secure-store` is native; stub its async API for token storage tests.
vi.mock('expo-secure-store', () => ({
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
}));

// `react-native-unistyles` requires a Babel plugin at runtime which isn't present in Vitest.
// Provide a lightweight mock so view/components can render in tests.
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            surface: '#fff',
            surfaceSelected: '#f2f2f2',
            divider: '#ddd',
            text: '#000',
            textSecondary: '#666',
            groupped: { sectionTitle: '#666', background: '#fff' },
            header: { background: '#fff', tint: '#000' },
            button: { primary: { tint: '#000' } },
            shadow: { color: '#000', opacity: 0.2 },
            switch: { track: { inactive: '#ccc', active: '#4ade80' }, thumb: { active: '#fff' } },
            input: { background: '#eee' },
            status: { error: '#ff3b30' },
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
