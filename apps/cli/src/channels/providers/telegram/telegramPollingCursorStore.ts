import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { logger } from '@/ui/logger';

type StoredTelegramPollingCursorDocV1 = Readonly<{
  schemaVersion: 1;
  updateOffset: number;
}>;

const STORE_SCHEMA_VERSION = 1;
const BOT_TOKEN_HASH_LENGTH = 32;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated >= 0 ? truncated : null;
}

function parseStoredDoc(value: unknown): StoredTelegramPollingCursorDocV1 | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schemaVersion !== STORE_SCHEMA_VERSION) return null;
  const updateOffset = toNonNegativeInt(record.updateOffset);
  if (updateOffset === null) return null;
  return { schemaVersion: 1, updateOffset };
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

function resolveCursorFile(botToken: string): string {
  const tokenHash = hashBotToken(botToken);
  return join(configuration.activeServerDir, 'channel-bridges', 'v1', 'telegram', 'polling-cursors', `${tokenHash}.json`);
}

export type TelegramPollingCursorStore = Readonly<{
  load: () => Promise<number | null>;
  save: (offset: number) => Promise<void>;
}>;

export function createTelegramPollingCursorStore(params: Readonly<{ botToken: string }>): TelegramPollingCursorStore {
  const cursorFile = resolveCursorFile(params.botToken);
  let queue = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    load: () => enqueue(async () => {
      try {
        const raw = await readFile(cursorFile, { encoding: 'utf-8' }).catch((error: unknown) => {
          const err = error as NodeJS.ErrnoException;
          if (err?.code === 'ENOENT') return null;
          throw error;
        });
        const parsed = raw ? parseStoredDoc(JSON.parse(raw)) : null;
        return parsed?.updateOffset ?? null;
      } catch (error) {
        logger.warn('[channelBridge] Failed to read Telegram polling cursor; treating cursor as missing', error);
        return null;
      }
    }),
    save: (offset) => enqueue(async () => {
      const candidate = toNonNegativeInt(offset);
      if (candidate === null) {
        throw new Error('Invalid Telegram polling cursor offset');
      }

      const telegramDir = join(configuration.activeServerDir, 'channel-bridges', 'v1', 'telegram');
      const cursorsDir = join(telegramDir, 'polling-cursors');
      await mkdir(cursorsDir, { recursive: true, mode: 0o700 });
      await bestEffortChmod0700(configuration.activeServerDir);

      const doc: StoredTelegramPollingCursorDocV1 = {
        schemaVersion: 1,
        updateOffset: candidate,
      };
      await writeJsonAtomic(cursorFile, doc);
      await bestEffortChmod0700(join(configuration.activeServerDir, 'channel-bridges'));
      await bestEffortChmod0700(join(configuration.activeServerDir, 'channel-bridges', 'v1'));
      await bestEffortChmod0700(telegramDir);
      await bestEffortChmod0700(cursorsDir);
    }),
  };
}
