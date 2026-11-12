import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type DesktopHostModule = typeof import('@/utils/platform/desktopHost');

/** Replace the native host boundary while preserving the module's actual exports. */
export function createDesktopHostModuleMock(options: MergeModuleMockOptions<DesktopHostModule>) {
    return mergeModuleMock(options);
}
