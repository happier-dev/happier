import * as React from 'react';
import { vi } from 'vitest';
import { createReactNavigationNativeMock } from './reactNavigation';
import {
    createExpoRouterRuntime,
    createStackOptionsCapture,
    type ExpoRouterParams,
    type ExpoRouterRuntimeAdapters,
    type ExpoRouterRuntimeOptions,
    type StackOptionsCapture,
    type StackScreenOptions,
    type StackScreenOptionsInput,
} from '../runtime/routerRuntime';

export type { ExpoRouterParams, StackOptionsCapture, StackScreenOptions, StackScreenOptionsInput };
export type ExpoRouterMockOptions = ExpoRouterRuntimeOptions;
export { createStackOptionsCapture };

type RouterMethod<TArgs extends unknown[], TResult> = (...args: TArgs) => TResult;

function isVitestMockFunction<TArgs extends unknown[], TResult>(
    value: RouterMethod<TArgs, TResult> | undefined,
): value is ReturnType<typeof vi.fn<RouterMethod<TArgs, TResult>>> {
    return typeof value === 'function' && 'mock' in value;
}

export function createExpoRouterMock(options: ExpoRouterMockOptions = {}) {
    const adapters: ExpoRouterRuntimeAdapters = {
        createTrackedMethod: <TArgs extends unknown[], TResult>(
            implementation?: RouterMethod<TArgs, TResult>,
        ) => vi.fn((...args: TArgs) => implementation?.(...args) as TResult),
        isTrackedMethod: isVitestMockFunction,
    };
    // Expo exposes the native navigator in a mounted route. Reuse the shared
    // boundary's defaults, while preserving an explicitly supplied object/null.
    const navigation = options.navigation === undefined
        ? createReactNavigationNativeMock().useNavigation()
        : options.navigation;
    const runtime = createExpoRouterRuntime({ ...options, navigation }, adapters);

    return {
        state: runtime.state,
        /** Clears every `router.setParams` override this module-level mock accumulated. */
        resetParams: runtime.resetParams,
        spies: {
            push: vi.mocked(runtime.spies.push),
            navigate: vi.mocked(runtime.spies.navigate),
            back: vi.mocked(runtime.spies.back),
            replace: vi.mocked(runtime.spies.replace),
            dismissTo: vi.mocked(runtime.spies.dismissTo),
            dismissAll: vi.mocked(runtime.spies.dismissAll),
            setParams: vi.mocked(runtime.spies.setParams),
        },
        module: {
            Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
            Link: runtime.module.Link as any,
            Stack: runtime.module.Stack,
            useRouter: runtime.module.useRouter,
            useNavigation: runtime.module.useNavigation,
            useSegments: runtime.module.useSegments,
            usePathname: runtime.module.usePathname,
            useLocalSearchParams: runtime.module.useLocalSearchParams,
            useGlobalSearchParams: runtime.module.useGlobalSearchParams,
            router: runtime.module.router,
        },
    };
}
