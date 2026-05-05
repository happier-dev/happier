import {
    createTextModuleRuntime,
    installTextModuleRuntime,
    type TextModuleRuntimeOptions,
} from '../runtime/textRuntime';

export type TextModuleMockOptions = TextModuleRuntimeOptions;

export const createTextModuleMock = createTextModuleRuntime;
export const installTextModuleMock = installTextModuleRuntime;
