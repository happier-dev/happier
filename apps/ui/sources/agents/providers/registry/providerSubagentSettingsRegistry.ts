import type { ProviderSettingsDescriptor, ProviderSubagentSettingsSectionDef } from '@/agents/providers/shared/providerSettingsPlugin';

import { PROVIDER_SETTINGS_DESCRIPTORS } from '@/agents/catalog/providerSettingsCatalog';

export type ProviderSubagentSettingsSectionDescriptor = Readonly<{
    providerId: string;
    provider: ProviderSettingsDescriptor;
    section: ProviderSubagentSettingsSectionDef;
}>;

export function listProviderSubagentSettingsSections(): readonly ProviderSubagentSettingsSectionDescriptor[] {
    const sections: ProviderSubagentSettingsSectionDescriptor[] = [];

    for (const provider of PROVIDER_SETTINGS_DESCRIPTORS) {
        for (const section of provider.subagentSettingsSections ?? []) {
            sections.push({
                providerId: provider.providerId,
                provider,
                section,
            });
        }
    }

    return sections;
}
