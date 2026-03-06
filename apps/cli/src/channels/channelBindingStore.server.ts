/**
 * Server-backed channel binding store.
 *
 * Responsibilities:
 * - read/write channel binding state from server KV
 * - keep optimistic concurrency behavior safe across concurrent machines
 * - preserve local cache coherence and avoid silently clobbering remote data
 */
import type { ChannelBindingStore, ChannelBridgeConversationRef, ChannelSessionBinding } from '@/channels/core/channelBridgeWorker';
import {
  ChannelBridgeBadPayloadError,
  ChannelBridgeKvVersionMismatchError,
  decodeChannelBridgeBindingsDocFromBase64,
  readChannelBridgeBindingsFromKv,
  type ChannelBridgeKvClient,
  type ChannelBridgeServerBindingsDocument,
  writeChannelBridgeBindingsToKv,
} from '@/channels/channelBridgeServerKv';
import { logger } from '@/ui/logger';

type BindingCache = Readonly<{
  version: number;
  bindings: ChannelSessionBinding[];
  fetchedAtMs: number;
}>;

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
    createdAtMs: binding.createdAtMs,
    updatedAtMs: binding.updatedAtMs,
  };
}

function cloneBindings(bindings: readonly ChannelSessionBinding[]): ChannelSessionBinding[] {
  return bindings.map((binding) => cloneBinding(binding));
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  if (truncated < 0) return null;
  return truncated;
}

function toServerDocument(bindings: readonly ChannelSessionBinding[]): ChannelBridgeServerBindingsDocument {
  return {
    schemaVersion: 1,
    bindings: bindings.map((binding) => ({
      providerId: binding.providerId,
      conversationId: binding.conversationId,
      threadId: binding.threadId,
      sessionId: binding.sessionId,
      lastForwardedSeq: binding.lastForwardedSeq,
      createdAtMs: binding.createdAtMs,
      updatedAtMs: binding.updatedAtMs,
    })),
  };
}

function fromServerDocument(doc: ChannelBridgeServerBindingsDocument): ChannelSessionBinding[] {
  return doc.bindings.map((binding) => ({
    providerId: binding.providerId,
    conversationId: binding.conversationId,
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    lastForwardedSeq: toNonNegativeInt(binding.lastForwardedSeq) ?? 0,
    createdAtMs: Math.trunc(binding.createdAtMs),
    updatedAtMs: Math.trunc(binding.updatedAtMs),
  }));
}

function isRecoverableBindingsReadError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  return error instanceof ChannelBridgeBadPayloadError;
}

export function createServerBackedChannelBindingStore(params: Readonly<{
  kv: ChannelBridgeKvClient;
  serverId: string;
  accountId: string;
  cacheTtlMs?: number;
  maxWriteRetries?: number;
}>): ChannelBindingStore {
  const cacheTtlMs = typeof params.cacheTtlMs === 'number' ? Math.max(0, Math.trunc(params.cacheTtlMs)) : 1_000;
  const maxWriteRetries = typeof params.maxWriteRetries === 'number' ? Math.max(1, Math.trunc(params.maxWriteRetries)) : 4;

  let cache: BindingCache | null = null;

  async function load(forceRefresh: boolean): Promise<BindingCache> {
    if (!forceRefresh && cache && Date.now() - cache.fetchedAtMs <= cacheTtlMs) {
      return cache;
    }

    try {
      const fetched = await readChannelBridgeBindingsFromKv({
        kv: params.kv,
        serverId: params.serverId,
        accountId: params.accountId,
      });
      const next: BindingCache = {
        version: fetched.version,
        bindings: fromServerDocument(fetched.doc),
        fetchedAtMs: Date.now(),
      };
      cache = next;
      return next;
    } catch (error) {
      if (!isRecoverableBindingsReadError(error)) {
        throw error;
      }

      logger.warn('[channelBindingStore] Failed to decode primary KV payload', error);
      if (!cache) {
        throw error;
      }

      const next: BindingCache = {
        ...cache,
        fetchedAtMs: Date.now(),
      };
      cache = next;
      return next;
    }
  }

  function setCache(version: number, bindings: readonly ChannelSessionBinding[]): void {
    cache = {
      version,
      bindings: cloneBindings(bindings),
      fetchedAtMs: Date.now(),
    };
  }

  async function withOptimisticWrite<T>(operation: (currentBindings: ChannelSessionBinding[]) => Readonly<{
    nextBindings: ChannelSessionBinding[];
    result: T;
    changed?: boolean;
  }>): Promise<T> {
    let retryCurrent: BindingCache | null = null;

    for (let attempt = 0; attempt < maxWriteRetries; attempt += 1) {
      const current = retryCurrent ?? await load(true);
      retryCurrent = null;
      const op = operation(cloneBindings(current.bindings));
      const changed = op.changed ?? true;
      if (!changed) {
        setCache(current.version, current.bindings);
        return op.result;
      }

      try {
        const version = await writeChannelBridgeBindingsToKv({
          kv: params.kv,
          serverId: params.serverId,
          accountId: params.accountId,
          expectedVersion: current.version,
          doc: toServerDocument(op.nextBindings),
        });

        setCache(version, op.nextBindings);
        return op.result;
      } catch (error) {
        if (!(error instanceof ChannelBridgeKvVersionMismatchError)) {
          throw error;
        }

        let doc: ChannelBridgeServerBindingsDocument;
        try {
          doc = decodeChannelBridgeBindingsDocFromBase64(error.currentValueBase64);
        } catch (decodeError) {
          logger.warn('[channelBindingStore] Failed to decode conflict payload; aborting optimistic retry to avoid clobbering remote bindings', decodeError);
          throw new Error(
            '[channelBindingStore] Conflict payload decode failed; aborting optimistic retry to avoid clobbering remote bindings',
          );
        }
        const conflictBindings = fromServerDocument(doc);
        setCache(error.currentVersion, conflictBindings);
        retryCurrent = {
          version: error.currentVersion,
          bindings: cloneBindings(conflictBindings),
          fetchedAtMs: Date.now(),
        };
      }
    }

    throw new Error('Failed to persist channel bridge bindings after retries');
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
    upsertBinding: async (binding) => {
      return await withOptimisticWrite((currentBindings) => {
        const nowMs = Date.now();
        const providerId = binding.providerId.trim();
        const conversationId = binding.conversationId.trim();
        const sessionId = binding.sessionId.trim();
        const threadIdRaw = typeof binding.threadId === 'string' ? binding.threadId.trim() : '';
        const threadId = threadIdRaw.length > 0 ? threadIdRaw : null;
        const normalizedLastForwardedSeq = toNonNegativeInt(binding.lastForwardedSeq);

        if (!providerId || !conversationId || !sessionId || normalizedLastForwardedSeq === null) {
          throw new Error('Invalid channel binding input');
        }

        const key = bindingKey({ providerId, conversationId, threadId });
        const existing = currentBindings.find((row) => bindingKey(row) === key) ?? null;
        const nextBinding: ChannelSessionBinding = {
          providerId,
          conversationId,
          threadId,
          sessionId,
          lastForwardedSeq: normalizedLastForwardedSeq,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        };

        const nextBindings = currentBindings
          .filter((row) => bindingKey(row) !== key)
          .concat([nextBinding]);

        return {
          nextBindings,
          result: cloneBinding(nextBinding),
        };
      });
    },
    updateLastForwardedSeq: async (ref, seq) => {
      await withOptimisticWrite((currentBindings) => {
        const key = bindingKey(ref);
        const parsedSeq = toNonNegativeInt(seq);
        if (parsedSeq === null) {
          return {
            nextBindings: currentBindings,
            result: undefined,
            changed: false,
          };
        }
        let changed = false;
        const nextBindings = currentBindings.map((binding) => {
          if (bindingKey(binding) !== key) return binding;
          if (parsedSeq <= binding.lastForwardedSeq) return binding;
          changed = true;
          return {
            ...binding,
            lastForwardedSeq: parsedSeq,
            updatedAtMs: Date.now(),
          };
        });
        return {
          nextBindings,
          result: undefined,
          changed,
        };
      });
    },
    removeBinding: async (ref) => {
      return await withOptimisticWrite((currentBindings) => {
        const key = bindingKey(ref);
        const nextBindings = currentBindings.filter((binding) => bindingKey(binding) !== key);
        return {
          nextBindings,
          result: nextBindings.length !== currentBindings.length,
          changed: nextBindings.length !== currentBindings.length,
        };
      });
    },
  };
}
