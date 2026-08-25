import { CONVERSATION_CORE_PLUGIN_ID_V1 } from '@happier-dev/channels-protocol/v1';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';

/** The one caller fence for Telegram operations contributed to Channels. */
export function assertTelegramChannelsCoreCaller(context: PluginInvocationContext): void {
  if (
    context.surface !== 'plugin'
    || context.caller?.kind !== 'plugin'
    || context.caller.pluginId !== CONVERSATION_CORE_PLUGIN_ID_V1
  ) {
    throw new PluginError({
      code: 'telegram_channels_core_caller_required',
      message: 'Telegram Channel provider operations must be invoked by the Channels core plugin.',
    });
  }
}
