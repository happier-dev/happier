import type { AgentId } from '@/agents/catalog/catalog';
import type { ProviderSettingsPlugin, ProviderSubagentSettingsSectionDef } from '@/agents/providers/shared/providerSettingsPlugin';

import { PROVIDER_SETTINGS_PLUGINS } from './providerSettingsRegistry';

export type ProviderSubagentSettingsSectionDescriptor = Readonly<{
    providerId: AgentId;
    provider: ProviderSettingsPlugin;
    section: ProviderSubagentSettingsSectionDef;
}>;

export function listProviderSubagentSettingsSections(): readonly ProviderSubagentSettingsSectionDescriptor[] {
    const sections: ProviderSubagentSettingsSectionDescriptor[] = [];

    for (const provider of PROVIDER_SETTINGS_PLUGINS) {
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
