import { buildProviderSettingArtifactEntries } from '@/agents/providers/registry/buildProviderSettingArtifactEntries';
import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

export function assertProviderSettingKeysCompatible(params: {
    coreSettingKeys: readonly string[];
    plugins: readonly ProviderSettingsPlugin[];
}): void {
    // Provider settings must never shadow settings-blob metadata keys.
    const coreSettingKeys = new Set([...params.coreSettingKeys, 'schemaVersion']);
    const errors: string[] = [];

    for (const { descriptor, artifacts } of buildProviderSettingArtifactEntries(params.plugins)) {
        const providerId = String(descriptor.providerId ?? '').trim().toLowerCase() || '<unknown>';
        const providerSettingKeys = Object.keys(artifacts.shape);

        for (const key of providerSettingKeys) {
            if (!coreSettingKeys.has(key)) continue;
            errors.push(`Provider "${providerId}" setting "${key}" collides with core setting "${key}"`);
        }
    }

    if (errors.length > 0) {
        throw new Error(`Invalid provider settings compatibility:\n- ${errors.join('\n- ')}`);
    }
}
