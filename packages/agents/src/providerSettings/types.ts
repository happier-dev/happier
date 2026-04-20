import type { SettingDefinitionMap } from '@happier-dev/protocol';

import type { AgentId } from '../types.js';

export type ProviderSettingsDescriptor = Readonly<{
  providerId: AgentId;
  fields: SettingDefinitionMap;
}>;

export type ProviderSettingsDefinition = ProviderSettingsDescriptor;
