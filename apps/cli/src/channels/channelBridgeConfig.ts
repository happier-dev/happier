import { isLoopbackHostname } from '@/server/serverUrlClassification';
import { readTelegramWebhookSecretToken } from '@/channels/providers/telegram/telegramWebhookSecretToken';
import {
  asRecord,
  firstParsed,
  parseBoolean,
  parseCsv,
  parseInteger,
  parseStrictInteger,
  parseStringArray,
  readTrimmedString,
} from '@/channels/channelBridgeConfigParsing';
import { resolveChannelBridgeSettingsScopes } from '@/channels/channelBridgeSettingsScopes';

type RecordLike = Record<string, unknown>;

function readWebhookSecretToken(value: unknown): string | null {
  return readTelegramWebhookSecretToken(value);
}

type TelegramChannelBridgeRuntimeConfig = Readonly<{
  botToken: string;
  allowedChatIds: string[];
  allowAllSharedChats: boolean;
  requireTopics: boolean;
  webhookEnabled: boolean;
  webhookSecret: string;
  webhookHost: string;
  webhookPort: number;
}>;

export type ChannelBridgeRuntimeConfig = Readonly<{
  tickMs: number;
  providers: Readonly<{
    telegram: TelegramChannelBridgeRuntimeConfig;
  }>;
}>;

export function resolveChannelBridgeRuntimeConfig(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  settings?: unknown;
  serverId?: string | null;
  accountId?: string | null;
}>): ChannelBridgeRuntimeConfig {
  const env = params.env ?? process.env;
  const scopes = resolveChannelBridgeSettingsScopes({
    settings: params.settings,
    serverId: params.serverId,
    accountId: params.accountId,
  });
  const channelBridgeGlobal = scopes.channelBridgeGlobal;
  const channelBridgeServer = scopes.channelBridgeServer;
  const channelBridgeAccount = scopes.channelBridgeAccount;

  const providersGlobal = asRecord(channelBridgeGlobal?.providers);
  const providersServer = asRecord(channelBridgeServer?.providers);
  const providersAccount = asRecord(channelBridgeAccount?.providers);

  const telegramGlobal = asRecord(providersGlobal?.telegram);
  const telegramServer = asRecord(providersServer?.telegram);
  const telegramAccount = asRecord(providersAccount?.telegram);

  const secretsGlobal = asRecord(telegramGlobal?.secrets);
  const secretsServer = asRecord(telegramServer?.secrets);
  const secretsAccount = asRecord(telegramAccount?.secrets);

  const webhookGlobal = asRecord(telegramGlobal?.webhook);
  const webhookServer = asRecord(telegramServer?.webhook);
  const webhookAccount = asRecord(telegramAccount?.webhook);

  const settingsTickMs =
    firstParsed(
      [channelBridgeAccount?.tickMs, channelBridgeServer?.tickMs, channelBridgeGlobal?.tickMs],
      (value) => parseInteger(value, 250, 60_000),
    );
  const envTickMs =
    typeof env.HAPPIER_CHANNEL_BRIDGE_TICK_MS === 'string'
      ? parseStrictInteger(env.HAPPIER_CHANNEL_BRIDGE_TICK_MS, 250, 60_000)
      : null;
  const tickMs = envTickMs ?? settingsTickMs ?? 2_500;

  const settingsBotToken =
    firstParsed([
      secretsAccount?.botToken,
      telegramAccount?.botToken,
      secretsServer?.botToken,
      telegramServer?.botToken,
      secretsGlobal?.botToken,
      telegramGlobal?.botToken,
    ], readTrimmedString)
    ?? '';
  const envBotToken = readTrimmedString(env.HAPPIER_TELEGRAM_BOT_TOKEN);
  const botToken = envBotToken ?? settingsBotToken;

  const settingsAllowedChatIds =
    firstParsed(
      [telegramAccount?.allowedChatIds, telegramServer?.allowedChatIds, telegramGlobal?.allowedChatIds],
      parseStringArray,
    )
    ?? [];
  const envAllowedChatIdsRaw =
    typeof env.HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS === 'string'
      ? env.HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS.trim()
      : null;
  const parsedEnvAllowedChatIds =
    envAllowedChatIdsRaw && envAllowedChatIdsRaw.length > 0
      ? parseCsv(envAllowedChatIdsRaw)
      : null;
  const allowedChatIds =
    parsedEnvAllowedChatIds && parsedEnvAllowedChatIds.length > 0
      ? parsedEnvAllowedChatIds
      : settingsAllowedChatIds;

  const settingsAllowAllSharedChats =
    firstParsed(
      [telegramAccount?.allowAllSharedChats, telegramServer?.allowAllSharedChats, telegramGlobal?.allowAllSharedChats],
      parseBoolean,
    )
    ?? false;
  const envAllowAllSharedChats =
    typeof env.HAPPIER_TELEGRAM_ALLOW_ALL_SHARED_CHATS === 'string'
      ? parseBoolean(env.HAPPIER_TELEGRAM_ALLOW_ALL_SHARED_CHATS)
      : null;
  const allowAllSharedChats = envAllowAllSharedChats ?? settingsAllowAllSharedChats;

  const settingsRequireTopics =
    firstParsed(
      [telegramAccount?.requireTopics, telegramServer?.requireTopics, telegramGlobal?.requireTopics],
      parseBoolean,
    )
    ?? false;
  const envRequireTopics =
    typeof env.HAPPIER_TELEGRAM_REQUIRE_TOPICS === 'string'
      ? parseBoolean(env.HAPPIER_TELEGRAM_REQUIRE_TOPICS)
      : null;
  const requireTopics = envRequireTopics ?? settingsRequireTopics;

  const settingsWebhookEnabled =
    firstParsed(
      [webhookAccount?.enabled, webhookServer?.enabled, webhookGlobal?.enabled],
      parseBoolean,
    )
    ?? false;
  const envWebhookEnabled =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_ENABLED === 'string'
      ? parseBoolean(env.HAPPIER_TELEGRAM_WEBHOOK_ENABLED)
      : null;
  const webhookEnabled = envWebhookEnabled ?? settingsWebhookEnabled;

  const settingsWebhookSecret =
    firstParsed([
      secretsAccount?.webhookSecret,
      webhookAccount?.secret,
      secretsServer?.webhookSecret,
      webhookServer?.secret,
      secretsGlobal?.webhookSecret,
      webhookGlobal?.secret,
    ], readWebhookSecretToken)
    ?? '';
  const envWebhookSecretRaw =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_SECRET === 'string'
      ? env.HAPPIER_TELEGRAM_WEBHOOK_SECRET.trim()
      : null;
  const envWebhookSecret = readWebhookSecretToken(envWebhookSecretRaw);
  const webhookSecret = envWebhookSecret ?? settingsWebhookSecret;

  const settingsWebhookHostRaw =
    firstParsed(
      [webhookAccount?.host, webhookServer?.host, webhookGlobal?.host],
      readTrimmedString,
    )
    || '127.0.0.1';
  const settingsWebhookHost = isLoopbackHostname(settingsWebhookHostRaw) ? settingsWebhookHostRaw : '127.0.0.1';
  const envWebhookHostRaw =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_HOST === 'string'
      ? env.HAPPIER_TELEGRAM_WEBHOOK_HOST.trim()
      : null;
  const envWebhookHost =
    envWebhookHostRaw && isLoopbackHostname(envWebhookHostRaw)
      ? envWebhookHostRaw
      : null;
  const webhookHost = envWebhookHost ?? settingsWebhookHost;

  const settingsWebhookPort =
    firstParsed(
      [webhookAccount?.port, webhookServer?.port, webhookGlobal?.port],
      (value) => parseInteger(value, 1, 65_535),
    )
    ?? 8_787;
  const envWebhookPort =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_PORT === 'string'
      ? parseStrictInteger(env.HAPPIER_TELEGRAM_WEBHOOK_PORT, 1, 65_535)
      : null;
  const webhookPort = envWebhookPort ?? settingsWebhookPort;

  return {
    tickMs,
    providers: {
      telegram: {
        botToken,
        allowedChatIds,
        allowAllSharedChats,
        requireTopics,
        webhookEnabled,
        webhookSecret,
        webhookHost,
        webhookPort,
      },
    },
  };
}
