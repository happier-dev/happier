import type * as z from 'zod';

import type { AgentId } from '../types.js';

export type ProviderSettingsBuildShape = (zod: typeof z) => z.ZodRawShape;

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
  buildSettingsShape: ProviderSettingsBuildShape;
  settingsDefaults: Readonly<Record<string, unknown>>;
  buildOutgoingMessageMetaExtras?: ProviderSettingsBuildMessageMetaExtras;
  resolveSpawnExtras?: ProviderSettingsResolveSpawnExtras;
}>;

