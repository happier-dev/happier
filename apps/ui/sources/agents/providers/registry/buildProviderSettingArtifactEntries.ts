import { buildSettingArtifacts, type SettingArtifacts } from '@happier-dev/protocol';

import type { ProviderSettingsDescriptor } from '../shared/providerSettingsPlugin';

export type ProviderSettingArtifactEntry<TDescriptor extends ProviderSettingsDescriptor = ProviderSettingsDescriptor> = Readonly<{
    descriptor: TDescriptor;
    artifacts: SettingArtifacts<TDescriptor['settings']>;
}>;

export function buildProviderSettingArtifactEntries<const TDescriptors extends readonly ProviderSettingsDescriptor[]>(
    descriptors: TDescriptors,
): { readonly [TIndex in keyof TDescriptors]: ProviderSettingArtifactEntry<TDescriptors[TIndex]> } {
    return descriptors.map((descriptor) => ({
        descriptor,
        artifacts: buildSettingArtifacts(descriptor.settings),
    })) as { readonly [TIndex in keyof TDescriptors]: ProviderSettingArtifactEntry<TDescriptors[TIndex]> };
}
