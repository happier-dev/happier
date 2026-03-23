import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type CapabilitiesOpsModule = typeof import('@/sync/ops/capabilities');

export type CreateCapabilitiesOpsModuleMockOptions = MergeModuleMockOptions<CapabilitiesOpsModule>;

export async function createCapabilitiesOpsModuleMock(
    options: CreateCapabilitiesOpsModuleMockOptions,
): Promise<CapabilitiesOpsModule> {
    return mergeModuleMock<CapabilitiesOpsModule>(options);
}

export function installCapabilitiesOpsModuleMock(overrides: Partial<CapabilitiesOpsModule>) {
    return async (importOriginal: <T>() => Promise<T>) => createCapabilitiesOpsModuleMock({
        importOriginal,
        overrides,
    });
}
