import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { createTelegramChannelAdapter } from '@/channels/providers/telegram/telegramAdapter';
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
      logger.warn(
        '[channelBridge] Telegram webhook.enabled=true but webhook.secret is missing; falling back to polling mode',
      );
    }

    const webhookModeRequested = webhookEnabled && webhookSecret.length > 0;

    let relayHandle: TelegramWebhookRelayHandle | null = null;
    let adapter = createTelegramChannelAdapter({
      botToken,
      allowedChatIds,
      allowAllSharedChats,
      requireTopics,
      webhookMode: webhookModeRequested,
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
        logger.warn(
          '[channelBridge] Failed to start Telegram webhook relay; bridge will continue without webhook relay',
          serializeAxiosErrorForLog(error),
        );
        await stopRelayBestEffort(relayHandle);
        relayHandle = null;
        adapter = createTelegramChannelAdapter({
          botToken,
          allowedChatIds,
          allowAllSharedChats,
          requireTopics,
          webhookMode: false,
        });
        logger.warn('[channelBridge] Falling back to Telegram polling mode because webhook relay failed to start');
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

