import * as React from 'react';
import { vi } from 'vitest';

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

export type ExpoRouterMockOptions = Readonly<{
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
    }>;
    stackOptionsCapture?: StackOptionsCapture;
}>;

type ExpoRouterMockRouter = {
    push: (value: unknown) => unknown;
    navigate?: (value: unknown, options?: unknown) => unknown;
    back: () => unknown;
    replace: (value: unknown) => unknown;
    setParams: (value: ExpoRouterParams) => unknown;
};

type RouterMethod<TArgs extends unknown[], TResult> = (...args: TArgs) => TResult;

function isVitestMockFunction<TArgs extends unknown[], TResult>(
    value: RouterMethod<TArgs, TResult> | undefined,
): value is ReturnType<typeof vi.fn<RouterMethod<TArgs, TResult>>> {
    return typeof value === 'function' && 'mock' in value;
}

function createTrackedRouterMethod<TArgs extends unknown[], TResult>(
    providedMethod: RouterMethod<TArgs, TResult> | undefined,
): {
    method: RouterMethod<TArgs, TResult>;
    spy: ReturnType<typeof vi.fn<RouterMethod<TArgs, TResult>>>;
} {
    if (!providedMethod) {
        const spy = vi.fn<RouterMethod<TArgs, TResult>>();
        return {
            method: spy,
            spy,
        };
    }

    if (isVitestMockFunction(providedMethod)) {
        return {
            method: providedMethod,
            spy: providedMethod,
        };
    }

    const spy = vi.fn<RouterMethod<TArgs, TResult>>();
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

export function createExpoRouterMock(options: ExpoRouterMockOptions = {}) {
    const trackedPush = createTrackedRouterMethod<[unknown], unknown>(options.router?.push);
    const trackedBack = createTrackedRouterMethod<[], unknown>(options.router?.back);
    const trackedReplace = createTrackedRouterMethod<[unknown], unknown>(options.router?.replace);
    const trackedSetParams = createTrackedRouterMethod<[ExpoRouterParams], unknown>(options.router?.setParams);
    const router = Object.assign(options.router ?? {}, {
        push: trackedPush.method,
        back: trackedBack.method,
        replace: trackedReplace.method,
        setParams: trackedSetParams.method,
    }) as ExpoRouterMockRouter;
    const spies = {
        push: trackedPush.spy,
        back: trackedBack.spy,
        replace: trackedReplace.spy,
        setParams: trackedSetParams.spy,
    };

    let paramsOverrides: ExpoRouterParams = {};
    const syncParams = () => {
        state.params = {
            ...resolveParamsInput(options.params),
            ...paramsOverrides,
        };
        return state.params;
    };
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
    spies.push.mockName('router.push');
    spies.back.mockName('router.back');
    spies.replace.mockName('router.replace');
    spies.setParams.mockName('router.setParams');

    return {
        state,
        spies,
        module: {
            Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
            Link: 'Link' as any,
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
