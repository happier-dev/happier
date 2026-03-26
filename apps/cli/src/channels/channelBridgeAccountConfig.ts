/**
 * Scoped channel bridge account configuration helpers.
 *
 * Responsibilities:
 * - split bridge updates into local-secret and shared KV-safe payloads
 * - read normalized account-scoped bridge config from settings
 * - upsert/remove account-scoped bridge config trees under server/account scope
 *
 * Secrets remain local-only and are never emitted into shared payload helpers.
 */
type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecordLike;
}

function deepCloneRoot(value: unknown): RecordLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as RecordLike;
}

function ensureRecord(parent: RecordLike, key: string): RecordLike {
  const existing = asRecord(parent[key]);
  if (existing) return existing;
  const created: RecordLike = {};
  parent[key] = created;
  return created;
}

function isEmptyRecord(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return Object.keys(record).length === 0;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

export type ScopedTelegramBridgeUpdate = Readonly<{
  tickMs?: number;
  botToken?: string;
  allowedChatIds?: string[];
  allowAllSharedChats?: boolean;
  requireTopics?: boolean;
  webhookEnabled?: boolean;
  webhookSecret?: string;
  webhookHost?: string;
  webhookPort?: number;
}>;

export type SharedTelegramBridgeUpdate = Readonly<{
  tickMs?: number;
  allowedChatIds?: string[];
  allowAllSharedChats?: boolean;
  requireTopics?: boolean;
  webhookEnabled?: boolean;
  webhookHost?: string;
  webhookPort?: number;
}>;

function hasAnyUpdateValue(update: Record<string, unknown>): boolean {
  return Object.values(update).some((value) => value !== undefined);
}

export function splitScopedTelegramBridgeUpdate(params: Readonly<{
  update: ScopedTelegramBridgeUpdate;
}>): Readonly<{ localUpdate: ScopedTelegramBridgeUpdate; sharedUpdate: SharedTelegramBridgeUpdate }> {
  const source = params.update;
  const localUpdate: {
    tickMs?: number;
    botToken?: string;
    allowedChatIds?: string[];
    allowAllSharedChats?: boolean;
    requireTopics?: boolean;
    webhookEnabled?: boolean;
    webhookSecret?: string;
    webhookHost?: string;
    webhookPort?: number;
  } = {};
  const sharedUpdate: {
    tickMs?: number;
    allowedChatIds?: string[];
    allowAllSharedChats?: boolean;
    requireTopics?: boolean;
    webhookEnabled?: boolean;
    webhookHost?: string;
    webhookPort?: number;
  } = {};

  if (typeof source.tickMs === 'number' && Number.isFinite(source.tickMs)) {
    const value = Math.trunc(source.tickMs);
    localUpdate.tickMs = value;
    sharedUpdate.tickMs = value;
  }
  if (typeof source.botToken === 'string') {
    localUpdate.botToken = source.botToken;
  }
  if (Array.isArray(source.allowedChatIds)) {
    localUpdate.allowedChatIds = [...source.allowedChatIds];
    sharedUpdate.allowedChatIds = [...source.allowedChatIds];
  }
  if (typeof source.allowAllSharedChats === 'boolean') {
    localUpdate.allowAllSharedChats = source.allowAllSharedChats;
    sharedUpdate.allowAllSharedChats = source.allowAllSharedChats;
  }
  if (typeof source.requireTopics === 'boolean') {
    localUpdate.requireTopics = source.requireTopics;
    sharedUpdate.requireTopics = source.requireTopics;
  }
  if (typeof source.webhookEnabled === 'boolean') {
    localUpdate.webhookEnabled = source.webhookEnabled;
    sharedUpdate.webhookEnabled = source.webhookEnabled;
  }
  if (typeof source.webhookSecret === 'string') {
    localUpdate.webhookSecret = source.webhookSecret;
  }
  if (typeof source.webhookHost === 'string') {
    localUpdate.webhookHost = source.webhookHost;
    sharedUpdate.webhookHost = source.webhookHost;
  }
  if (typeof source.webhookPort === 'number' && Number.isFinite(source.webhookPort)) {
    const value = Math.trunc(source.webhookPort);
    localUpdate.webhookPort = value;
    sharedUpdate.webhookPort = value;
  }

  return {
    localUpdate,
    sharedUpdate,
  };
}

export function hasSharedTelegramBridgeUpdate(params: Readonly<{ update: SharedTelegramBridgeUpdate }>): boolean {
  return hasAnyUpdateValue(params.update as Record<string, unknown>);
}

export function readScopedTelegramBridgeConfig(params: Readonly<{
  settings: unknown;
  serverId: string;
  accountId: string;
}>): RecordLike | null {
  const root = asRecord(params.settings);
  const channelBridge = asRecord(root?.channelBridge);
  const byServerId = asRecord(channelBridge?.byServerId);
  const serverScope = asRecord(byServerId?.[params.serverId]);
  const byAccountId = asRecord(serverScope?.byAccountId);
  const accountScope = asRecord(byAccountId?.[params.accountId]);
  const providers = asRecord(accountScope?.providers);
  const telegram = asRecord(providers?.telegram);
  if (!telegram) return null;

  const secrets = asRecord(telegram.secrets);
  const botToken =
    typeof secrets?.botToken === 'string'
      ? secrets.botToken
      : typeof telegram.botToken === 'string'
        ? telegram.botToken
        : undefined;

  const webhook = asRecord(telegram.webhook);
  const webhookSecret =
    typeof secrets?.webhookSecret === 'string'
      ? secrets.webhookSecret
      : typeof webhook?.secret === 'string'
        ? webhook.secret
        : undefined;

  const normalized: RecordLike = {};

  if (typeof accountScope?.tickMs === 'number' && Number.isFinite(accountScope.tickMs)) {
    normalized.tickMs = Math.trunc(accountScope.tickMs);
  }

  if (typeof botToken === 'string') {
    normalized.botToken = botToken;
  }

  const allowedChatIds = parseStringArray(telegram.allowedChatIds);
  if (allowedChatIds.length > 0 || Array.isArray(telegram.allowedChatIds)) {
    normalized.allowedChatIds = allowedChatIds;
  }

  if (typeof telegram.requireTopics === 'boolean') {
    normalized.requireTopics = telegram.requireTopics;
  }

  if (typeof telegram.allowAllSharedChats === 'boolean') {
    normalized.allowAllSharedChats = telegram.allowAllSharedChats;
  }

  const normalizedWebhook: RecordLike = {};
  if (typeof webhook?.enabled === 'boolean') {
    normalizedWebhook.enabled = webhook.enabled;
  }
  if (typeof webhookSecret === 'string') {
    normalizedWebhook.secret = webhookSecret;
  }
  if (typeof webhook?.host === 'string') {
    normalizedWebhook.host = webhook.host;
  }
  if (typeof webhook?.port === 'number' && Number.isFinite(webhook.port)) {
    normalizedWebhook.port = Math.trunc(webhook.port);
  }

  if (Object.keys(normalizedWebhook).length > 0) {
    normalized.webhook = normalizedWebhook;
  }

  return normalized;
}

export function upsertScopedTelegramBridgeConfig<T extends object>(params: Readonly<{
  settings: T;
  serverId: string;
  accountId: string;
  update: ScopedTelegramBridgeUpdate;
}>): T;

export function upsertScopedTelegramBridgeConfig(params: Readonly<{
  settings: unknown;
  serverId: string;
  accountId: string;
  update: ScopedTelegramBridgeUpdate;
}>): RecordLike;

export function upsertScopedTelegramBridgeConfig(params: Readonly<{
  settings: unknown;
  serverId: string;
  accountId: string;
  update: ScopedTelegramBridgeUpdate;
}>): RecordLike {
  const root = deepCloneRoot(params.settings);

  const channelBridge = ensureRecord(root, 'channelBridge');
  const byServerId = ensureRecord(channelBridge, 'byServerId');
  const serverScope = ensureRecord(byServerId, params.serverId);
  const byAccountId = ensureRecord(serverScope, 'byAccountId');
  const accountScope = ensureRecord(byAccountId, params.accountId);

  if (typeof params.update.tickMs === 'number' && Number.isFinite(params.update.tickMs)) {
    accountScope.tickMs = Math.trunc(params.update.tickMs);
  }

  let cachedTelegramScope: RecordLike | null = null;
  const ensureTelegramScope = (): RecordLike => {
    if (cachedTelegramScope) return cachedTelegramScope;
    const providers = ensureRecord(accountScope, 'providers');
    cachedTelegramScope = ensureRecord(providers, 'telegram');
    return cachedTelegramScope;
  };

  if (Array.isArray(params.update.allowedChatIds)) {
    const telegram = ensureTelegramScope();
    telegram.allowedChatIds = parseStringArray(params.update.allowedChatIds);
  }
  if (typeof params.update.allowAllSharedChats === 'boolean') {
    const telegram = ensureTelegramScope();
    telegram.allowAllSharedChats = params.update.allowAllSharedChats;
  }
  if (typeof params.update.requireTopics === 'boolean') {
    const telegram = ensureTelegramScope();
    telegram.requireTopics = params.update.requireTopics;
  }

  const hasWebhookUpdate =
    typeof params.update.webhookEnabled === 'boolean'
    || typeof params.update.webhookHost === 'string'
    || (typeof params.update.webhookPort === 'number' && Number.isFinite(params.update.webhookPort));

  if (hasWebhookUpdate) {
    const telegram = ensureTelegramScope();
    const webhook = ensureRecord(telegram, 'webhook');
    if (typeof params.update.webhookEnabled === 'boolean') {
      webhook.enabled = params.update.webhookEnabled;
    }
    if (typeof params.update.webhookHost === 'string') {
      webhook.host = params.update.webhookHost;
    }
    if (typeof params.update.webhookPort === 'number' && Number.isFinite(params.update.webhookPort)) {
      webhook.port = Math.trunc(params.update.webhookPort);
    }
  }

  const hasSecretUpdate =
    typeof params.update.botToken === 'string'
    || typeof params.update.webhookSecret === 'string';

  if (hasSecretUpdate) {
    const telegram = ensureTelegramScope();
    const secrets = ensureRecord(telegram, 'secrets');
    if (typeof params.update.botToken === 'string') {
      secrets.botToken = params.update.botToken;
      if ('botToken' in telegram) {
        delete telegram.botToken;
      }
    }
    if (typeof params.update.webhookSecret === 'string') {
      secrets.webhookSecret = params.update.webhookSecret;
      const webhook = asRecord(telegram.webhook);
      if (webhook && 'secret' in webhook) {
        delete webhook.secret;
      }
    }
  }

  return root;
}

export function removeScopedTelegramBridgeConfig<T extends object>(params: Readonly<{
  settings: T;
  serverId: string;
  accountId: string;
}>): T;

export function removeScopedTelegramBridgeConfig(params: Readonly<{
  settings: unknown;
  serverId: string;
  accountId: string;
}>): RecordLike;

export function removeScopedTelegramBridgeConfig(params: Readonly<{
  settings: unknown;
  serverId: string;
  accountId: string;
}>): RecordLike {
  const root = deepCloneRoot(params.settings);

  const channelBridge = asRecord(root.channelBridge);
  const byServerId = asRecord(channelBridge?.byServerId);
  const serverScope = asRecord(byServerId?.[params.serverId]);
  const byAccountId = asRecord(serverScope?.byAccountId);
  const accountScope = asRecord(byAccountId?.[params.accountId]);
  const providers = asRecord(accountScope?.providers);

  if (accountScope && 'tickMs' in accountScope) {
    delete accountScope.tickMs;
  }
  if (providers && 'telegram' in providers) {
    delete providers.telegram;
  }

  if (providers && isEmptyRecord(providers) && accountScope) {
    delete accountScope.providers;
  }
  if (isEmptyRecord(accountScope) && byAccountId) {
    delete byAccountId[params.accountId];
  }
  if (isEmptyRecord(byAccountId) && serverScope) {
    delete serverScope.byAccountId;
  }
  if (isEmptyRecord(serverScope) && byServerId) {
    delete byServerId[params.serverId];
  }
  if (isEmptyRecord(byServerId) && channelBridge) {
    delete channelBridge.byServerId;
  }
  if (isEmptyRecord(channelBridge)) {
    delete root.channelBridge;
  }

  return root;
}
