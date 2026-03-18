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

export type ProviderSettingsDefinition = Readonly<{
  providerId: AgentId;
  fields: SettingDefinitionMap;
  buildOutgoingMessageMetaExtras?: ProviderSettingsBuildMessageMetaExtras;
  resolveSpawnExtras?: ProviderSettingsResolveSpawnExtras;
}>;
