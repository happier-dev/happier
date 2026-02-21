import { afterEach, beforeEach, vi } from 'vitest';

import { installVitestRnShim } from './vitestRnShim';

// UI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
process.env.HAPPIER_FEATURE_POLICY_ENV = '';

type StorageLike = Readonly<{
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    clear: () => void;
    key: (index: number) => string | null;
    readonly length: number;
}>;

function createMemoryStorage(backing: Map<string, string>): StorageLike {
    return {
        getItem: (key) => backing.get(String(key)) ?? null,
        setItem: (key, value) => {
            backing.set(String(key), String(value));
        },
        removeItem: (key) => {
            backing.delete(String(key));
        },
        clear: () => {
            backing.clear();
        },
        key: (index) => {
            const keys = Array.from(backing.keys());
            return typeof keys[index] === 'string' ? keys[index] : null;
        },
        get length() {
            return backing.size;
        },
    };
}

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
const localStorageBacking = new Map<string, string>();
const sessionStorageBacking = new Map<string, string>();

beforeEach(() => {
    // Some test files enable fake timers and forget to restore them. Force real timers at the start
    // of every test to avoid cross-test leakage (Vitest workers may execute multiple test files).
    vi.useRealTimers();

    store.clear();
    localStorageBacking.clear();
    sessionStorageBacking.clear();

    // Node 25 exposes an incomplete `localStorage` global behind an experimental flag and warns about
    // missing persistence paths. Our UI runtime expects the browser `Storage` shape, so provide a
    // stable in-memory implementation for tests.
    vi.stubGlobal('localStorage', createMemoryStorage(localStorageBacking) as unknown as Storage);
    vi.stubGlobal('sessionStorage', createMemoryStorage(sessionStorageBacking) as unknown as Storage);
});

afterEach(() => {
    // Ensure fake timers never leak across tests (even when a test fails mid-flight).
    vi.useRealTimers();

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

// `react-native-typography` relies on React Native's platform resolution (e.g. systemWeights.web.js),
// which Node/Vitest cannot resolve via CJS `require("../helpers/systemWeights")`. Provide a minimal
// stub so components can render without pulling in platform-specific internals.
vi.mock('react-native-typography', () => ({
    iOSUIKit: {
        title3: {},
        title3Object: {},
    },
    human: {},
    humanDense: {},
    humanTall: {},
    material: {},
    materialDense: {},
    materialTall: {},
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
    // Keep this theme self-contained: many unit tests mock `react-native` and may omit Platform,
    // so importing the real theme (which depends on Platform.select) would make those tests flaky.
    const theme = {
        dark: false,
        colors: {
            //
            // Main colors
            //
            text: '#000000',
            textSecondary: '#666666',
            textLink: '#2BACCC',
            textDestructive: '#FF3B30',
            warning: '#8E8E93',
            success: '#34C759',
            accent: {
                blue: '#007AFF',
                green: '#34C759',
                orange: '#FF9500',
                yellow: '#FFCC00',
                red: '#FF3B30',
                indigo: '#5856D6',
                purple: '#AF52DE',
            },
            surface: '#ffffff',
            surfaceRipple: 'rgba(0, 0, 0, 0.08)',
            surfacePressed: '#f0f0f2',
            surfaceSelected: '#f2f2f2',
            surfaceHigh: '#F8F8F8',
            surfaceHighest: '#f0f0f0',
            divider: '#eaeaea',
            shadow: { color: '#000000', opacity: 0.1 },

            //
            // System components
            //
            groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
            header: { background: '#ffffff', tint: '#18171C' },
            switch: { track: { inactive: '#dddddd', active: '#34C759' }, thumb: { active: '#FFFFFF', inactive: '#767577' } },
            radio: { active: '#007AFF', inactive: '#C0C0C0', dot: '#007AFF' },
            modal: { border: 'rgba(0, 0, 0, 0.1)' },
            button: {
                primary: { background: '#000000', tint: '#FFFFFF', disabled: '#C0C0C0' },
                secondary: { tint: '#666666', surface: '#ffffff' },
            },
            input: { background: '#F5F5F5', text: '#000000', placeholder: '#999999' },

            //
            // Status / boxes
            //
            status: { error: '#ff3b30', connected: '#34C759', connecting: '#FFCC00', disconnected: '#999999', default: '#999999' },
            box: {
                error: { background: '#fee', border: '#f99', text: '#900' },
                warning: { background: '#fff7e6', border: '#ffd591', text: '#ad6800' },
            },

            //
            // Permission buttons
            //
            permissionButton: {
                allow: { background: '#34C759' },
                deny: { background: '#FF3B30' },
                allowAll: { background: '#007AFF' },
                inactive: { background: '#dddddd' },
            },

            //
            // Diff view palette (used by tool renderers)
            //
            diff: {
                addedBg: '#e6ffed',
                addedBorder: '#b7eb8f',
                addedText: '#135200',
                removedBg: '#ffecec',
                removedBorder: '#ffa39e',
                removedText: '#a8071a',
                hunkHeaderBg: '#f5f5f5',
                hunkHeaderText: '#666',
                contextText: '#333',
            },
        },
    };

    return {
        StyleSheet: {
            create: (styles: any) => (typeof styles === 'function' ? styles(theme) : styles),
            configure: () => {},
            absoluteFillObject: {},
        },
        useUnistyles: () => ({ theme }),
        UnistylesRuntime: {
            setRootViewBackgroundColor: () => {},
            setAdaptiveThemes: () => {},
            setTheme: () => {},
        },
    };
});
