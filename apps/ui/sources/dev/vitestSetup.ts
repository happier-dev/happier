import { afterAll, afterEach, beforeEach, vi } from 'vitest';

import { installVitestRnShim } from './vitestRnShim';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { standardCleanup } from './testkit/cleanup/standardCleanup';

// UI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
process.env.HAPPIER_FEATURE_POLICY_ENV = '';

// Some browser-oriented libraries (e.g. xterm add-ons) ship UMD bundles that expect a `self` global.
// Define it up-front so Vitest can import those modules in Node without crashing during module eval.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
if (!Object.prototype.hasOwnProperty.call(g, '__DEV__')) {
    g.__DEV__ = true;
}

if (!Object.prototype.hasOwnProperty.call(g, 'self') || g.self == null) {
    try {
        Object.defineProperty(g, 'self', {
            value: g,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    } catch {
        g.self = g;
    }
}

const ORIGINAL_WINDOW = (globalThis as any).window;
const ORIGINAL_DOCUMENT = (globalThis as any).document;
const ORIGINAL_NAVIGATOR = (globalThis as any).navigator;
const ORIGINAL_SELF = (globalThis as any).self;
const ORIGINAL_WINDOW_DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis as any, 'window');
const ORIGINAL_DOCUMENT_DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis as any, 'document');
const ORIGINAL_NAVIGATOR_DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis as any, 'navigator');
const ORIGINAL_SELF_DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis as any, 'self');
const HAD_WINDOW = Object.prototype.hasOwnProperty.call(globalThis as any, 'window');
const HAD_DOCUMENT = Object.prototype.hasOwnProperty.call(globalThis as any, 'document');
const HAD_NAVIGATOR = Object.prototype.hasOwnProperty.call(globalThis as any, 'navigator');
const HAD_SELF = Object.prototype.hasOwnProperty.call(globalThis as any, 'self');

function restoreDomGlobalsToOriginal(): void {
    const g = globalThis as any;

    const restore = (key: 'window' | 'document' | 'navigator' | 'self', had: boolean, value: unknown) => {
        if (had) {
            try {
                g[key] = value;
            } catch {
                const originalDescriptor =
                    key === 'window'
                        ? ORIGINAL_WINDOW_DESCRIPTOR
                        : key === 'document'
                            ? ORIGINAL_DOCUMENT_DESCRIPTOR
                            : key === 'navigator'
                                ? ORIGINAL_NAVIGATOR_DESCRIPTOR
                                : ORIGINAL_SELF_DESCRIPTOR;
                if (originalDescriptor?.configurable) {
                    // Node can expose DOM-like globals (e.g. navigator) as accessor-only properties.
                    // Re-define them as data properties for test determinism.
                    Object.defineProperty(g, key, {
                        value,
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    });
                }
            }
            return;
        }
        try {
            delete g[key];
        } catch {
            g[key] = undefined;
        }
    };

    restore('window', HAD_WINDOW, ORIGINAL_WINDOW);
    restore('document', HAD_DOCUMENT, ORIGINAL_DOCUMENT);
    restore('navigator', HAD_NAVIGATOR, ORIGINAL_NAVIGATOR);
    restore('self', HAD_SELF, ORIGINAL_SELF);
}

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

function maybeLogActiveHandles(tag: string): void {
    if (process.env.HAPPIER_VITEST_DEBUG_ACTIVE_HANDLES !== '1') return;
    dumpActiveHandlesAlways(tag, process.env.HAPPIER_VITEST_DEBUG_ACTIVE_HANDLES_VERBOSE === '1');
}

function dumpActiveHandlesAlways(tag: string, verbose: boolean): void {
    const anyProcess = process as any;
    if (typeof anyProcess._getActiveHandles !== 'function') return;
    const handles: unknown[] = anyProcess._getActiveHandles();
    const counts = new Map<string, number>();
    for (const handle of handles) {
        const name =
            typeof handle === 'object' && handle && (handle as any).constructor && typeof (handle as any).constructor.name === 'string'
                ? (handle as any).constructor.name
                : typeof handle;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const summary = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}:${count}`)
        .join(', ');
    const stdinPaused = typeof (process.stdin as any)?.isPaused === 'function' ? (process.stdin as any).isPaused() : null;
    const stdinDataListeners = typeof (process.stdin as any)?.listenerCount === 'function'
        ? (process.stdin as any).listenerCount('data')
        : null;
    originalConsoleError(
        `[vitest] active handles (${tag}): ${summary || '<none>'}` +
        `${stdinPaused == null ? '' : `, stdinPaused=${stdinPaused}`}` +
        `${stdinDataListeners == null ? '' : `, stdinDataListeners=${stdinDataListeners}`}`,
    );

    if (!verbose) return;

    const allowlisted = new Set(['Pipe', 'Socket']);
    const suspicious = handles
        .map((handle) => {
            const name =
                typeof handle === 'object' && handle && (handle as any).constructor && typeof (handle as any).constructor.name === 'string'
                    ? (handle as any).constructor.name
                    : typeof handle;
            return { name, handle };
        })
        .filter(({ name }) => !allowlisted.has(name));

    if (suspicious.length === 0) return;

    const details = suspicious.slice(0, 5).map(({ name, handle }) => {
        if (name === 'TLSSocket' || name === 'Socket') {
            const anyHandle = handle as any;
            const remote = typeof anyHandle.remoteAddress === 'string'
                ? `${anyHandle.remoteAddress}${typeof anyHandle.remotePort === 'number' ? `:${anyHandle.remotePort}` : ''}`
                : null;
            const servername = typeof anyHandle.servername === 'string' ? anyHandle.servername : null;
            return `${name}(${[remote ? `remote=${remote}` : null, servername ? `servername=${servername}` : null].filter(Boolean).join(',') || 'n/a'})`;
        }
        return name;
    }).join(', ');

    originalConsoleError(`[vitest] active handles details (${tag}): ${details}${suspicious.length > 5 ? ` (+${suspicious.length - 5} more)` : ''}`);
}

function pauseStdinForTests(): void {
    try {
        const stdin = process.stdin as any;
        if (stdin && typeof stdin.pause === 'function') {
            stdin.pause();
        }
        if (stdin && typeof stdin.removeAllListeners === 'function') {
            stdin.removeAllListeners('data');
            stdin.removeAllListeners('readable');
        }
        if (stdin && typeof stdin.unref === 'function') {
            stdin.unref();
        }
    } catch {
        // ignore
    }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`[vitest] timed out after ${ms}ms: ${label}`));
            }, ms);
        });
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId != null) {
            clearTimeout(timeoutId);
        }
    }
}

async function dumpWhyIsNodeRunning(tag: string): Promise<void> {
    if (process.env.HAPPIER_VITEST_DEBUG_WHY_NODE_RUNNING !== '1') return;
    try {
        const mod = await import('why-is-node-running');
        const whyIsNodeRunning = (mod as unknown as { default?: unknown }).default ?? mod;
        if (typeof whyIsNodeRunning !== 'function') return;
        originalConsoleError(`[vitest] why-is-node-running dump (${tag})`);
        whyIsNodeRunning();
    } catch {
        // ignore
    }
}

async function closeUndiciGlobalDispatcherForTests(): Promise<void> {
    try {
        const undici = await import('undici');
        const getGlobalDispatcher = (undici as unknown as { getGlobalDispatcher?: () => unknown }).getGlobalDispatcher;
        if (typeof getGlobalDispatcher !== 'function') return;
        const dispatcher = getGlobalDispatcher() as unknown as {
            close?: () => Promise<void> | void;
            destroy?: () => Promise<void> | void;
        } | null;
        if (!dispatcher) return;
        if (typeof dispatcher.close === 'function') {
            await dispatcher.close();
            return;
        }
        if (typeof dispatcher.destroy === 'function') {
            await dispatcher.destroy();
        }
    } catch {
        // ignore (undici may not be available in some runtimes)
    }
}

if (process.env.HAPPIER_VITEST_ENABLE_SIGNAL_DUMP === '1') {
    // NOTE: Node uses SIGUSR1 to toggle the inspector, so use SIGUSR2 for our own dumps.
    process.on('SIGUSR2', () => {
        dumpActiveHandlesAlways('SIGUSR2', true);
        void dumpWhyIsNodeRunning('SIGUSR2');
    });
}

installVitestRnShim({ traceFile: process.env.VITEST_TRACE_LOAD ?? null });

// `react-native` includes Flow syntax. Even with Vite aliases, some dependencies still
// resolve it via Node's CJS loader, so we mock it explicitly here as well.
vi.mock('react-native', async () => await import('./reactNativeStub'));

// Vitest runs in Node; `react-native-mmkv` depends on React Native internals and can fail to parse.
// Provide a minimal in-memory implementation for tests.
const store = new Map<string, unknown>();
const localStorageBacking = new Map<string, string>();
const sessionStorageBacking = new Map<string, string>();

vi.mock('expo-notifications', async () => await import('./expoNotificationsStub'));

beforeEach(() => {
    // Some test files enable fake timers and forget to restore them. Force real timers at the start
    // of every test to avoid cross-test leakage (Vitest workers may execute multiple test files).
    vi.useRealTimers();

    // Many UI tests intentionally fake DOM globals by assigning directly to `globalThis.window` /
    // `globalThis.document` without using `vi.stubGlobal`. Reset them to the original node runtime
    // shape before each test so server seeding/runtime heuristics stay deterministic.
    restoreDomGlobalsToOriginal();

    store.clear();
    localStorageBacking.clear();
    sessionStorageBacking.clear();

    // Node 25 exposes an incomplete `localStorage` global behind an experimental flag and warns about
    // missing persistence paths. Our UI runtime expects the browser `Storage` shape, so provide a
    // stable in-memory implementation for tests.
    vi.stubGlobal('localStorage', createMemoryStorage(localStorageBacking) as unknown as Storage);
    vi.stubGlobal('sessionStorage', createMemoryStorage(sessionStorageBacking) as unknown as Storage);

    if (process.env.HAPPIER_VITEST_FORBID_FETCH === '1') {
        vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input && typeof (input as Request).url === 'string'
                            ? (input as Request).url
                            : String(input);
            const method = String(init?.method ?? 'GET').toUpperCase();
            throw new Error(`[vitest] unexpected fetch: ${method} ${url}`);
        }) as unknown as typeof fetch);
    }
});

afterEach(() => {
    // Ensure fake timers never leak across tests (even when a test fails mid-flight).
    vi.useRealTimers();

    // Ensure mounted React test renderers never leak across tests. This is important for fork-based
    // Vitest runs: a single test file leaking an interval/subscription can prevent the fork from
    // exiting and hang the suite.
    standardCleanup();

    // Tests may override `runtimeFetch` via `setRuntimeFetch(...)`. Reset it after each test to
    // prevent cross-test pollution (module state can persist across files in the same Vitest fork).
    resetRuntimeFetch();

    // Many tests use `vi.stubGlobal('fetch', ...)` and other globals. Ensure they don't leak across
    // test files (Vitest workers may reuse the same global between sequential test files).
    vi.unstubAllGlobals();

    pauseStdinForTests();

    restoreDomGlobalsToOriginal();
});

afterAll(async () => {
    maybeLogActiveHandles('before afterAll cleanup');

    const cleanupTimeoutMsRaw = Number.parseInt(process.env.HAPPIER_VITEST_AFTERALL_CLEANUP_TIMEOUT_MS ?? '', 10);
    const cleanupTimeoutMs = Number.isFinite(cleanupTimeoutMsRaw) && cleanupTimeoutMsRaw > 0 ? cleanupTimeoutMsRaw : 30_000;
    const debugCleanup = process.env.HAPPIER_VITEST_DEBUG_AFTERALL_CLEANUP === '1';

    // Endpoint supervisors can start background timers and keep the Vitest fork alive even after all tests finish.
    // Stop them before resetting reachability supervisors so the process can exit cleanly.
    const endpointSupervisorMod = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    if (debugCleanup) originalConsoleError('[vitest] afterAll cleanup: resetEndpointSupervisorPoolForTests (start)');
    try {
        await withTimeout(
            endpointSupervisorMod.resetEndpointSupervisorPoolForTests(),
            cleanupTimeoutMs,
            'resetEndpointSupervisorPoolForTests',
        );
    } finally {
        if (debugCleanup) originalConsoleError('[vitest] afterAll cleanup: resetEndpointSupervisorPoolForTests (end)');
    }

    maybeLogActiveHandles('after resetEndpointSupervisorPoolForTests');

    // `serverFetch(...)` can start background server reachability supervisors. Ensure they are
    // fully stopped at the end of the test run so the Vitest fork can exit cleanly.
    //
    // IMPORTANT: this must be awaited. Background retry timers inside the connection supervisor keep the
    // fork process alive, which can otherwise hang the suite after the last test file completes.
    const mod = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    if (debugCleanup) originalConsoleError('[vitest] afterAll cleanup: resetServerReachabilitySupervisors (start)');
    try {
        await withTimeout(mod.resetServerReachabilitySupervisors(), cleanupTimeoutMs, 'resetServerReachabilitySupervisors');
    } finally {
        if (debugCleanup) originalConsoleError('[vitest] afterAll cleanup: resetServerReachabilitySupervisors (end)');
    }

    maybeLogActiveHandles('after resetServerReachabilitySupervisors');

    if (debugCleanup) originalConsoleError('[vitest] afterAll cleanup: closeUndiciGlobalDispatcherForTests (start)');
    try {
        await withTimeout(closeUndiciGlobalDispatcherForTests(), cleanupTimeoutMs, 'closeUndiciGlobalDispatcherForTests');
    } finally {
        if (debugCleanup) originalConsoleError('[vitest] afterAll cleanup: closeUndiciGlobalDispatcherForTests (end)');
    }

    maybeLogActiveHandles('after closeUndiciGlobalDispatcherForTests');

    pauseStdinForTests();

    maybeLogActiveHandles('after pauseStdinForTests');

    await dumpWhyIsNodeRunning('afterAll');
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

// `react-native-reanimated` requires native bindings; provide a lightweight mock for node/Vitest.
vi.mock('react-native-reanimated', () => {
    type SharedValue<T> = { value: T };

    const useSharedValue = <T,>(initial: T): SharedValue<T> => ({ value: initial });
    const useDerivedValue = <T,>(factory: () => T): SharedValue<T> => ({ value: factory() });

    const runOnJS = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;
    const runOnUI = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;

    const useAnimatedStyle = <T,>(factory: () => T): T => factory();
    const useAnimatedProps = <T,>(factory: () => T): T => factory();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const useAnimatedReaction = (prepare: () => any, react: (value: any, previous: any) => void) => {
        try {
            const value = prepare();
            react(value, undefined);
        } catch {
            // ignore
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withTiming = (value: any) => value;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withSpring = (value: any) => value;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withRepeat = (value: any) => value;
    const cancelAnimation = () => {};

    const Animated = {
        View: 'Animated.View',
        ScrollView: 'Animated.ScrollView',
        Text: 'Animated.Text',
        createAnimatedComponent: (component: unknown) => component,
    } as const;

    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        cancelAnimation,
        runOnJS,
        runOnUI,
        useAnimatedProps,
        useAnimatedReaction,
        useAnimatedStyle,
        useDerivedValue,
        useSharedValue,
        withRepeat,
        withSpring,
        withTiming,
    };
});

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

// `expo-modules-core` is the shared native bridge used by Expo packages and can resolve into TS
// source entrypoints that Vitest cannot transform safely under Node.
vi.mock('expo-modules-core', async () => await import('./expoModulesCoreStub'));

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

// FlashList v2 depends on React Native new architecture internals that do not exist in node/Vitest.
// Most unit tests only need a stable host component shape.
vi.mock('@shopify/flash-list', () => ({
    FlashList: 'FlashList',
}));
vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () => {
    const flashListModule = await import('@shopify/flash-list');
    return {
        FlashList: flashListModule.FlashList,
        flashListRuntime: {
            Component: flashListModule.FlashList,
            usingFallback: false,
            reason: null,
        },
    };
});

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
            shadowLevels: Array.from({ length: 6 }, (_value, idx) => ({
                boxShadow: '0 0 0 rgba(0, 0, 0, 0)',
                shadowColor: '#000000',
                shadowOffset: { width: 0, height: idx },
                shadowOpacity: 0.1,
                shadowRadius: idx,
                elevation: idx,
            })),
            shadowPopoverArrowBoxShadow: '0 0 0 rgba(0, 0, 0, 0)',
            overlay: {
                scrim: 'rgba(0, 0, 0, 0.45)',
                scrimStrong: 'rgba(0, 0, 0, 0.6)',
                text: '#FFFFFF',
                textSecondary: 'rgba(255, 255, 255, 0.9)',
            },

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
