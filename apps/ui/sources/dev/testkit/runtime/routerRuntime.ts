import * as React from 'react';

export type ExpoRouterParams = Record<string, string | string[] | undefined>;
export type ExpoRouterParamsInput = ExpoRouterParams | (() => ExpoRouterParams);
export type ExpoRouterPathnameInput = string | (() => string);
export type ExpoRouterSegmentsInput = string[] | (() => string[]);

export type StackScreenOptions = Readonly<Record<string, unknown>>;
export type StackScreenOptionsInput = StackScreenOptions | (() => StackScreenOptions);

export type StackOptionsCapture = Readonly<{
    record: (options: StackScreenOptionsInput) => void;
    reset: () => void;
    getRaw: () => StackScreenOptionsInput | null;
    getResolved: () => StackScreenOptions | null;
}>;

export type ExpoRouterRuntimeOptions = Readonly<{
    pathname?: ExpoRouterPathnameInput;
    params?: ExpoRouterParamsInput;
    segments?: ExpoRouterSegmentsInput;
    navigation?: unknown;
    router?: Partial<{
        push: (value: unknown) => unknown;
        navigate: (value: unknown, options?: unknown) => unknown;
        back: () => unknown;
        replace: (value: unknown) => unknown;
        dismissTo: (value: unknown) => unknown;
        dismissAll: () => unknown;
        setParams: (value: ExpoRouterParams) => unknown;
        canGoBack: () => boolean;
        canDismiss: () => boolean;
    }>;
    stackOptionsCapture?: StackOptionsCapture;
}>;

type ExpoRouterRuntimeRouter = {
    push: (value: unknown) => unknown;
    navigate?: (value: unknown, options?: unknown) => unknown;
    back: () => unknown;
    replace: (value: unknown) => unknown;
    dismissTo: (value: unknown) => unknown;
    dismissAll: () => unknown;
    setParams: (value: ExpoRouterParams) => unknown;
    canGoBack?: () => boolean;
    canDismiss?: () => boolean;
};

type RouterMethod<TArgs extends unknown[], TResult> = (...args: TArgs) => TResult;
type TrackedRouterMethod<TArgs extends unknown[], TResult> = RouterMethod<TArgs, TResult> & {
    mockName?: (name: string) => unknown;
};

export type ExpoRouterRuntimeAdapters = Readonly<{
    createTrackedMethod?: <TArgs extends unknown[], TResult>(
        implementation?: RouterMethod<TArgs, TResult>,
    ) => TrackedRouterMethod<TArgs, TResult>;
    isTrackedMethod?: <TArgs extends unknown[], TResult>(
        value: RouterMethod<TArgs, TResult> | undefined,
    ) => value is TrackedRouterMethod<TArgs, TResult>;
}>;

function createRuntimeTrackedMethod<TArgs extends unknown[], TResult>(
    implementation?: RouterMethod<TArgs, TResult>,
): TrackedRouterMethod<TArgs, TResult> {
    return ((...args: TArgs) => implementation?.(...args)) as TrackedRouterMethod<TArgs, TResult>;
}

function createTrackedRouterMethod<TArgs extends unknown[], TResult>(
    providedMethod: RouterMethod<TArgs, TResult> | undefined,
    adapters: ExpoRouterRuntimeAdapters,
): {
    method: RouterMethod<TArgs, TResult>;
    spy: TrackedRouterMethod<TArgs, TResult>;
} {
    const createTrackedMethod = adapters.createTrackedMethod ?? createRuntimeTrackedMethod;

    if (!providedMethod) {
        const spy = createTrackedMethod<TArgs, TResult>();
        return {
            method: spy,
            spy,
        };
    }

    if (adapters.isTrackedMethod?.(providedMethod)) {
        return {
            method: providedMethod,
            spy: providedMethod,
        };
    }

    const spy = createTrackedMethod<TArgs, TResult>();
    return {
        method: ((...args: TArgs) => {
            spy(...args);
            return providedMethod(...args);
        }) as RouterMethod<TArgs, TResult>,
        spy,
    };
}

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

function resolveStackScreenOptions(options: StackScreenOptionsInput | null): StackScreenOptions | null {
    if (!options) {
        return null;
    }
    return typeof options === 'function' ? options() : options;
}

export function createStackOptionsCapture(): StackOptionsCapture {
    let currentOptions: StackScreenOptionsInput | null = null;

    return {
        record(options) {
            currentOptions = options;
        },
        reset() {
            currentOptions = null;
        },
        getRaw() {
            return currentOptions;
        },
        getResolved() {
            return resolveStackScreenOptions(currentOptions);
        },
    };
}

export function createExpoRouterRuntime(
    options: ExpoRouterRuntimeOptions = {},
    adapters: ExpoRouterRuntimeAdapters = {},
) {
    const trackedPush = createTrackedRouterMethod<[unknown], unknown>(options.router?.push, adapters);
    const trackedBack = createTrackedRouterMethod<[], unknown>(options.router?.back, adapters);
    const trackedReplace = createTrackedRouterMethod<[unknown], unknown>(options.router?.replace, adapters);
    const trackedDismissTo = createTrackedRouterMethod<[unknown], unknown>(options.router?.dismissTo, adapters);
    const trackedDismissAll = createTrackedRouterMethod<[], unknown>(options.router?.dismissAll, adapters);
    const trackedSetParams = createTrackedRouterMethod<[ExpoRouterParams], unknown>(options.router?.setParams, adapters);
    const router = Object.assign(options.router ?? {}, {
        push: trackedPush.method,
        back: trackedBack.method,
        replace: trackedReplace.method,
        dismissTo: trackedDismissTo.method,
        dismissAll: trackedDismissAll.method,
        setParams: trackedSetParams.method,
    }) as ExpoRouterRuntimeRouter;
    const spies = {
        push: trackedPush.spy,
        back: trackedBack.spy,
        replace: trackedReplace.spy,
        dismissTo: trackedDismissTo.spy,
        dismissAll: trackedDismissAll.spy,
        setParams: trackedSetParams.spy,
    };

    let paramsOverrides: ExpoRouterParams = {};
    const state = {
        get pathname() {
            return resolvePathnameInput(options.pathname);
        },
        params: {} as ExpoRouterParams,
        get segments() {
            return resolveSegmentsInput(options.segments);
        },
        navigation: options.navigation ?? null,
        router,
    };
    const syncParams = () => {
        state.params = {
            ...resolveParamsInput(options.params),
            ...paramsOverrides,
        };
        return state.params;
    };
    syncParams();
    const setParamsMock = (value: ExpoRouterParams) => {
        paramsOverrides = {
            ...paramsOverrides,
            ...value,
        };
        syncParams();
        return trackedSetParams.method(value);
    };
    state.router.setParams = setParamsMock as typeof state.router.setParams;
    spies.push.mockName?.('router.push');
    spies.back.mockName?.('router.back');
    spies.replace.mockName?.('router.replace');
    spies.dismissTo.mockName?.('router.dismissTo');
    spies.dismissAll.mockName?.('router.dismissAll');
    spies.setParams.mockName?.('router.setParams');

    return {
        state,
        spies,
        module: {
            Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
            Link: 'Link' as unknown,
            Stack: Object.assign(
                function Stack(props: { children?: React.ReactNode }) {
                    return React.createElement(React.Fragment, null, props.children ?? null);
                },
                {
                    Screen: (props: { options?: StackScreenOptionsInput }) => {
                        if (props.options) {
                            options.stackOptionsCapture?.record(props.options);
                        }
                        return React.createElement('StackScreen', props);
                    },
                },
            ),
            useRouter: () => state.router,
            useNavigation: () => state.navigation,
            useSegments: () => resolveSegmentsInput(options.segments),
            usePathname: () => resolvePathnameInput(options.pathname),
            useLocalSearchParams: () => syncParams(),
            useGlobalSearchParams: () => syncParams(),
            router: state.router,
        },
    };
}
