import type { ScmHostingProviderDescriptor } from './types';

export function readScmHostingProviderAllowedSchemes(
    provider: ScmHostingProviderDescriptor,
): readonly string[] {
    return provider.urlSafety?.allowedSchemes?.length
        ? Object.freeze([...provider.urlSafety.allowedSchemes])
        : Object.freeze(['https:']);
}
