import type { ChannelBridgeAdapter } from '@/channels/core/channelBridgeWorker';

export type ChannelBridgeProviderRuntime = Readonly<{
  adapters: readonly ChannelBridgeAdapter[];
  stop: () => Promise<void>;
}>;

export type ChannelBridgeProviderRuntimeContext = Readonly<{
  serverId: string | null;
  accountId: string | null;
}>;

export type ChannelBridgeProviderDefinition<
  TProviderId extends string,
  TRootConfig,
  TProviderConfig,
> = Readonly<{
  providerId: TProviderId;
  readConfig: (root: TRootConfig) => TProviderConfig;
  createRuntime(params: Readonly<{ config: TProviderConfig; context: ChannelBridgeProviderRuntimeContext }>): Promise<ChannelBridgeProviderRuntime | null>;
}>;
