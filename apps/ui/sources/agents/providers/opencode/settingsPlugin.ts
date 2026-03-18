import { createProviderSettingsPlugin } from '@/agents/registry/providerSettingArtifacts';
import { providerSettingDefinitionsById } from '@/agents/registry/providerSettingDefinitions';

export const OPENCODE_PROVIDER_SETTINGS_PLUGIN = createProviderSettingsPlugin(providerSettingDefinitionsById.opencode);
