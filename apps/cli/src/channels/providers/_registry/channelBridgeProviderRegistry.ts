import type { ChannelBridgeRuntimeConfig } from '@/channels/channelBridgeConfig';

import { telegramChannelBridgeProvider } from './telegramChannelBridgeProvider';
import type { ChannelBridgeProviderDefinition } from './types';

export type AnyChannelBridgeProviderDefinition = ChannelBridgeProviderDefinition<
  string,
  ChannelBridgeRuntimeConfig,
  unknown
>;

export const channelBridgeProviderRegistry = {
  telegram: telegramChannelBridgeProvider,
} as const satisfies Record<string, AnyChannelBridgeProviderDefinition>;

export type ChannelBridgeProviderId = keyof typeof channelBridgeProviderRegistry;

export function listChannelBridgeProviderIds(): readonly ChannelBridgeProviderId[] {
  return Object.keys(channelBridgeProviderRegistry) as ChannelBridgeProviderId[];
}

export function resolveChannelBridgeProviderDefinition(
  providerId: ChannelBridgeProviderId,
): AnyChannelBridgeProviderDefinition {
  return channelBridgeProviderRegistry[providerId];
}
