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
} from '@happier-dev/protocol';

import { writeJsonAtomic as canonicalWriteJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  serializeProviderRuntimeStateRecordKey,
  type ProviderRuntimeStateRecordByKind,
  type ProviderRuntimeStateRecordKind,
} from './keys';
import {
  pruneProviderRuntimeStateV1,
  type ProviderRuntimeStatePruneContext,
} from './prune';

export type ProviderRuntimeStateStoreDiagnostic = Readonly<{
  code: 'provider_runtime_state_invalid';
  reason: ProviderRuntimeStateParseFailureReasonV1;
}>;

export type ProviderRuntimeStateTouch = {
  [K in ProviderRuntimeStateRecordKind]: Readonly<{
    kind: K;
    key: ProviderRuntimeStateRecordByKind[K]['key'];
    lastAccessedAt: number;
  }>
}[ProviderRuntimeStateRecordKind];

export type ProviderRuntimeStateStore = Readonly<{
  path: string;
  read(): Promise<ProviderRuntimeStateFileV1>;
  update(
    transform: (current: ProviderRuntimeStateFileV1) => ProviderRuntimeStateFileV1 | Promise<ProviderRuntimeStateFileV1>,
    pruneContext?: ProviderRuntimeStatePruneContext,
  ): Promise<ProviderRuntimeStateFileV1>;
  touch(touch: ProviderRuntimeStateTouch): void;
  flushTouches(pruneContext?: ProviderRuntimeStatePruneContext): Promise<ProviderRuntimeStateFileV1>;
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

function applyTouchToExistingRecord(
  state: ProviderRuntimeStateFileV1,
  touch: ProviderRuntimeStateTouch,
): boolean {
  let record: { lastAccessedAt: number } | undefined;
  switch (touch.kind) {
    case 'endpointHealth': {
      const key = serializeProviderRuntimeStateRecordKey('endpointHealth', { key: touch.key });
      record = state.endpointHealth.find((candidate) =>
        serializeProviderRuntimeStateRecordKey('endpointHealth', candidate) === key);
      break;
    }
    case 'catalogs': {
      const key = serializeProviderRuntimeStateRecordKey('catalogs', { key: touch.key });
      record = state.catalogs.find((candidate) =>
        serializeProviderRuntimeStateRecordKey('catalogs', candidate) === key);
      break;
    }
    case 'installationChecks': {
      const key = serializeProviderRuntimeStateRecordKey('installationChecks', { key: touch.key });
      record = state.installationChecks.find((candidate) =>
        serializeProviderRuntimeStateRecordKey('installationChecks', candidate) === key);
      break;
    }
    case 'modelLoadStates': {
      const key = serializeProviderRuntimeStateRecordKey('modelLoadStates', { key: touch.key });
      record = state.modelLoadStates.find((candidate) =>
        serializeProviderRuntimeStateRecordKey('modelLoadStates', candidate) === key);
      break;
    }
  }
  if (!record || touch.lastAccessedAt <= record.lastAccessedAt) return false;
  record.lastAccessedAt = touch.lastAccessedAt;
  return true;
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
  const pendingTouches = new Map<string, ProviderRuntimeStateTouch>();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
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
    await ensurePrivateParent(path);
    await writeJsonAtomic(path, durable);
    if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
    memory = parsed;
    return memory;
  }

  function validateTouch(touch: ProviderRuntimeStateTouch): string {
    if (!Number.isFinite(touch.lastAccessedAt) || touch.lastAccessedAt < 0) {
      throw new TypeError('Provider runtime-state touch time must be finite and non-negative');
    }
    return `${touch.kind}:${serializeProviderRuntimeStateRecordKey(touch.kind, { key: touch.key })}`;
  }

  return {
    path,
    read: () => enqueue(async () => cloneState(await loadUnlocked())),
    update: (transform, pruneContext = {}) => enqueue(async () => {
      const current = await loadUnlocked();
      const candidate = await transform(cloneState(current));
      return cloneState(await commitUnlocked(candidate, pruneContext));
    }),
    touch(touch): void {
      const snapshot = structuredClone(touch);
      const key = validateTouch(snapshot);
      const existing = pendingTouches.get(key);
      if (!existing || snapshot.lastAccessedAt > existing.lastAccessedAt) pendingTouches.set(key, snapshot);
    },
    flushTouches: (pruneContext = {}) => enqueue(async () => {
      const current = await loadUnlocked();
      if (pendingTouches.size === 0) return cloneState(current);
      const captured = new Map(pendingTouches);
      pendingTouches.clear();
      const candidate = cloneState(current);
      let changed = false;
      for (const touch of captured.values()) {
        changed = applyTouchToExistingRecord(candidate, touch) || changed;
      }
      if (!changed) return cloneState(current);
      try {
        return cloneState(await commitUnlocked(candidate, pruneContext));
      } catch (error) {
        for (const [key, touch] of captured) {
          const pending = pendingTouches.get(key);
          if (!pending || touch.lastAccessedAt > pending.lastAccessedAt) pendingTouches.set(key, touch);
        }
        throw error;
      }
    }),
  };
}
