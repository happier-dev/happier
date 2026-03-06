import {
  upsertScopedTelegramBridgeConfig,
  type ScopedTelegramBridgeUpdate,
} from './channelBridgeAccountConfig';
import type { ChannelBridgeServerTelegramConfigRecord } from './channelBridgeServerKv';

function hasUpdateFields(update: ScopedTelegramBridgeUpdate): boolean {
  return (
    typeof update.tickMs === 'number'
    || Array.isArray(update.allowedChatIds)
    || typeof update.requireTopics === 'boolean'
    || typeof update.webhookEnabled === 'boolean'
    || typeof update.webhookHost === 'string'
    || typeof update.webhookPort === 'number'
  );
}

export function overlayServerKvTelegramConfigInSettings(params: Readonly<{
  settings: unknown;
  serverId: string;
  accountId: string;
  record: ChannelBridgeServerTelegramConfigRecord | null;
}>): unknown {
  if (!params.record) {
    return params.settings;
  }

  const telegram = params.record.telegram;
  const webhook = telegram.webhook;

  const update: ScopedTelegramBridgeUpdate = {
    ...(typeof params.record.tickMs === 'number' ? { tickMs: Math.trunc(params.record.tickMs) } : {}),
    ...(Array.isArray(telegram.allowedChatIds) ? { allowedChatIds: [...telegram.allowedChatIds] } : {}),
    ...(typeof telegram.requireTopics === 'boolean' ? { requireTopics: telegram.requireTopics } : {}),
    ...(webhook && typeof webhook.enabled === 'boolean' ? { webhookEnabled: webhook.enabled } : {}),
    ...(webhook && typeof webhook.host === 'string' ? { webhookHost: webhook.host } : {}),
    ...(webhook && typeof webhook.port === 'number' ? { webhookPort: Math.trunc(webhook.port) } : {}),
  };

  if (!hasUpdateFields(update)) {
    return params.settings;
  }

  return upsertScopedTelegramBridgeConfig({
    settings: params.settings,
    serverId: params.serverId,
    accountId: params.accountId,
    update,
  });
}
