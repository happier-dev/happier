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
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  return out;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim();
}

function mergeRecords(levels: Array<RecordLike | null>): RecordLike | null {
  const merged: RecordLike = {};
  let hasAny = false;
  for (const level of levels) {
    if (!level) continue;
    hasAny = true;
    Object.assign(merged, level);
  }
  return hasAny ? merged : null;
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
  const telegram = mergeRecords([telegramGlobal, telegramServer, telegramAccount]);

  const secretsGlobal = asRecord(telegramGlobal?.secrets);
  const secretsServer = asRecord(telegramServer?.secrets);
  const secretsAccount = asRecord(telegramAccount?.secrets);
  const secrets = mergeRecords([secretsGlobal, secretsServer, secretsAccount]);

  const webhookGlobal = asRecord(telegramGlobal?.webhook);
  const webhookServer = asRecord(telegramServer?.webhook);
  const webhookAccount = asRecord(telegramAccount?.webhook);
  const webhook = mergeRecords([webhookGlobal, webhookServer, webhookAccount]);

  const settingsTickMs =
    parseInteger(channelBridgeAccount?.tickMs, 250, 60_000)
    ?? parseInteger(channelBridgeServer?.tickMs, 250, 60_000)
    ?? parseInteger(channelBridgeGlobal?.tickMs, 250, 60_000);
  const envTickMs =
    typeof env.HAPPIER_CHANNEL_BRIDGE_TICK_MS === 'string'
      ? parseStrictInteger(env.HAPPIER_CHANNEL_BRIDGE_TICK_MS, 250, 60_000)
      : null;
  const tickMs = envTickMs ?? settingsTickMs ?? 2_500;

  const settingsBotToken =
    readTrimmedString(secrets?.botToken)
    ?? readTrimmedString(telegram?.botToken)
    ?? '';
  const botToken =
    typeof env.HAPPIER_TELEGRAM_BOT_TOKEN === 'string'
      ? env.HAPPIER_TELEGRAM_BOT_TOKEN.trim()
      : settingsBotToken;

  const settingsAllowedChatIds = parseStringArray(telegram?.allowedChatIds) ?? [];
  const allowedChatIds =
    typeof env.HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS === 'string'
      ? parseCsv(env.HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS)
      : settingsAllowedChatIds;

  const settingsRequireTopics = parseBoolean(telegram?.requireTopics) ?? false;
  const envRequireTopics =
    typeof env.HAPPIER_TELEGRAM_REQUIRE_TOPICS === 'string'
      ? parseBoolean(env.HAPPIER_TELEGRAM_REQUIRE_TOPICS)
      : null;
  const requireTopics = envRequireTopics ?? settingsRequireTopics;

  const settingsWebhookEnabled = parseBoolean(webhook?.enabled) ?? false;
  const envWebhookEnabled =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_ENABLED === 'string'
      ? parseBoolean(env.HAPPIER_TELEGRAM_WEBHOOK_ENABLED)
      : null;
  const webhookEnabled = envWebhookEnabled ?? settingsWebhookEnabled;

  const settingsWebhookSecret =
    readTrimmedString(secrets?.webhookSecret)
    ?? readTrimmedString(webhook?.secret)
    ?? '';
  const webhookSecret =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_SECRET === 'string'
      ? env.HAPPIER_TELEGRAM_WEBHOOK_SECRET.trim()
      : settingsWebhookSecret;

  const settingsWebhookHost = readTrimmedString(webhook?.host) || '127.0.0.1';
  const envWebhookHostRaw =
    typeof env.HAPPIER_TELEGRAM_WEBHOOK_HOST === 'string'
      ? env.HAPPIER_TELEGRAM_WEBHOOK_HOST.trim()
      : null;
  const webhookHost = envWebhookHostRaw ? envWebhookHostRaw : settingsWebhookHost;

  const settingsWebhookPort = parseInteger(webhook?.port, 1, 65_535) ?? 8_787;
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
