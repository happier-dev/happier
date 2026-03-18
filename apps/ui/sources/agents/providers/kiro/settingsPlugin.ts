import { createProviderSettingsPlugin } from '@/agents/registry/providerSettingArtifacts';
import { providerSettingDefinitionsById } from '@/agents/registry/providerSettingDefinitions';

export const KIRO_PROVIDER_SETTINGS_PLUGIN = createProviderSettingsPlugin(providerSettingDefinitionsById.kiro);
