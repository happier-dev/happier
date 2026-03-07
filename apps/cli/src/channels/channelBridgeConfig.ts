import { isLoopbackHost } from '@/channels/telegram/telegramWebhookRelay';

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecordLike;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function parseStrictInteger(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^[-]?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return Math.trunc(parsed);
}

function parseInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const candidate = Math.trunc(value);
    if (candidate < min || candidate > max) return null;
    return candidate;
  }
  if (typeof value === 'string') {
    return parseStrictInteger(value, min, max);
  }
  return null;
}

function parseCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseStringArray(value: unknown): string[] | null {
  if (typeof value === 'string') return parseCsv(value);
  if (!Array.isArray(value)) return null;
  const out = value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (typeof entry === 'number' && Number.isFinite(entry)) return String(Math.trunc(entry));
      return '';
    })
    .filter((entry) => entry.length > 0);
  if (out.length === 0 && value.length > 0) {
    return null;
  }
  return out;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim();
}

function firstParsed<T>(values: readonly unknown[], parse: (value: unknown) => T | null): T | null {
  for (const value of values) {
    const parsed = parse(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

type TelegramChannelBridgeRuntimeConfig = Readonly<{
  botToken: string;
  allowedChatIds: string[];
  requireTopics: boolean;
  webhookEnabled: boolean;
  webhookSecret: string;
  webhookHost: string;
  webhookPort: number;
}>;

export type ChannelBridgeRuntimeConfig = Readonly<{
  tickMs: number;
  telegram: TelegramChannelBridgeRuntimeConfig;
}>;

export function resolveChannelBridgeRuntimeConfig(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  settings?: unknown;
  serverId?: string | null;
  accountId?: string | null;
}>): ChannelBridgeRuntimeConfig {
  const env = params.env ?? process.env;
  const settingsRoot = asRecord(params.settings);
  const channelBridgeGlobal = asRecord(settingsRoot?.channelBridge);

  const byServerId = asRecord(channelBridgeGlobal?.byServerId);
  const scopedServerId = readTrimmedString(params.serverId) ?? '';
  const scopedAccountId = readTrimmedString(params.accountId) ?? '';

  const channelBridgeServer =
    scopedServerId.length > 0 && byServerId
      ? asRecord(byServerId[scopedServerId])
      : null;

  const byAccountId = asRecord(channelBridgeServer?.byAccountId);
  const channelBridgeAccount =
    scopedAccountId.length > 0 && byAccountId
      ? asRecord(byAccountId[scopedAccountId])
      : null;

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
  const botToken =
    typeof env.HAPPIER_TELEGRAM_BOT_TOKEN === 'string'
      ? env.HAPPIER_TELEGRAM_BOT_TOKEN.trim()
      : settingsBotToken;

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
    ], readTrimmedString)
    ?? '';
  const webhookSecret =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_SECRET === 'string'
      ? env.HAPPIER_TELEGRAM_WEBHOOK_SECRET.trim()
      : settingsWebhookSecret;

  const settingsWebhookHostRaw =
    firstParsed(
      [webhookAccount?.host, webhookServer?.host, webhookGlobal?.host],
      readTrimmedString,
    )
    || '127.0.0.1';
  const settingsWebhookHost = isLoopbackHost(settingsWebhookHostRaw) ? settingsWebhookHostRaw : '127.0.0.1';
  const envWebhookHostRaw =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_HOST === 'string'
      ? env.HAPPIER_TELEGRAM_WEBHOOK_HOST.trim()
      : null;
  const envWebhookHost =
    envWebhookHostRaw && isLoopbackHost(envWebhookHostRaw)
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
    telegram: {
      botToken,
      allowedChatIds,
      requireTopics,
      webhookEnabled,
      webhookSecret,
      webhookHost,
      webhookPort,
    },
  };
}
