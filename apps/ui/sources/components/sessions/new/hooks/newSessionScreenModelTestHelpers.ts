import { vi } from 'vitest';

type NewSessionScreenModelModuleFactory = () => unknown | Promise<unknown>;
type NewSessionScreenModelImportOriginal = <T = unknown>() => Promise<T>;
type NewSessionScreenModelStorageModuleFactory = (
    importOriginal: NewSessionScreenModelImportOriginal,
) => unknown | Promise<unknown>;

type ExpoRouterParams = Record<string, string | string[] | undefined>;
type ExpoRouterParamsInput = ExpoRouterParams | (() => ExpoRouterParams);
type ExpoRouterPathnameInput = string | (() => string);
type ExpoRouterSegmentsInput = string[] | (() => string[]);

type ExpoRouterMockConfig = Readonly<{
    pathname?: ExpoRouterPathnameInput;
    params?: ExpoRouterParamsInput;
    segments?: ExpoRouterSegmentsInput;
    navigation?: unknown;
    router?: Partial<{
        push: (value: unknown) => unknown;
        navigate: (value: unknown, options?: unknown) => unknown;
        back: () => unknown;
        replace: (value: unknown) => unknown;
        setParams: (value: ExpoRouterParams) => unknown;
        canGoBack: () => boolean;
    }>;
}>;

type InstallNewSessionScreenModelCommonModuleMocksOptions = Readonly<{
    reactNative?: NewSessionScreenModelModuleFactory;
    unistyles?: NewSessionScreenModelModuleFactory;
    text?: NewSessionScreenModelModuleFactory;
    modal?: NewSessionScreenModelModuleFactory;
    // Prefer `routerConfig`. This exists for legacy suites but is not robust when Vitest caches
    // module graphs across files.
    router?: NewSessionScreenModelModuleFactory;
    routerConfig?: ExpoRouterMockConfig;
    storage?: NewSessionScreenModelStorageModuleFactory;
}>;

function resolveParamsInput(params: ExpoRouterParamsInput | undefined): ExpoRouterParams {
    const resolved = typeof params === 'function' ? params() : params;
    return { ...(resolved ?? {}) };
}

function resolveSegmentsInput(segments: ExpoRouterSegmentsInput | undefined): string[] {
    const resolved = typeof segments === 'function' ? segments() : segments;
    return [...(resolved ?? [])];
}

function resolvePathnameInput(pathname: ExpoRouterPathnameInput | undefined): string {
    const resolved = typeof pathname === 'function' ? pathname() : pathname;
    return resolved ?? '/';
}

const newSessionScreenModelModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as NewSessionScreenModelModuleFactory | undefined,
        unistyles: undefined as NewSessionScreenModelModuleFactory | undefined,
        text: undefined as NewSessionScreenModelModuleFactory | undefined,
        modal: undefined as NewSessionScreenModelModuleFactory | undefined,
        router: undefined as NewSessionScreenModelModuleFactory | undefined,
        routerConfig: undefined as ExpoRouterMockConfig | undefined,
        storage: undefined as NewSessionScreenModelStorageModuleFactory | undefined,
    },
    routerParamsOverrides: {} as ExpoRouterParams,
}));

export function installNewSessionScreenModelCommonModuleMocks(
    options: InstallNewSessionScreenModelCommonModuleMocksOptions = {},
) {
    newSessionScreenModelModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        modal: options.modal,
        router: options.router,
        routerConfig: options.routerConfig,
        storage: options.storage,
    };
    newSessionScreenModelModuleState.routerParamsOverrides = {};

    vi.mock('react-native', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const routerState = newSessionScreenModelModuleState.options;

        const pushSpy = vi.fn<(value: unknown) => unknown>();
        const replaceSpy = vi.fn<(value: unknown) => unknown>();
        const backSpy = vi.fn<() => unknown>();
        const setParamsSpy = vi.fn<(value: ExpoRouterParams) => unknown>();

        const resolveConfig = () => routerState.routerConfig ?? {};
        const syncParams = () => {
            const cfg = resolveConfig();
            return {
                ...resolveParamsInput(cfg.params),
                ...newSessionScreenModelModuleState.routerParamsOverrides,
            };
        };

        const router = {
            push(value: unknown) {
                pushSpy(value);
                return resolveConfig().router?.push?.(value);
            },
            replace(value: unknown) {
                replaceSpy(value);
                return resolveConfig().router?.replace?.(value);
            },
            back() {
                backSpy();
                return resolveConfig().router?.back?.();
            },
            setParams(value: ExpoRouterParams) {
                setParamsSpy(value);
                newSessionScreenModelModuleState.routerParamsOverrides = {
                    ...newSessionScreenModelModuleState.routerParamsOverrides,
                    ...(value ?? {}),
                };
                return resolveConfig().router?.setParams?.(value);
            },
            canGoBack() {
                return resolveConfig().router?.canGoBack?.() ?? false;
            },
            navigate(value: unknown, opts?: unknown) {
                return resolveConfig().router?.navigate?.(value, opts);
            },
        };

        return {
            Redirect: (props: Record<string, unknown>) => null,
            Link: 'Link' as any,
            Stack: Object.assign(
                function Stack(props: { children?: unknown }) {
                    return props.children as any;
                },
                {
                    Screen: (_props: { options?: unknown }) => null,
                },
            ),
            useRouter: () => router,
            useNavigation: () => resolveConfig().navigation ?? null,
            useSegments: () => resolveSegmentsInput(resolveConfig().segments),
            usePathname: () => resolvePathnameInput(resolveConfig().pathname),
            useLocalSearchParams: () => syncParams(),
            useGlobalSearchParams: () => syncParams(),
            router,
        };
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
