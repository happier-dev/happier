import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import {
  buildScmDiffSummaryCacheKey,
  type ScmDiffSummaryCacheKeyInput,
} from './cacheKey';
import type { ScmDiffSummaryGenerateOutput } from '@happier-dev/protocol';
import { configuration } from '@/configuration';

type ScmDiffSummaryProjectedCachedValue = Readonly<{
  summaryMarkdown: string;
  state: 'complete' | 'partial';
  truncation?: Readonly<{
    reason: string;
    droppedFiles?: number;
  }>;
  cost?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    estimatedUsd?: number;
  }>;
}>;

export type ScmDiffSummaryCachedValue = ScmDiffSummaryGenerateOutput | ScmDiffSummaryProjectedCachedValue;

export type ScmDiffSummaryCacheSetInput = Readonly<{
  keyInput: ScmDiffSummaryCacheKeyInput;
  checkpointRef?: string;
  value: ScmDiffSummaryCachedValue;
}>;

export type CheckpointCleanupReceiptLike = Readonly<{
  id: string;
  refs?: readonly string[];
  prunedCount?: number;
}>;

type StoredScmDiffSummaryCacheEntry = Readonly<{
  key: string;
  checkpointRef: string | null;
  value: ScmDiffSummaryCachedValue;
}>;

type PersistedScmDiffSummaryCache = Readonly<{
  entries: readonly StoredScmDiffSummaryCacheEntry[];
}>;

export type ScmDiffSummaryCacheStore = Readonly<{
  set(input: ScmDiffSummaryCacheSetInput): void;
  get(input: ScmDiffSummaryCacheKeyInput): ScmDiffSummaryCachedValue | null;
  applyCheckpointCleanupReceipt(receipt: CheckpointCleanupReceiptLike): Readonly<{ prunedEntries: number }>;
  clear(): void;
}>;

export type CreateScmDiffSummaryCacheStoreOptions = Readonly<{
  filePath?: string;
}>;

function resolveDefaultCacheFilePath(): string {
  return join(configuration.happyHomeDir, 'cache', 'scm-diff-summary', 'v1.json');
}

function readPersistedEntries(filePath: string | null): StoredScmDiffSummaryCacheEntry[] {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedScmDiffSummaryCache>;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((entry): StoredScmDiffSummaryCacheEntry[] => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Readonly<Record<string, unknown>>;
      if (typeof record.key !== 'string' || !record.key.trim()) return [];
      const checkpointRef = typeof record.checkpointRef === 'string' && record.checkpointRef.trim()
        ? record.checkpointRef.trim()
        : null;
      const value = record.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      return [{
        key: record.key,
        checkpointRef,
        value: value as ScmDiffSummaryCachedValue,
      }];
    });
  } catch {
    return [];
  }
}

function writePersistedEntries(filePath: string | null, entries: Iterable<StoredScmDiffSummaryCacheEntry>): void {
  if (!filePath) return;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const payload: PersistedScmDiffSummaryCache = { entries: Array.from(entries) };
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

export function createScmDiffSummaryCacheStore(
  options: CreateScmDiffSummaryCacheStoreOptions = {},
): ScmDiffSummaryCacheStore {
  const filePath = options.filePath ?? null;
  const entriesByKey = new Map<string, StoredScmDiffSummaryCacheEntry>();
  for (const entry of readPersistedEntries(filePath)) {
    entriesByKey.set(entry.key, entry);
  }

  const persist = () => writePersistedEntries(filePath, entriesByKey.values());

  return {
    set(input) {
      const key = buildScmDiffSummaryCacheKey(input.keyInput);
      entriesByKey.set(key, {
        key,
        checkpointRef: input.checkpointRef?.trim() || null,
        value: input.value,
      });
      persist();
    },
    get(input) {
      const key = buildScmDiffSummaryCacheKey(input);
      return entriesByKey.get(key)?.value ?? null;
    },
    applyCheckpointCleanupReceipt(receipt) {
      if (receipt.id !== 'checkpoint.cleanup_pruned' || !receipt.refs || receipt.refs.length === 0) {
        return { prunedEntries: 0 };
      }

      const prunedRefs = new Set(receipt.refs);
      let prunedEntries = 0;
      for (const [key, entry] of entriesByKey.entries()) {
        if (!entry.checkpointRef || !prunedRefs.has(entry.checkpointRef)) continue;
        entriesByKey.delete(key);
        prunedEntries += 1;
      }

      if (prunedEntries > 0) persist();
      return { prunedEntries };
    },
    clear() {
      entriesByKey.clear();
      persist();
    },
  };
}

let defaultScmDiffSummaryCacheStore: ScmDiffSummaryCacheStore | null = null;

function getDefaultScmDiffSummaryCacheStore(): ScmDiffSummaryCacheStore {
  defaultScmDiffSummaryCacheStore ??= createScmDiffSummaryCacheStore({
    filePath: resolveDefaultCacheFilePath(),
  });
  return defaultScmDiffSummaryCacheStore;
}

// Keep configuration and filesystem access out of module initialization. This
// cache sits on broad SCM/checkpoint import paths, so constructing it eagerly
// made unrelated consumers depend on a fully initialized runtime configuration.
export const scmDiffSummaryCacheStore: ScmDiffSummaryCacheStore = Object.freeze({
  set(input) {
    getDefaultScmDiffSummaryCacheStore().set(input);
  },
  get(input) {
    return getDefaultScmDiffSummaryCacheStore().get(input);
  },
  applyCheckpointCleanupReceipt(receipt) {
    return getDefaultScmDiffSummaryCacheStore().applyCheckpointCleanupReceipt(receipt);
  },
  clear() {
    getDefaultScmDiffSummaryCacheStore().clear();
  },
});
