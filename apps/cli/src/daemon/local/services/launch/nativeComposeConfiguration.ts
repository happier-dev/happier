import { isDeepStrictEqual } from 'node:util';

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Private activation evidence. Neither interpolated configuration nor a
 * secret-derived fingerprint leaves the native generation's custody. */
export type NativeComposeConfigurationMatcher = (configuration: unknown, hostConfiguration: unknown) => boolean | undefined;

export function captureNativeComposeConfiguration(configuration: unknown, hostConfiguration: unknown): NativeComposeConfigurationMatcher {
    const expected = record(configuration) && record(hostConfiguration)
        // Both objects are the native owner's private JSON inspection, never caller-owned mutable input.
        ? { configuration, hostConfiguration } : undefined;
    return (currentConfiguration, currentHostConfiguration) => expected
        && record(currentConfiguration) && record(currentHostConfiguration)
        ? isDeepStrictEqual(expected.configuration, currentConfiguration)
            && isDeepStrictEqual(expected.hostConfiguration, currentHostConfiguration)
        : undefined;
}
