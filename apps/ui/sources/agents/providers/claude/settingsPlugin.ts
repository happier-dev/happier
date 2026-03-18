import { createProviderSettingsPlugin } from '@/agents/registry/providerSettingArtifacts';
import { providerSettingDefinitionsById } from '@/agents/registry/providerSettingDefinitions';

export const CLAUDE_PROVIDER_SETTINGS_PLUGIN = createProviderSettingsPlugin(providerSettingDefinitionsById.claude);
