import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { createTelegramChannelAdapter } from '@/channels/providers/telegram/telegramAdapter';
import { createTelegramPollingCursorStore } from '@/channels/providers/telegram/telegramPollingCursorStore';
import {
  startTelegramWebhookRelay,
  type TelegramWebhookRelayHandle,
} from '@/channels/providers/telegram/telegramWebhookRelay';
import type { ChannelBridgeRuntimeConfig } from '@/channels/channelBridgeConfig';
import { logger } from '@/ui/logger';

import type { ChannelBridgeProviderDefinition, ChannelBridgeProviderRuntime } from './types';

async function stopRelayBestEffort(relayHandle: TelegramWebhookRelayHandle | null): Promise<void> {
  if (!relayHandle) return;
  try {
    await relayHandle.stop();
  } catch (error) {
    logger.warn('[channelBridge] Error stopping Telegram webhook relay during shutdown', error);
  }
}

export const telegramChannelBridgeProvider: ChannelBridgeProviderDefinition<
  'telegram',
  ChannelBridgeRuntimeConfig,
  ChannelBridgeRuntimeConfig['telegram']
> = {
  providerId: 'telegram',
  readConfig: (root) => root.telegram,
  createRuntime: async ({ config }) => {
    const botToken = config.botToken;
    if (!botToken) return null;

    const allowedChatIdsRaw = config.allowedChatIds;
    const allowedChatIds = allowedChatIdsRaw.length > 0 ? new Set(allowedChatIdsRaw) : null;
    const allowAllSharedChats = config.allowAllSharedChats;
    const requireTopics = config.requireTopics;

    const webhookEnabled = config.webhookEnabled;
    const webhookSecret = config.webhookSecret;
    if (webhookEnabled && webhookSecret.length === 0) {
      throw new Error(
        'Telegram webhook mode is enabled but webhook secret is missing. Set HAPPIER_TELEGRAM_WEBHOOK_SECRET (or persist secrets.webhookSecret in settings) and restart the daemon.',
      );
    }

    const webhookModeRequested = webhookEnabled;
    const pollingCursorStore = createTelegramPollingCursorStore({ botToken });

    let relayHandle: TelegramWebhookRelayHandle | null = null;
    let adapter = createTelegramChannelAdapter({
      botToken,
      allowedChatIds,
      allowAllSharedChats,
      requireTopics,
      webhookMode: webhookModeRequested,
      pollingCursorStore,
    });

    if (webhookModeRequested) {
      const port = config.webhookPort;
      const host = config.webhookHost;
      try {
        relayHandle = await startTelegramWebhookRelay({
          port,
          host,
          // We intentionally use one shared secret today because bridge config currently
          // exposes a single webhook secret field. The relay API keeps both knobs
          // separate so we can split path/header secrets in a future config version.
          secretPathToken: webhookSecret,
          secretHeaderToken: webhookSecret,
          onUpdate: adapter.enqueueWebhookUpdate,
        });
        logger.debug(
          `[channelBridge] Telegram webhook relay listening on http://${host}:${relayHandle.port} (path redacted)`,
        );
      } catch (error) {
        logger.warn('[channelBridge] Failed to start Telegram webhook relay', serializeAxiosErrorForLog(error));
        await stopRelayBestEffort(relayHandle);
        relayHandle = null;
        throw new Error(
          'Telegram webhook mode is enabled but the local webhook relay failed to start. Fix webhookHost/webhookPort and restart the daemon.',
        );
      }
    }

    let stopped = false;
    const runtime: ChannelBridgeProviderRuntime = {
      adapters: [adapter],
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await stopRelayBestEffort(relayHandle);
      },
    };
    return runtime;
  },
};
