import {
    createUnistylesRuntime,
    installUnistylesRuntime,
    type TestUnistylesRuntimeOverrides,
} from '../runtime/unistylesRuntime';

export type TestUnistylesOverrides = TestUnistylesRuntimeOverrides;

export const createUnistylesMock = createUnistylesRuntime;
export const installUnistylesMock = installUnistylesRuntime;
