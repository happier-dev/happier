import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChannelBindingStore, ChannelBridgeConversationRef, ChannelSessionBinding } from '@/channels/core/channelBridgeWorker';
import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { logger } from '@/ui/logger';

type RecordLike = Record<string, unknown>;

type StoredBindingsDocV1 = Readonly<{
  schemaVersion: 1;
  bindings: Array<Readonly<{
    providerId: string;
    conversationId: string;
    threadId: string | null;
    sessionId: string;
    lastForwardedSeq: number;
    ownerSenderId: string | null;
    inboundMode: 'ownerOnly' | 'anyone';
    allowMissingSenderId: boolean;
    createdAtMs: number;
    updatedAtMs: number;
  }>>;
}>;

const ACCOUNT_ID_SAFE_RE = /^[A-Za-z0-9._-]{1,128}$/;

function assertFilesystemSafeAccountId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error('Invalid accountId: empty');
  }
  if (value === '.' || value === '..') {
    throw new Error(`Invalid accountId: ${value}`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`Invalid accountId: ${value}`);
  }
  if (!ACCOUNT_ID_SAFE_RE.test(value)) {
    throw new Error(`Invalid accountId: ${value}`);
  }
  return value;
}

function asRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecordLike;
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  if (truncated < 0) return null;
  return truncated;
}

function bindingKey(ref: ChannelBridgeConversationRef): string {
  return JSON.stringify([ref.providerId, ref.conversationId, ref.threadId]);
}

function cloneBinding(binding: ChannelSessionBinding): ChannelSessionBinding {
  return {
    providerId: binding.providerId,
    conversationId: binding.conversationId,
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    lastForwardedSeq: binding.lastForwardedSeq,
    ownerSenderId: binding.ownerSenderId,
    inboundMode: binding.inboundMode,
    allowMissingSenderId: binding.allowMissingSenderId,
    createdAtMs: binding.createdAtMs,
    updatedAtMs: binding.updatedAtMs,
  };
}

function cloneBindings(bindings: readonly ChannelSessionBinding[]): ChannelSessionBinding[] {
  return bindings.map((binding) => cloneBinding(binding));
}

function parseStoredBindingsDoc(value: unknown): StoredBindingsDocV1 | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schemaVersion !== 1) return null;
  const bindingsRaw = record.bindings;
  if (!Array.isArray(bindingsRaw)) return null;

  const bindings: StoredBindingsDocV1['bindings'] = [];
  for (const entry of bindingsRaw) {
    const row = asRecord(entry);
    if (!row) continue;
    if (typeof row.providerId !== 'string' || row.providerId.trim().length === 0) continue;
    if (typeof row.conversationId !== 'string' || row.conversationId.trim().length === 0) continue;
    if (typeof row.sessionId !== 'string' || row.sessionId.trim().length === 0) continue;
    const threadId =
      row.threadId === null
        ? null
        : typeof row.threadId === 'string' && row.threadId.trim().length > 0
          ? row.threadId.trim()
          : null;
    const lastForwardedSeq = toNonNegativeInt(row.lastForwardedSeq) ?? 0;
    const ownerSenderId =
      typeof row.ownerSenderId === 'string' && row.ownerSenderId.trim().length > 0
        ? row.ownerSenderId.trim()
        : null;
    const inboundMode = row.inboundMode === 'anyone' ? 'anyone' : 'ownerOnly';
    const allowMissingSenderId = row.allowMissingSenderId === true;
    const createdAtMs = toNonNegativeInt(row.createdAtMs) ?? Date.now();
    const updatedAtMs = toNonNegativeInt(row.updatedAtMs) ?? createdAtMs;
    bindings.push({
      providerId: row.providerId.trim(),
      conversationId: row.conversationId.trim(),
      threadId,
      sessionId: row.sessionId.trim(),
      lastForwardedSeq,
      ownerSenderId,
      inboundMode,
      allowMissingSenderId,
      createdAtMs,
      updatedAtMs,
    });
  }

  return {
    schemaVersion: 1,
    bindings,
  };
}

async function bestEffortChmod0700(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o700).catch(() => {});
}

function resolveBindingsFilePath(accountId: string): string {
  return join(configuration.activeServerDir, 'channel-bridges', 'v1', 'account', accountId, 'bindings.json');
}

type BindingCache = Readonly<{
  bindings: ChannelSessionBinding[];
  fetchedAtMs: number;
}>;

export function createLocalChannelBindingStore(params: Readonly<{
  accountId: string;
  cacheTtlMs?: number;
}>): ChannelBindingStore {
  const accountId = assertFilesystemSafeAccountId(params.accountId);
  const cacheTtlMs = typeof params.cacheTtlMs === 'number' ? Math.max(0, Math.trunc(params.cacheTtlMs)) : 1_000;
  const bindingsFile = resolveBindingsFilePath(accountId);
  let cache: BindingCache | null = null;
  let queue = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  async function load(forceRefresh: boolean): Promise<BindingCache> {
    if (!forceRefresh && cache && Date.now() - cache.fetchedAtMs <= cacheTtlMs) {
      return cache;
    }

    try {
      const raw = await readFile(bindingsFile, { encoding: 'utf-8' }).catch((error: unknown) => {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') return null;
        throw error;
      });
      const parsed = raw ? parseStoredBindingsDoc(JSON.parse(raw)) : null;
      const next: BindingCache = {
        bindings: parsed ? parsed.bindings.map((binding) => ({
          providerId: binding.providerId,
          conversationId: binding.conversationId,
          threadId: binding.threadId,
          sessionId: binding.sessionId,
          lastForwardedSeq: binding.lastForwardedSeq,
          ownerSenderId: binding.ownerSenderId,
          inboundMode: binding.inboundMode,
          allowMissingSenderId: binding.allowMissingSenderId,
          createdAtMs: binding.createdAtMs,
          updatedAtMs: binding.updatedAtMs,
        })) : [],
        fetchedAtMs: Date.now(),
      };
      cache = next;
      return next;
    } catch (error) {
      logger.warn('[channelBridge] Failed to read local channel bridge bindings; using empty bindings', error);
      const next: BindingCache = { bindings: [], fetchedAtMs: Date.now() };
      cache = next;
      return next;
    }
  }

  async function persist(bindings: readonly ChannelSessionBinding[]): Promise<void> {
    await mkdir(join(configuration.activeServerDir, 'channel-bridges', 'v1'), { recursive: true, mode: 0o700 });
    await bestEffortChmod0700(configuration.activeServerDir);

    const doc: StoredBindingsDocV1 = {
      schemaVersion: 1,
      bindings: bindings.map((binding) => ({
        providerId: binding.providerId,
        conversationId: binding.conversationId,
        threadId: binding.threadId,
        sessionId: binding.sessionId,
        lastForwardedSeq: binding.lastForwardedSeq,
        ownerSenderId: binding.ownerSenderId,
        inboundMode: binding.inboundMode,
        allowMissingSenderId: binding.allowMissingSenderId,
        createdAtMs: binding.createdAtMs,
        updatedAtMs: binding.updatedAtMs,
      })),
    };
    await writeJsonAtomic(bindingsFile, doc);
    await bestEffortChmod0700(join(configuration.activeServerDir, 'channel-bridges'));
    await bestEffortChmod0700(join(configuration.activeServerDir, 'channel-bridges', 'v1'));
  }

  function setCache(bindings: readonly ChannelSessionBinding[]): void {
    cache = {
      bindings: cloneBindings(bindings),
      fetchedAtMs: Date.now(),
    };
  }

  return {
    listBindings: async () => {
      const current = await load(false);
      return cloneBindings(current.bindings);
    },
    getBinding: async (ref) => {
      const current = await load(false);
      const key = bindingKey(ref);
      const found = current.bindings.find((binding) => bindingKey(binding) === key);
      return found ? cloneBinding(found) : null;
    },
    upsertBinding: async (binding) => enqueue(async () => {
      const now = Date.now();
      const current = await load(true);
      const key = bindingKey(binding);
      const existing = current.bindings.find((row) => bindingKey(row) === key);
      const next: ChannelSessionBinding = {
        providerId: binding.providerId,
        conversationId: binding.conversationId,
        threadId: binding.threadId,
        sessionId: binding.sessionId,
        lastForwardedSeq: Math.max(0, Math.trunc(binding.lastForwardedSeq)),
        ownerSenderId: typeof binding.ownerSenderId === 'string' && binding.ownerSenderId.trim().length > 0 ? binding.ownerSenderId.trim() : null,
        inboundMode: binding.inboundMode === 'anyone' ? 'anyone' : 'ownerOnly',
        allowMissingSenderId: binding.allowMissingSenderId === true,
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
      };
      const without = current.bindings.filter((row) => bindingKey(row) !== key);
      const nextBindings = [...without, next];
      await persist(nextBindings);
      setCache(nextBindings);
      return cloneBinding(next);
    }),
    updateLastForwardedSeq: async (ref, params) => enqueue(async () => {
      const current = await load(true);
      const key = bindingKey(ref);
      const nextBindings = current.bindings.map((row) => {
        if (bindingKey(row) !== key) return row;
        if (row.sessionId !== params.expectedSessionId) return row;
        const nextSeq = Math.max(0, Math.trunc(params.seq));
        if (nextSeq <= row.lastForwardedSeq) return row;
        return {
          ...row,
          lastForwardedSeq: nextSeq,
          updatedAtMs: Date.now(),
        };
      });

      const before = current.bindings.find((row) => bindingKey(row) === key);
      const after = nextBindings.find((row) => bindingKey(row) === key);
      const changed =
        !!before &&
        !!after &&
        before.sessionId === params.expectedSessionId &&
        after.sessionId === params.expectedSessionId &&
        after.lastForwardedSeq > before.lastForwardedSeq;

      if (!changed) {
        setCache(nextBindings);
        return false;
      }

      await persist(nextBindings);
      setCache(nextBindings);
      return true;
    }),
    removeBinding: async (ref) => enqueue(async () => {
      const current = await load(true);
      const key = bindingKey(ref);
      const nextBindings = current.bindings.filter((row) => bindingKey(row) !== key);
      const removed = nextBindings.length !== current.bindings.length;
      if (!removed) {
        setCache(nextBindings);
        return false;
      }
      await persist(nextBindings);
      setCache(nextBindings);
      return true;
    }),
  };
}
