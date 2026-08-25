import {
    encodePosthogConfiguration,
    type PosthogConfigurationEncoding,
    type PosthogConfigurationToken,
    type PosthogConfiguredEnvironment,
} from '../source/instance.js';

export type PosthogConfigurationSelectionInput = Readonly<{
    organizationUuid: string;
    scanWindowPolicy: PosthogConfigurationToken['scanWindowPolicy'];
    detailWindowPolicy: PosthogConfigurationToken['detailWindowPolicy'];
}>;

export type PosthogEnvironmentSelectionPreflight = Readonly<{
    environments: readonly PosthogConfiguredEnvironment[];
    encoding: PosthogConfigurationEncoding;
    accepted: boolean;
}>;

/**
 * Measures a proposed subset through the canonical token encoder before UI state moves.
 * A rejected proposal returns the previous subset verbatim, so a capacity failure can
 * never silently turn a working selection into a configuration that the target rejects.
 */
export function preflightPosthogEnvironmentSelection(
    current: readonly PosthogConfiguredEnvironment[],
    proposed: readonly PosthogConfiguredEnvironment[],
    input: PosthogConfigurationSelectionInput,
): PosthogEnvironmentSelectionPreflight {
    const encoding = encodePosthogConfiguration({
        v: 1,
        organizationUuid: input.organizationUuid,
        environments: proposed,
        scanWindowPolicy: input.scanWindowPolicy,
        detailWindowPolicy: input.detailWindowPolicy,
    });
    return encoding.ok
        ? { environments: proposed, encoding, accepted: true }
        : { environments: current, encoding, accepted: false };
}
