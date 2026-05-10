import type { ScmHostingProviderDescriptor } from './types.js';

export function readScmHostingProviderUrlSafety(
    provider: ScmHostingProviderDescriptor,
): ScmHostingProviderDescriptor['urlSafety'] {
    return Object.freeze({
        allowedSchemes: readScmHostingProviderAllowedSchemes(provider),
        allowedBaseUrls: Object.freeze([...(provider.urlSafety?.allowedBaseUrls ?? [])]),
        allowedOrigins: Object.freeze([...(provider.urlSafety?.allowedOrigins ?? [])]),
    });
}

export function readScmHostingProviderAllowedSchemes(
    provider: ScmHostingProviderDescriptor,
): readonly string[] {
    return provider.urlSafety?.allowedSchemes?.length
        ? Object.freeze([...provider.urlSafety.allowedSchemes])
        : Object.freeze(['https:']);
}
