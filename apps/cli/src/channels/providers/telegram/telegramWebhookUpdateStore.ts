import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { assertFilesystemSafeAccountId } from '@/channels/state/assertFilesystemSafeAccountId';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { logger } from '@/ui/logger';

type RecordLike = Record<string, unknown>;

export type TelegramWebhookUpdateStoreSnapshot = Readonly<{
  lastHandledWebhookUpdateId: number | null;
  nextQueuedWebhookId: number;
  queuedWebhookUpdates: readonly Readonly<{
    id: number;
    update: unknown;
  }>[];
}>;

export type TelegramWebhookUpdateStore = Readonly<{
  load: () => Promise<TelegramWebhookUpdateStoreSnapshot | null>;
  save: (snapshot: TelegramWebhookUpdateStoreSnapshot) => Promise<void>;
}>;

type StoredTelegramWebhookUpdateDocV1 = Readonly<{
  schemaVersion: 1;
  lastHandledWebhookUpdateId: number | null;
  nextQueuedWebhookId: number;
  queuedWebhookUpdates: Array<Readonly<{
    id: number;
    update: unknown;
  }>>;
}>;

const STORE_SCHEMA_VERSION = 1;
const BOT_TOKEN_HASH_LENGTH = 32;

function asRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecordLike;
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated >= 0 ? truncated : null;
}

function toPositiveInt(value: unknown): number | null {
  const candidate = toNonNegativeInt(value);
  return candidate !== null && candidate > 0 ? candidate : null;
}

function parseStoredDoc(value: unknown): StoredTelegramWebhookUpdateDocV1 | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schemaVersion !== STORE_SCHEMA_VERSION) return null;

  const queuedWebhookUpdatesRaw = Array.isArray(record.queuedWebhookUpdates) ? record.queuedWebhookUpdates : [];
  const queuedWebhookUpdates: StoredTelegramWebhookUpdateDocV1['queuedWebhookUpdates'] = [];
  let maxQueuedWebhookId = 0;

  for (const entry of queuedWebhookUpdatesRaw) {
    const row = asRecord(entry);
    if (!row) continue;
    const id = toPositiveInt(row.id);
    if (id === null) continue;
    queuedWebhookUpdates.push({
      id,
      update: row.update,
    });
    if (id > maxQueuedWebhookId) {
      maxQueuedWebhookId = id;
    }
  }

  queuedWebhookUpdates.sort((left, right) => left.id - right.id);

  const nextQueuedWebhookIdCandidate = toPositiveInt(record.nextQueuedWebhookId);
  const nextQueuedWebhookId = Math.max(
    maxQueuedWebhookId + 1,
    nextQueuedWebhookIdCandidate === null ? 1 : nextQueuedWebhookIdCandidate,
  );

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    lastHandledWebhookUpdateId: toNonNegativeInt(record.lastHandledWebhookUpdateId),
    nextQueuedWebhookId,
    queuedWebhookUpdates,
  };
}

function hashBotToken(botToken: string): string {
  const normalized = botToken.trim();
  if (!normalized) {
    throw new Error('Telegram bot token is required');
  }
  return createHash('sha256').update(normalized).digest('hex').slice(0, BOT_TOKEN_HASH_LENGTH);
}

async function bestEffortChmod0700(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o700).catch(() => {});
}

function resolveStoreFilePath(accountId: string, botToken: string): string {
  const tokenHash = hashBotToken(botToken);
  return join(
    configuration.activeServerDir,
    'channel-bridges',
    'v1',
    'account',
    accountId,
    'providers',
    'telegram',
    'webhook-updates',
    `${tokenHash}.json`,
  );
}

function snapshotToDoc(snapshot: TelegramWebhookUpdateStoreSnapshot): StoredTelegramWebhookUpdateDocV1 {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    lastHandledWebhookUpdateId: snapshot.lastHandledWebhookUpdateId === null
      ? null
      : Math.max(0, Math.trunc(snapshot.lastHandledWebhookUpdateId)),
    nextQueuedWebhookId: Math.max(1, Math.trunc(snapshot.nextQueuedWebhookId)),
    queuedWebhookUpdates: snapshot.queuedWebhookUpdates.map((row) => ({
      id: Math.max(1, Math.trunc(row.id)),
      update: row.update,
    })),
  };
}

export function createTelegramWebhookUpdateStore(params: Readonly<{ accountId: string; botToken: string }>): TelegramWebhookUpdateStore {
  const accountId = assertFilesystemSafeAccountId(params.accountId);
  const updateFile = resolveStoreFilePath(accountId, params.botToken);
  let queue = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    load: () => enqueue(async () => {
      try {
        const raw = await readFile(updateFile, { encoding: 'utf-8' }).catch((error: unknown) => {
          const err = error as NodeJS.ErrnoException;
          if (err?.code === 'ENOENT') return null;
          throw error;
        });
        const parsed = raw ? parseStoredDoc(JSON.parse(raw)) : null;
        return parsed
          ? {
              lastHandledWebhookUpdateId: parsed.lastHandledWebhookUpdateId,
              nextQueuedWebhookId: parsed.nextQueuedWebhookId,
              queuedWebhookUpdates: parsed.queuedWebhookUpdates.map((row) => ({
                id: row.id,
                update: row.update,
              })),
            }
          : null;
      } catch (error) {
        logger.warn('[channelBridge] Failed to read Telegram webhook update queue; treating queue as missing', error);
        return null;
      }
    }),
    save: (snapshot) => enqueue(async () => {
      const doc = snapshotToDoc(snapshot);
      const accountDir = join(configuration.activeServerDir, 'channel-bridges', 'v1', 'account', accountId);
      const telegramDir = join(accountDir, 'providers', 'telegram');
      const updatesDir = join(telegramDir, 'webhook-updates');

      await mkdir(updatesDir, { recursive: true, mode: 0o700 });
      await bestEffortChmod0700(configuration.activeServerDir);

      await writeJsonAtomic(updateFile, doc);
      await bestEffortChmod0700(join(configuration.activeServerDir, 'channel-bridges'));
      await bestEffortChmod0700(join(configuration.activeServerDir, 'channel-bridges', 'v1'));
      await bestEffortChmod0700(accountDir);
      await bestEffortChmod0700(updatesDir);
    }),
  };
}
