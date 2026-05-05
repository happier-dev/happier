import {
    createReactNativeWebRuntime,
    installReactNativeWebRuntime,
    type TestReactNativeRuntimeOverrides,
} from '../runtime/reactNativeRuntime';

export type TestReactNativeOverrides = TestReactNativeRuntimeOverrides;

export const createReactNativeWebMock = createReactNativeWebRuntime;
export const installReactNativeWebMock = installReactNativeWebRuntime;
