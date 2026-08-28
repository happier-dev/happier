import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  PROVIDER_RUNTIME_STATE_LIMITS_V1,
  ProviderMachineIdSchema,
  ProviderRuntimeStateFileV1Schema,
  createEmptyProviderRuntimeStateFileV1,
  normalizeProviderRuntimeStateFileForStartupV1,
  parseProviderRuntimeStateFileV1,
  type ProviderRuntimeStateFileV1,
  type ProviderRuntimeStateParseFailureReasonV1,
  type ProviderEndpointRuntimeStateRecordV1,
} from '@happier-dev/protocol';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic as canonicalWriteJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { serializeProviderRuntimeStateRecordKey } from './keys';
import {
  pruneProviderRuntimeStateV1,
  type ProviderRuntimeStatePruneContext,
} from './prune';

export type ProviderRuntimeStateStoreDiagnostic = Readonly<{
  code: 'provider_runtime_state_invalid';
  reason: ProviderRuntimeStateParseFailureReasonV1;
}>;

export type ProviderRuntimeStateStore = Readonly<{
  path: string;
  read(): Promise<ProviderRuntimeStateFileV1>;
  update(
    transform: (current: ProviderRuntimeStateFileV1) => ProviderRuntimeStateFileV1 | Promise<ProviderRuntimeStateFileV1>,
    pruneContext?: ProviderRuntimeStatePruneContext,
  ): Promise<ProviderRuntimeStateFileV1>;
  /**
   * Publishes the process-local endpoint activity overlay without rewriting
   * the durable catalog file. `refreshDurable` is reserved for retirement:
   * it merges a concurrently committed endpoint verdict before clearing this
   * process's transient activity, but still performs no durable write.
   */
  updateTransientEndpointHealth(
    transform: (
      current: readonly ProviderEndpointRuntimeStateRecordV1[],
    ) => readonly ProviderEndpointRuntimeStateRecordV1[] | Promise<readonly ProviderEndpointRuntimeStateRecordV1[]>,
    options?: Readonly<{ refreshDurable?: boolean }>,
  ): Promise<void>;
}>;

export function resolveProviderRuntimeStatePath(happyHomeDir: string): string {
  if (!happyHomeDir || happyHomeDir.trim() !== happyHomeDir) {
    throw new TypeError('Happier home directory must be a canonical non-empty path');
  }
  return join(happyHomeDir, 'providers', 'runtime-state-v1.json');
}

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const metadata = await lstat(parent);
  if (metadata.isSymbolicLink()) {
    throw new Error('Provider runtime-state directory must not be a symbolic link');
  }
  if (!metadata.isDirectory()) {
    throw new Error('Provider runtime-state parent must be a directory');
  }
  if (process.platform !== 'win32') await chmod(parent, 0o700);
}

async function readFileBounded(path: string): Promise<Readonly<{
  bytes: Buffer;
  missing: boolean;
  oversized: boolean;
}>> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { bytes: Buffer.alloc(0), missing: true, oversized: false };
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (metadata.size > PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes) {
      return { bytes: Buffer.alloc(0), missing: false, oversized: true };
    }
    const capacity = PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes + 1;
    const output = Buffer.allocUnsafe(Math.min(capacity, Math.max(1, Number(metadata.size) + 1)));
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === output.length && output.length < capacity) {
      const expanded = Buffer.allocUnsafe(capacity);
      output.copy(expanded, 0, 0, offset);
      while (offset < expanded.length) {
        const { bytesRead } = await handle.read(expanded, offset, expanded.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return {
        bytes: expanded.subarray(0, offset),
        missing: false,
        oversized: offset > PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes,
      };
    }
    return {
      bytes: output.subarray(0, offset),
      missing: false,
      oversized: offset > PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes,
    };
  } finally {
    await handle.close();
  }
}

function cloneState(state: ProviderRuntimeStateFileV1): ProviderRuntimeStateFileV1 {
  return structuredClone(state);
}

/**
 * Endpoint `activity` is the only runtime-state field the durable file never
 * carries: `normalizeProviderRuntimeStateFileForStartupV1` writes every record
 * as `idle`, and the probing process keeps `checking` in memory to know which
 * transient record is still its own. Re-reading the file for a cross-process
 * merge must therefore restore this process's live activity over the records it
 * still holds; everything else comes from the file.
 */
function withLiveEndpointActivity(
  durable: ProviderRuntimeStateFileV1,
  live: ProviderRuntimeStateFileV1,
): ProviderRuntimeStateFileV1 {
  const liveByKey = new Map(live.endpointHealth.map((record) => [
    serializeProviderRuntimeStateRecordKey('endpointHealth', record),
    record,
  ] as const));
  const durableKeys = new Set(durable.endpointHealth.map((record) =>
    serializeProviderRuntimeStateRecordKey('endpointHealth', record)));
  return {
    ...durable,
    endpointHealth: [
      ...durable.endpointHealth.map((record) => {
        const liveRecord = liveByKey.get(
          serializeProviderRuntimeStateRecordKey('endpointHealth', record),
        );
        const activity = liveRecord?.state.activity;
        return activity === undefined || activity === record.state.activity
          ? record
          : { ...record, state: { ...record.state, activity } };
      }),
      // A newly admitted probe has no durable endpoint row yet. Preserve that
      // exact process-local overlay across unrelated locked commits while
      // still excluding it from the file written by commitUnlocked().
      ...live.endpointHealth.filter((record) =>
        record.state.activity === 'checking'
        && !durableKeys.has(
          serializeProviderRuntimeStateRecordKey('endpointHealth', record),
        )),
    ],
  };
}

export function createProviderRuntimeStateStore(input: Readonly<{
  happyHomeDir: string;
  machineId: string;
  onDiagnostic?: (diagnostic: ProviderRuntimeStateStoreDiagnostic) => void;
  writeJsonAtomic?: (path: string, value: unknown) => Promise<void>;
}>): ProviderRuntimeStateStore {
  const machineId = ProviderMachineIdSchema.parse(input.machineId);
  const path = resolveProviderRuntimeStatePath(input.happyHomeDir);
  const writeJsonAtomic = input.writeJsonAtomic ?? canonicalWriteJsonAtomic;
  let memory: ProviderRuntimeStateFileV1 | undefined;
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * The daemon and a standalone CLI each hold their own store over this one
   * file, so in-process serialization alone would let a whole-file write
   * overwrite records the other process persisted. Mutations run under the
   * canonical owner-file lock and re-read the file inside it, so every
   * transform sees the other writer's committed records instead of this
   * store's private memory.
   */
  async function mutateLocked<T>(mutation: () => Promise<T>): Promise<T> {
    await ensurePrivateParent(path);
    return await withJsonOwnerFileLock({
      lockPath: `${path}.lock`,
      timeoutMs: 10_000,
      staleAfterMs: 30_000,
      errorCode: 'provider_runtime_state_lock_timeout',
    }, async () => {
      const live = memory;
      memory = undefined;
      const durable = await loadUnlocked();
      memory = live ? withLiveEndpointActivity(durable, live) : durable;
      return await mutation();
    });
  }

  function diagnostic(reason: ProviderRuntimeStateParseFailureReasonV1): void {
    try {
      input.onDiagnostic?.({ code: 'provider_runtime_state_invalid', reason });
    } catch {
      // Cache recovery remains authoritative; an observer cannot turn a
      // refetchable local-cache diagnostic into a daemon-start failure.
    }
  }

  async function loadUnlocked(): Promise<ProviderRuntimeStateFileV1> {
    if (memory) return memory;
    const read = await readFileBounded(path);
    if (read.missing) {
      memory = createEmptyProviderRuntimeStateFileV1(machineId);
      return memory;
    }
    if (read.oversized) {
      diagnostic('encoded_size_exceeded');
      memory = createEmptyProviderRuntimeStateFileV1(machineId);
      return memory;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(read.bytes.toString('utf8')) as unknown;
    } catch {
      diagnostic('malformed');
      memory = createEmptyProviderRuntimeStateFileV1(machineId);
      return memory;
    }
    const parsed = parseProviderRuntimeStateFileV1(raw, {
      expectedMachineId: machineId,
      encodedBytes: read.bytes.byteLength,
    });
    if (!parsed.ok) {
      diagnostic(parsed.diagnostic.reason);
      memory = parsed.state;
      return memory;
    }
    memory = normalizeProviderRuntimeStateFileForStartupV1(parsed.state);
    return memory;
  }

  async function commitUnlocked(
    candidate: ProviderRuntimeStateFileV1,
    pruneContext: ProviderRuntimeStatePruneContext = {},
  ): Promise<ProviderRuntimeStateFileV1> {
    if (candidate.machineId !== machineId) {
      throw new TypeError('Provider runtime-state mutation cannot change the store machine envelope');
    }
    const pruned = pruneProviderRuntimeStateV1(candidate, pruneContext);
    const parsed = ProviderRuntimeStateFileV1Schema.parse(pruned);
    const durable = normalizeProviderRuntimeStateFileForStartupV1(parsed);
    await writeJsonAtomic(path, durable);
    if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
    memory = parsed;
    return memory;
  }

  return {
    path,
    read: () => enqueue(async () => cloneState(await loadUnlocked())),
    updateTransientEndpointHealth: (transform, options = {}) => enqueue(async () => {
      const apply = async (): Promise<void> => {
        const current = await loadUnlocked();
        const endpointHealth = ProviderRuntimeStateFileV1Schema.shape.endpointHealth.parse(
          await transform(structuredClone(current.endpointHealth)),
        );
        memory = { ...current, endpointHealth };
      };
      if (options.refreshDurable) {
        await mutateLocked(apply);
        return;
      }
      await apply();
    }),
    update: (transform, pruneContext = {}) => enqueue(async () => await mutateLocked(async () => {
      const current = await loadUnlocked();
      const candidate = await transform(cloneState(current));
      return cloneState(await commitUnlocked(candidate, pruneContext));
    })),
  };
}
