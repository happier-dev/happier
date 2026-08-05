import {
    createReactNativeAppStateEmitter,
    createReactNativeNativeRuntime,
    createReactNativeWebRuntime,
    installReactNativeWebRuntime,
    type TestReactNativeAppStateStatus,
    type TestReactNativeNativePlatformOS,
    type TestReactNativeRuntimeOverrides,
} from '../runtime/reactNativeRuntime';

export type TestReactNativeOverrides = TestReactNativeRuntimeOverrides;
export type { TestReactNativeAppStateStatus };
export type TestReactNativeNativeMockPlatformOS = TestReactNativeNativePlatformOS;

export { createReactNativeAppStateEmitter };
export const createReactNativeWebMock = createReactNativeWebRuntime;
export const installReactNativeWebMock = installReactNativeWebRuntime;
export const createReactNativeNativeMock = createReactNativeNativeRuntime;
