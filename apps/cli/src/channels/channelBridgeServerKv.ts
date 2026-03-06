/**
 * Channel bridge server-KV transport and schema helpers.
 *
 * Responsibilities:
 * - encode/decode scoped bridge documents stored in server KV
 * - validate supported schema versions for telegram config and binding docs
 * - provide optimistic-write friendly KV client helpers and conflict parsing
 * - keep bridge server payloads free of local-only secret fields
 */
import axios from 'axios';

import { resolveServerHttpBaseUrl } from '@/sessionControl/serverHttpBaseUrl';
import { isLoopbackHost } from '@/channels/telegram/telegramWebhookRelay';

import type { ScopedTelegramBridgeUpdate } from './channelBridgeAccountConfig';

const CHANNEL_BRIDGE_KV_PREFIX = 'happier:channel-bridge:v1';

const TELEGRAM_CONFIG_SCHEMA_VERSION = 1;
const BINDINGS_SCHEMA_VERSION = 1;

export type ChannelBridgeServerTelegramConfigRecord = Readonly<{
  schemaVersion: 1;
  tickMs?: number;
  telegram: Readonly<{
    allowedChatIds?: string[];
    requireTopics?: boolean;
    webhook?: Readonly<{
      enabled?: boolean;
      host?: string;
      port?: number;
    }>;
  }>;
  updatedAtMs: number;
}>;

export type ChannelBridgeServerBindingRecord = Readonly<{
  providerId: string;
  conversationId: string;
  threadId: string | null;
  sessionId: string;
  lastForwardedSeq: number;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type ChannelBridgeServerBindingsDocument = Readonly<{
  schemaVersion: 1;
  bindings: ChannelBridgeServerBindingRecord[];
}>;

export type ChannelBridgeKvGetResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export type ChannelBridgeKvMutateResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export type ChannelBridgeKvMutation = Readonly<{
  key: string;
  value: string | null;
  version: number;
}>;

export type ChannelBridgeKvClient = Readonly<{
  get: (key: string) => Promise<ChannelBridgeKvGetResponse>;
  mutate: (mutations: readonly ChannelBridgeKvMutation[]) => Promise<ChannelBridgeKvMutateResponse>;
}>;

export class ChannelBridgeKvVersionMismatchError extends Error {
  readonly currentVersion: number;
  readonly currentValueBase64: string | null;

  constructor(params: Readonly<{ key: string; currentVersion: number; currentValueBase64: string | null }>) {
    super(`KV version mismatch for key ${params.key}`);
    this.name = 'ChannelBridgeKvVersionMismatchError';
    this.currentVersion = params.currentVersion;
    this.currentValueBase64 = params.currentValueBase64;
  }
}

export class ChannelBridgeBadPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelBridgeBadPayloadError';
  }
}

function encodeJsonToBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodeBase64ToJson(valueBase64: string): unknown {
  try {
    const raw = Buffer.from(valueBase64, 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new ChannelBridgeBadPayloadError(
      error instanceof Error
        ? `Invalid channel bridge KV payload: ${error.message}`
        : 'Invalid channel bridge KV payload',
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeStringArray(values: readonly unknown[]): string[] {
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
}

function parseKvEntry(value: unknown): Readonly<{ valueBase64: string; version: number }> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.value !== 'string') return null;
  if (typeof record.version !== 'number' || !Number.isFinite(record.version)) return null;
  return {
    valueBase64: record.value,
    version: Math.trunc(record.version),
  };
}

function parseVersionMismatchError(value: unknown): Readonly<{ currentVersion: number; currentValueBase64: string | null }> | null {
  const record = asRecord(value);
  if (!record) return null;
  const errors = Array.isArray(record.errors) ? record.errors : null;
  if (!errors || errors.length === 0) return null;
  const first = asRecord(errors[0]);
  if (!first) return null;
  if (typeof first.version !== 'number' || !Number.isFinite(first.version)) return null;
  const currentValueBase64 = typeof first.value === 'string' ? first.value : null;
  return {
    currentVersion: Math.trunc(first.version),
    currentValueBase64,
  };
}

function assertSecureChannelBridgeKvBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid channel bridge KV base URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return;

  throw new Error(
    `Insecure channel bridge KV base URL: ${baseUrl}. Use https or explicit loopback http for local development.`,
  );
}

function parseTelegramConfigRecord(value: unknown): ChannelBridgeServerTelegramConfigRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schemaVersion !== TELEGRAM_CONFIG_SCHEMA_VERSION) return null;
  const telegram = asRecord(record.telegram);
  if (!telegram) return null;

  const out: {
    schemaVersion: 1;
    tickMs?: number;
    telegram: {
      allowedChatIds?: string[];
      requireTopics?: boolean;
      webhook?: {
        enabled?: boolean;
        host?: string;
        port?: number;
      };
    };
    updatedAtMs: number;
  } = {
    schemaVersion: 1,
    telegram: {},
    updatedAtMs: typeof record.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
      ? Math.trunc(record.updatedAtMs)
      : Date.now(),
  };

  if (typeof record.tickMs === 'number' && Number.isFinite(record.tickMs)) {
    out.tickMs = Math.trunc(record.tickMs);
  }

  if (Array.isArray(telegram.allowedChatIds)) {
    out.telegram.allowedChatIds = normalizeStringArray(telegram.allowedChatIds);
  }
  if (typeof telegram.requireTopics === 'boolean') {
    out.telegram.requireTopics = telegram.requireTopics;
  }

  const webhook = asRecord(telegram.webhook);
  if (webhook) {
    const outWebhook: { enabled?: boolean; host?: string; port?: number } = {};
    if (typeof webhook.enabled === 'boolean') outWebhook.enabled = webhook.enabled;
    if (typeof webhook.host === 'string') outWebhook.host = webhook.host;
    if (typeof webhook.port === 'number' && Number.isFinite(webhook.port)) outWebhook.port = Math.trunc(webhook.port);
    out.telegram.webhook = outWebhook;
  }

  return out;
}

function parseBindingsDocument(value: unknown): ChannelBridgeServerBindingsDocument | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schemaVersion !== BINDINGS_SCHEMA_VERSION) return null;
  const rawBindings = Array.isArray(record.bindings) ? record.bindings : null;
  if (!rawBindings) return null;

  const bindings: ChannelBridgeServerBindingRecord[] = [];
  for (let index = 0; index < rawBindings.length; index += 1) {
    const item = asRecord(rawBindings[index]);
    if (!item) {
      throw new ChannelBridgeBadPayloadError(`Invalid channel bridge binding entry at index ${index}`);
    }
    const providerId = typeof item.providerId === 'string' ? item.providerId.trim() : '';
    const conversationId = typeof item.conversationId === 'string' ? item.conversationId.trim() : '';
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
    if (!providerId || !conversationId || !sessionId) {
      throw new ChannelBridgeBadPayloadError(`Invalid channel bridge binding identity fields at index ${index}`);
    }

    if (
      typeof item.lastForwardedSeq !== 'number'
      || !Number.isFinite(item.lastForwardedSeq)
      || item.lastForwardedSeq < 0
    ) {
      throw new ChannelBridgeBadPayloadError(`Invalid channel bridge binding lastForwardedSeq at index ${index}`);
    }
    if (typeof item.createdAtMs !== 'number' || !Number.isFinite(item.createdAtMs)) {
      throw new ChannelBridgeBadPayloadError(`Invalid channel bridge binding createdAtMs at index ${index}`);
    }
    if (typeof item.updatedAtMs !== 'number' || !Number.isFinite(item.updatedAtMs)) {
      throw new ChannelBridgeBadPayloadError(`Invalid channel bridge binding updatedAtMs at index ${index}`);
    }

    if (
      item.threadId !== undefined
      && item.threadId !== null
      && typeof item.threadId !== 'string'
    ) {
      throw new ChannelBridgeBadPayloadError(`Invalid channel bridge binding threadId at index ${index}`);
    }

    const threadIdRaw = typeof item.threadId === 'string' ? item.threadId.trim() : '';
    const threadId = threadIdRaw.length > 0 ? threadIdRaw : null;
    const lastForwardedSeq = Math.trunc(item.lastForwardedSeq);
    const createdAtMs = Math.trunc(item.createdAtMs);
    const updatedAtMs = Math.trunc(item.updatedAtMs);
    bindings.push({
      providerId,
      conversationId,
      threadId,
      sessionId,
      lastForwardedSeq,
      createdAtMs,
      updatedAtMs,
    });
  }

  return {
    schemaVersion: 1,
    bindings,
  };
}

function telegramConfigKvKey(serverId: string): string {
  return `${CHANNEL_BRIDGE_KV_PREFIX}:server:${serverId}:telegram-config`;
}

function bindingsKvKey(serverId: string): string {
  return `${CHANNEL_BRIDGE_KV_PREFIX}:server:${serverId}:bindings`;
}

async function readJsonValue(params: Readonly<{
  kv: ChannelBridgeKvClient;
  key: string;
}>): Promise<Readonly<{ valueBase64: string | null; version: number }>> {
  const response = await params.kv.get(params.key);
  if (response.status === 404) {
    return { valueBase64: null, version: -1 };
  }
  if (response.status !== 200) {
    throw new Error(`KV read failed for ${params.key}: HTTP ${response.status}`);
  }

  const parsed = parseKvEntry(response.body);
  if (!parsed) {
    throw new Error(`KV read returned invalid payload for ${params.key}`);
  }
  return {
    valueBase64: parsed.valueBase64,
    version: parsed.version,
  };
}

async function writeJsonValue(params: Readonly<{
  kv: ChannelBridgeKvClient;
  key: string;
  valueBase64: string | null;
  expectedVersion: number;
}>): Promise<number> {
  const response = await params.kv.mutate([
    {
      key: params.key,
      value: params.valueBase64,
      version: params.expectedVersion,
    },
  ]);

  if (response.status === 200) {
    const body = asRecord(response.body);
    const results = body && Array.isArray(body.results) ? body.results : null;
    const first = results && results.length > 0 ? asRecord(results[0]) : null;
    if (!first || typeof first.version !== 'number' || !Number.isFinite(first.version)) {
      throw new Error(`KV write returned invalid success payload for ${params.key}`);
    }
    return Math.trunc(first.version);
  }

  if (response.status === 409) {
    const mismatch = parseVersionMismatchError(response.body);
    if (!mismatch) {
      throw new Error(`KV write version mismatch payload invalid for ${params.key}`);
    }
    throw new ChannelBridgeKvVersionMismatchError({
      key: params.key,
      currentVersion: mismatch.currentVersion,
      currentValueBase64: mismatch.currentValueBase64,
    });
  }

  throw new Error(`KV write failed for ${params.key}: HTTP ${response.status}`);
}

export function decodeChannelBridgeBindingsDocFromBase64(valueBase64: string | null): ChannelBridgeServerBindingsDocument {
  if (!valueBase64) {
    return { schemaVersion: 1, bindings: [] };
  }
  const parsed = parseBindingsDocument(decodeBase64ToJson(valueBase64));
  if (!parsed) {
    throw new ChannelBridgeBadPayloadError('Invalid or unsupported channel bridge bindings payload in KV');
  }
  return parsed;
}

export function createAxiosChannelBridgeKvClient(params: Readonly<{ token: string }>): ChannelBridgeKvClient {
  const token = params.token;
  const baseUrl = resolveServerHttpBaseUrl();
  assertSecureChannelBridgeKvBaseUrl(baseUrl);

  return {
    get: async (key) => {
      const response = await axios.get(`${baseUrl}/v1/kv/${encodeURIComponent(key)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
        validateStatus: () => true,
      });
      return {
        status: response.status,
        body: response.data,
      };
    },
    mutate: async (mutations) => {
      const response = await axios.post(`${baseUrl}/v1/kv`, {
        mutations,
      }, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
        validateStatus: () => true,
      });

      return {
        status: response.status,
        body: response.data,
      };
    },
  };
}

export async function readChannelBridgeTelegramConfigFromKv(params: Readonly<{
  kv: ChannelBridgeKvClient;
  serverId: string;
  allowUnsupportedSchema?: boolean;
}>): Promise<Readonly<{ record: ChannelBridgeServerTelegramConfigRecord | null; version: number }>> {
  const key = telegramConfigKvKey(params.serverId);
  const row = await readJsonValue({ kv: params.kv, key });
  if (!row.valueBase64) {
    return { record: null, version: row.version };
  }

  let decoded: unknown;
  try {
    decoded = decodeBase64ToJson(row.valueBase64);
  } catch (error) {
    if (params.allowUnsupportedSchema && error instanceof ChannelBridgeBadPayloadError) {
      return { record: null, version: row.version };
    }
    throw error;
  }

  const parsed = parseTelegramConfigRecord(decoded);
  if (!parsed) {
    if (params.allowUnsupportedSchema) {
      return { record: null, version: row.version };
    }
    throw new Error(`Invalid or unsupported Telegram config schema for key ${key}`);
  }

  return {
    record: parsed,
    version: row.version,
  };
}

function applyTelegramConfigUpdate(current: ChannelBridgeServerTelegramConfigRecord | null, update: ScopedTelegramBridgeUpdate): ChannelBridgeServerTelegramConfigRecord {
  const next: {
    schemaVersion: 1;
    tickMs?: number;
    telegram: {
      allowedChatIds?: string[];
      requireTopics?: boolean;
      webhook?: {
        enabled?: boolean;
        host?: string;
        port?: number;
      };
    };
    updatedAtMs: number;
  } = {
    schemaVersion: 1,
    telegram: {
      ...(current?.telegram ?? {}),
    },
    updatedAtMs: Date.now(),
  };

  if (typeof current?.tickMs === 'number') {
    next.tickMs = current.tickMs;
  }
  if (typeof update.tickMs === 'number' && Number.isFinite(update.tickMs)) {
    next.tickMs = Math.trunc(update.tickMs);
  }

  if (Array.isArray(update.allowedChatIds)) {
    next.telegram.allowedChatIds = normalizeStringArray(update.allowedChatIds);
  }
  if (typeof update.requireTopics === 'boolean') {
    next.telegram.requireTopics = update.requireTopics;
  }

  const hasWebhookUpdate =
    typeof update.webhookEnabled === 'boolean'
    || typeof update.webhookHost === 'string'
    || (typeof update.webhookPort === 'number' && Number.isFinite(update.webhookPort));

  if (hasWebhookUpdate) {
    const nextWebhook = {
      ...(current?.telegram?.webhook ?? {}),
    };
    if (typeof update.webhookEnabled === 'boolean') {
      nextWebhook.enabled = update.webhookEnabled;
    }
    if (typeof update.webhookHost === 'string') {
      nextWebhook.host = update.webhookHost;
    }
    if (typeof update.webhookPort === 'number' && Number.isFinite(update.webhookPort)) {
      nextWebhook.port = Math.trunc(update.webhookPort);
    }
    next.telegram.webhook = nextWebhook;
  }

  return next;
}

function hasNonSecretTelegramConfigUpdate(update: ScopedTelegramBridgeUpdate): boolean {
  return (
    (typeof update.tickMs === 'number' && Number.isFinite(update.tickMs))
    || Array.isArray(update.allowedChatIds)
    || typeof update.requireTopics === 'boolean'
    || typeof update.webhookEnabled === 'boolean'
    || typeof update.webhookHost === 'string'
    || (typeof update.webhookPort === 'number' && Number.isFinite(update.webhookPort))
  );
}

export async function upsertChannelBridgeTelegramConfigInKv(params: Readonly<{
  kv: ChannelBridgeKvClient;
  serverId: string;
  update: ScopedTelegramBridgeUpdate;
}>): Promise<void> {
  if (!hasNonSecretTelegramConfigUpdate(params.update)) {
    return;
  }

  const key = telegramConfigKvKey(params.serverId);
  let current: Readonly<{
    record: ChannelBridgeServerTelegramConfigRecord | null;
    version: number;
  }> | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (current === null) {
      current = await readChannelBridgeTelegramConfigFromKv({
        kv: params.kv,
        serverId: params.serverId,
        allowUnsupportedSchema: true,
      });
    }

    const nextRecord = applyTelegramConfigUpdate(current.record, params.update);
    const nextValueBase64 = encodeJsonToBase64(nextRecord);

    try {
      await writeJsonValue({
        kv: params.kv,
        key,
        valueBase64: nextValueBase64,
        expectedVersion: current.version,
      });
      return;
    } catch (error) {
      if (error instanceof ChannelBridgeKvVersionMismatchError) {
        try {
          const conflictRecord = error.currentValueBase64 === null
            ? null
            : parseTelegramConfigRecord(decodeBase64ToJson(error.currentValueBase64));
          current = {
            record: conflictRecord,
            version: error.currentVersion,
          };
        } catch {
          current = null;
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error('Failed to upsert channel bridge telegram config in KV after retries');
}

export async function clearChannelBridgeTelegramConfigInKv(params: Readonly<{
  kv: ChannelBridgeKvClient;
  serverId: string;
}>): Promise<void> {
  const key = telegramConfigKvKey(params.serverId);
  const current = await readChannelBridgeTelegramConfigFromKv({
    kv: params.kv,
    serverId: params.serverId,
    allowUnsupportedSchema: true,
  });
  let expectedVersion = current.version;
  if (expectedVersion < 0) return;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await writeJsonValue({
        kv: params.kv,
        key,
        valueBase64: null,
        expectedVersion,
      });
      return;
    } catch (error) {
      if (error instanceof ChannelBridgeKvVersionMismatchError) {
        if (error.currentVersion < 0) {
          return;
        }
        expectedVersion = error.currentVersion;
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to clear channel bridge telegram config in KV after retries');
}

export async function readChannelBridgeBindingsFromKv(params: Readonly<{
  kv: ChannelBridgeKvClient;
  serverId: string;
}>): Promise<Readonly<{ doc: ChannelBridgeServerBindingsDocument; version: number }>> {
  const key = bindingsKvKey(params.serverId);
  const row = await readJsonValue({ kv: params.kv, key });
  return {
    doc: decodeChannelBridgeBindingsDocFromBase64(row.valueBase64),
    version: row.version,
  };
}

export async function writeChannelBridgeBindingsToKv(params: Readonly<{
  kv: ChannelBridgeKvClient;
  serverId: string;
  expectedVersion: number;
  doc: ChannelBridgeServerBindingsDocument;
}>): Promise<number> {
  const key = bindingsKvKey(params.serverId);
  const valueBase64 = encodeJsonToBase64(params.doc);
  return await writeJsonValue({
    kv: params.kv,
    key,
    valueBase64,
    expectedVersion: params.expectedVersion,
  });
}
