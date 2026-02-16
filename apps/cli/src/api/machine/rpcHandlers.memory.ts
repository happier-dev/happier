import { z } from 'zod';

import {
  MemorySearchQueryV1Schema,
  type MemorySearchResultV1,
  MemoryWindowV1Schema,
  type MemoryWindowV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { searchTier1Memory, searchTier2Memory } from '@/daemon/memory/searchMemory';
import { readMemorySettingsFromDisk, writeMemorySettingsToDisk } from '@/settings/memorySettings';
import { getMemoryWindow } from '@/daemon/memory/getMemoryWindow';
import { readCredentials } from '@/persistence';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { resolveMemoryIndexPaths } from '@/daemon/memory/memoryIndexPaths';
import { resolveEmbeddingsProvider } from '@/daemon/memory/deepIndex/embeddings/resolveEmbeddingsProvider';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';

const EnsureUpToDateParamsSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
  })
  .passthrough();

const GetWindowParamsSchema = z
  .object({
    v: z.literal(1).optional(),
    sessionId: z.string().min(1),
    seqFrom: z.number().int().min(0),
    seqTo: z.number().int().min(0),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.seqFrom > value.seqTo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
    }
  });

function disabledResult(): MemorySearchResultV1 {
  return { v: 1, ok: false, errorCode: 'memory_disabled', error: 'memory_disabled' };
}

export function registerMachineMemoryRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  memoryWorker: MemoryWorkerHandle;
}>): void {
  const { rpcHandlerManager, memoryWorker } = params;

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_STATUS, async () => {
    const settings = memoryWorker.getSettings();
    const tier1DbPath = memoryWorker.getTier1DbPath();
    const deepDbPath = memoryWorker.getDeepDbPath();

    const readBytes = async (path: string | null): Promise<number | null> => {
      if (!path) return null;
      try {
        const s = await stat(path);
        return typeof s.size === 'number' && Number.isFinite(s.size) ? Math.max(0, Math.trunc(s.size)) : null;
      } catch {
        return null;
      }
    };

    return {
      v: 1,
      enabled: settings.enabled,
      indexMode: settings.indexMode,
      tier1DbPath,
      deepDbPath,
      tier1DbBytes: await readBytes(tier1DbPath),
      deepDbBytes: await readBytes(deepDbPath),
    };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET, async () => {
    return await readMemorySettingsFromDisk();
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET, async (raw: unknown) => {
    const next = await writeMemorySettingsToDisk(raw);
    await memoryWorker.reloadSettings();
    return next;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE, async (raw: unknown) => {
    const parsed = EnsureUpToDateParamsSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    await memoryWorker.ensureUpToDate(parsed.data.sessionId);
    return { ok: true };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SEARCH, async (raw: unknown): Promise<MemorySearchResultV1> => {
    const parsed = MemorySearchQueryV1Schema.safeParse(raw);
    if (!parsed.success) {
      return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'memory_invalid_query' };
    }

    const settings = memoryWorker.getSettings();
    if (!settings.enabled) return disabledResult();

    const mode = parsed.data.mode;
    const preferDeep = mode === 'deep' || (mode === 'auto' && settings.indexMode === 'deep');

    if (preferDeep) {
      const deepPath = memoryWorker.getDeepDbPath();
      if (!deepPath) return { v: 1, ok: false, errorCode: 'memory_index_missing', error: 'memory_index_missing' };
      const embedQuery = await (async () => {
        if (!settings.embeddings.enabled) return undefined;
        const paths = resolveMemoryIndexPaths();
        const cacheDir = join(paths.modelsDir, 'transformers');
        try {
          mkdirSync(cacheDir, { recursive: true });
        } catch {
          // best-effort
        }
        const provider = await resolveEmbeddingsProvider({ settings: settings.embeddings, cacheDir });
        return provider?.embedQuery;
      })();
      return await searchTier2Memory({
        dbPath: deepPath,
        query: parsed.data,
        previewChars: settings.deep.previewChars,
        candidateLimit: settings.deep.candidateLimit,
        embeddings: settings.embeddings,
        ...(embedQuery ? { embedQuery } : {}),
      });
    }

    const tier1Path = memoryWorker.getTier1DbPath();
    if (!tier1Path) return { v: 1, ok: false, errorCode: 'memory_index_missing', error: 'memory_index_missing' };
    return searchTier1Memory({ dbPath: tier1Path, query: parsed.data });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, async (raw: unknown): Promise<MemoryWindowV1> => {
    const parsed = GetWindowParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return MemoryWindowV1Schema.parse({ v: 1, snippets: [], citations: [] });
    }
    const settings = memoryWorker.getSettings();
    if (!settings.enabled) {
      return MemoryWindowV1Schema.parse({ v: 1, snippets: [], citations: [] });
    }

    const credentials = await readCredentials();
    if (!credentials) {
      return MemoryWindowV1Schema.parse({
        v: 1,
        snippets: [],
        citations: [{ sessionId: parsed.data.sessionId, seqFrom: parsed.data.seqFrom, seqTo: parsed.data.seqTo }],
      });
    }

    const window = await getMemoryWindow({
      credentials,
      sessionId: parsed.data.sessionId,
      seqFrom: parsed.data.seqFrom,
      seqTo: parsed.data.seqTo,
      paddingMessages: memoryWorker.getSettings().hints.paddingMessagesOnVerify,
    });
    return MemoryWindowV1Schema.parse(window);
  });
}
