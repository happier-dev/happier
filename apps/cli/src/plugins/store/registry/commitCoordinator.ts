import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';

import { z } from 'zod';

import { reclaimJsonOwnerFileLockSnapshot } from '@/utils/fs/jsonOwnerFileLock';

import type { PluginStorePaths } from '../paths';
import {
  PluginRegistryCommitRecordSchema,
  readPluginRegistryCommitRecord,
  replacePluginRegistryCommitRecord,
  type PluginRegistryCommitRecord,
} from './commitRecord';
import { verifyPluginRegistryCommitGenerationReferences } from './generationStore';

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;

const LockRecordSchema = z.object({
  t: z.literal('happier_plugin_registry_commit_lock_v1'),
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  instanceId: z.string().min(1).max(160),
  createdAtMs: z.number().int().nonnegative(),
}).strict();
type LockRecord = z.infer<typeof LockRecordSchema>;

export type PluginRegistryCommitResult =
  | Readonly<{ status: 'committed'; record: PluginRegistryCommitRecord }>
  | Readonly<{ status: 'committed_durability_pending'; record: PluginRegistryCommitRecord; message: string }>
  | Readonly<{ status: 'conflict'; expectedRevision: number | null; actualRevision: number | null }>
  | Readonly<{ status: 'aborted'; reason: 'signal' }>;

type CoordinatorDependencies = Readonly<{
  paths: PluginStorePaths;
  owner: Readonly<{ pid: number; instanceId: string }>;
  acquireTimeoutMs?: number;
  nowMs?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  beforeReplace?: () => Promise<void>;
  flushCommit?: (path: string) => Promise<void>;
}>;

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

type LockSnapshot = Readonly<{ record: LockRecord; raw: string }>;

async function readLock(path: string): Promise<LockSnapshot | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = LockRecordSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? { record: parsed.data, raw } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    return null;
  }
}

async function assertFenceOwned(path: string, expectedRaw: string): Promise<void> {
  const current = await readLock(path);
  if (!current || current.raw !== expectedRaw) {
    throw new Error('Plugin registry commit fencing token is no longer owned');
  }
}

async function acquireFence(input: Required<Pick<CoordinatorDependencies,
  'paths' | 'owner' | 'acquireTimeoutMs' | 'nowMs' | 'isProcessAlive' | 'sleep'
>>): Promise<Readonly<{ token: string; release: () => Promise<void>; assertOwned: () => Promise<void> }>> {
  const path = input.paths.registryCommitLockFilePath;
  const startedAtMs = input.nowMs();
  await mkdir(input.paths.stateDir, { recursive: true });

  while (true) {
    const token = randomUUID();
    const record: LockRecord = {
      t: 'happier_plugin_registry_commit_lock_v1',
      token,
      pid: input.owner.pid,
      instanceId: input.owner.instanceId,
      createdAtMs: input.nowMs(),
    };
    const raw = JSON.stringify(record);
    try {
      const handle = await open(path, 'wx', 0o600);
      let writeCompleted = false;
      try {
        await handle.writeFile(raw, 'utf8');
        writeCompleted = true;
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        if (writeCompleted) {
          await reclaimJsonOwnerFileLockSnapshot(path, raw).catch(() => undefined);
        }
        throw error;
      }
      await handle.close();
      return Object.freeze({
        token,
        assertOwned: async () => await assertFenceOwned(path, raw),
        release: async () => {
          const result = await reclaimJsonOwnerFileLockSnapshot(path, raw);
          if (result === 'ownership_unknown') {
            throw new Error('Plugin registry commit fence ownership became indeterminate during release');
          }
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
    }

    const observed = await readLock(path);
    if (observed) {
      if (!input.isProcessAlive(observed.record.pid)) {
        const result = await reclaimJsonOwnerFileLockSnapshot(path, observed.raw);
        if (result === 'ownership_unknown') {
          throw new Error('Plugin registry commit fence ownership became indeterminate during recovery');
        }
        if (result === 'reclaimed') continue;
      }
    }

    if (input.nowMs() - startedAtMs >= input.acquireTimeoutMs) {
      throw new Error(`Timeout acquiring plugin registry commit lock after ${input.acquireTimeoutMs}ms`);
    }
    await input.sleep(10);
  }
}

export async function withPluginRegistryCommitFence<T>(input: Readonly<{
  paths: PluginStorePaths;
  owner: Readonly<{ pid: number; instanceId: string }>;
  operation: () => Promise<T>;
  acquireTimeoutMs?: number;
}>): Promise<T> {
  const fence = await acquireFence({
    paths: input.paths,
    owner: input.owner,
    acquireTimeoutMs: input.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    nowMs: Date.now,
    isProcessAlive: defaultIsProcessAlive,
    sleep: async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)),
  });
  try {
    return await input.operation();
  } finally {
    await fence.release();
  }
}

export function createPluginRegistryCommitCoordinator(dependencies: CoordinatorDependencies): Readonly<{
  readCurrent: () => Promise<PluginRegistryCommitRecord | null>;
  commit: (input: Readonly<{
    transactionId: string;
    baseRevision: number | null;
    signal?: AbortSignal;
    buildNext: (current: PluginRegistryCommitRecord | null) => PluginRegistryCommitRecord | Promise<PluginRegistryCommitRecord>;
  }>) => Promise<PluginRegistryCommitResult>;
}> {
  const nowMs = dependencies.nowMs ?? Date.now;
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const sleep = dependencies.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));

  function commit(input: Readonly<{
    transactionId: string;
    baseRevision: number | null;
    signal?: AbortSignal;
    buildNext: (current: PluginRegistryCommitRecord | null) => PluginRegistryCommitRecord | Promise<PluginRegistryCommitRecord>;
  }>): Promise<PluginRegistryCommitResult> {
    return (async (): Promise<PluginRegistryCommitResult> => {
      if (input.signal?.aborted) return { status: 'aborted', reason: 'signal' };
      const fence = await acquireFence({
        paths: dependencies.paths,
        owner: dependencies.owner,
        acquireTimeoutMs: dependencies.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
        nowMs,
        isProcessAlive,
        sleep,
      });
      try {
        if (input.signal?.aborted) return { status: 'aborted', reason: 'signal' };
        const current = await readPluginRegistryCommitRecord(dependencies.paths);
        const actualRevision = current?.revision ?? null;
        if (actualRevision !== input.baseRevision) {
          return { status: 'conflict', expectedRevision: input.baseRevision, actualRevision };
        }
        const next = PluginRegistryCommitRecordSchema.parse(await input.buildNext(current));
        if (next.transactionId !== input.transactionId) {
          throw new Error(`Plugin registry commit transaction id '${next.transactionId}' does not match operation '${input.transactionId}'`);
        }
        await verifyPluginRegistryCommitGenerationReferences(dependencies.paths, next, {
          allowInvalidUnchangedReferencesFrom: current,
        });
        if (input.signal?.aborted) return { status: 'aborted', reason: 'signal' };
        await dependencies.beforeReplace?.();
        await fence.assertOwned();
        await verifyPluginRegistryCommitGenerationReferences(dependencies.paths, next, {
          allowInvalidUnchangedReferencesFrom: current,
        });
        try {
          await replacePluginRegistryCommitRecord({
            paths: dependencies.paths,
            expectedRevision: input.baseRevision,
            next,
            ...(dependencies.flushCommit ? { flushDurable: dependencies.flushCommit } : {}),
          });
        } catch (error) {
          const observed = await readPluginRegistryCommitRecord(dependencies.paths).catch(() => null);
          if (!observed || JSON.stringify(observed) !== JSON.stringify(next)) throw error;
          return {
            status: 'committed_durability_pending',
            record: next,
            message: error instanceof Error ? error.message : String(error),
          };
        }
        return { status: 'committed', record: next };
      } finally {
        await fence.release();
      }
    })();
  }

  return Object.freeze({
    readCurrent: async () => await readPluginRegistryCommitRecord(dependencies.paths),
    commit,
  });
}
