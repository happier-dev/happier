import type { SettingDefinitionMap } from '@happier-dev/protocol';

import type { AgentId } from '../types.js';

export type ProviderSettingsBuildMessageMetaExtras = (args: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
  session: unknown;
}>) => Readonly<Record<string, unknown>>;

export type ProviderSettingsResolveSpawnExtras = (args: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
}>) => Readonly<Record<string, unknown>>;

export type ProviderSettingsDescriptor = Readonly<{
  providerId: AgentId;
  fields: SettingDefinitionMap;
}>;

export type ProviderSettingsBehavior = Readonly<{
  buildOutgoingMessageMetaExtras?: ProviderSettingsBuildMessageMetaExtras;
  resolveSpawnExtras?: ProviderSettingsResolveSpawnExtras;
}>;

export type ProviderSettingsDefinition = ProviderSettingsDescriptor & ProviderSettingsBehavior;
