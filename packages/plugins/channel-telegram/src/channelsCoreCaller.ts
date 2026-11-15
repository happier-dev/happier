import { assertConversationChannelsCoreCallerV1 } from '@happier-dev/channels-protocol/v1';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

/** The one caller fence for Telegram operations contributed to Channels. */
export function assertTelegramChannelsCoreCaller(context: PluginInvocationContext): void {
  assertConversationChannelsCoreCallerV1(context, {
    code: 'telegram_channels_core_caller_required',
    message: 'Telegram Channel provider operations require a host-stamped plugin caller.',
  });
}
