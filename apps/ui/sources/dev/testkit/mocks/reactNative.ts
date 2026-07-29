import {
    createReactNativeAppStateEmitter,
    createReactNativeWebRuntime,
    installReactNativeWebRuntime,
    type TestReactNativeAppStateStatus,
    type TestReactNativeRuntimeOverrides,
} from '../runtime/reactNativeRuntime';

export type TestReactNativeOverrides = TestReactNativeRuntimeOverrides;
export type { TestReactNativeAppStateStatus };

export { createReactNativeAppStateEmitter };
export const createReactNativeWebMock = createReactNativeWebRuntime;
export const installReactNativeWebMock = installReactNativeWebRuntime;
