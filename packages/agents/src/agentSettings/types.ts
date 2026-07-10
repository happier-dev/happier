import type { SettingDefinitionMap } from '@happier-dev/protocol';

export type AgentSettingsDescriptor = Readonly<{
  agentId: string;
  fields: SettingDefinitionMap;
}>;

export type AgentSettingsDefinition = AgentSettingsDescriptor;
