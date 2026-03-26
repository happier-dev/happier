import type { ChannelBridgeAdapter } from '@/channels/core/channelBridgeWorker';

export type ChannelBridgeProviderRuntime = Readonly<{
  adapters: readonly ChannelBridgeAdapter[];
  stop: () => Promise<void>;
}>;

export type ChannelBridgeProviderDefinition<
  TProviderId extends string,
  TRootConfig,
  TProviderConfig,
> = Readonly<{
  providerId: TProviderId;
  readConfig: (root: TRootConfig) => TProviderConfig;
  createRuntime: (params: Readonly<{ config: TProviderConfig }>) => Promise<ChannelBridgeProviderRuntime | null>;
}>;

