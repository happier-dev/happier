import { chmod, mkdir, mkdtemp, readFile, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROVIDER_RUNTIME_STATE_LIMITS_V1,
  ProviderEndpointRuntimeStateRecordV1Schema,
  ProviderRuntimeStateFileV1Schema,
  type ProviderRuntimeStateFileV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  createProviderRuntimeStateStore,
  resolveProviderRuntimeStatePath,
} from './store';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-state-'));
  tempDirs.push(home);
  return home;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const endpointRecord = (id: string, lastAccessedAt: number, activity: 'idle' | 'checking' = 'idle') => ProviderEndpointRuntimeStateRecordV1Schema.parse({
  key: {
    machineId: 'machine_a', connectionId: 'pc_a', endpointTemplateId: id,
    endpointFingerprint: `endpoint-observation:v1:${id}`,
    observationAuthorizationFingerprint: 'observation-authorization:v1:a',
  },
  state: { status: 'available' as const, activity, observedAt: 1 },
  lastAccessedAt,
});

function fileWithEndpoint(record = endpointRecord('responses', 1)): ProviderRuntimeStateFileV1 {
  return ProviderRuntimeStateFileV1Schema.parse({
    v: 1, machineId: 'machine_a', endpointHealth: [record], catalogs: [],
    installationChecks: [], modelLoadStates: [],
  });
}

describe('provider runtime-state store', () => {
  it('uses the fixed private path, creates missing state, and persists mode 0600', async () => {
    const happyHomeDir = await tempHome();
    const diagnostics: unknown[] = [];
    const store = createProviderRuntimeStateStore({
      happyHomeDir, machineId: 'machine_a', onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await expect(store.read()).resolves.toEqual({
      v: 1, machineId: 'machine_a', endpointHealth: [], catalogs: [],
      installationChecks: [], modelLoadStates: [],
    });
    await store.update(() => fileWithEndpoint());
    expect(store.path).toBe(join(happyHomeDir, 'providers', 'runtime-state-v1.json'));
    expect(resolveProviderRuntimeStatePath(happyHomeDir)).toBe(store.path);
    const persisted = JSON.parse(await readFile(store.path, 'utf8'));
    expect(persisted).toEqual(fileWithEndpoint());
    if (process.platform !== 'win32') {
      expect((await stat(join(happyHomeDir, 'providers'))).mode & 0o077).toBe(0);
      expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    }
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ['empty file', '', 'malformed'],
    ['malformed JSON', '{', 'malformed'],
    ['future schema', JSON.stringify({ ...fileWithEndpoint(), v: 2 }), 'future_version'],
    ['cross-machine state', JSON.stringify({ ...fileWithEndpoint(), machineId: 'machine_b' }), 'machine_mismatch'],
    ['semantic duplicates', JSON.stringify({
      ...fileWithEndpoint(), endpointHealth: [endpointRecord('responses', 1), endpointRecord('responses', 2)],
    }), 'duplicate_key'],
  ])('loads %s as diagnostic empty state that a later valid write replaces', async (_label, raw, reason) => {
    const happyHomeDir = await tempHome();
    const path = resolveProviderRuntimeStatePath(happyHomeDir);
    await mkdir(join(happyHomeDir, 'providers'), { recursive: true });
    await writeFile(path, raw, 'utf8');
    const diagnostics: Array<{ reason: string }> = [];
    const store = createProviderRuntimeStateStore({
      happyHomeDir, machineId: 'machine_a',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await expect(store.read()).resolves.toMatchObject({ endpointHealth: [] });
    expect(diagnostics).toEqual([expect.objectContaining({ reason })]);
    await store.update(() => fileWithEndpoint());
    await expect(store.read()).resolves.toEqual(fileWithEndpoint());
  });

  it('keeps invalid-cache recovery authoritative when a diagnostic observer throws', async () => {
    const happyHomeDir = await tempHome();
    const path = resolveProviderRuntimeStatePath(happyHomeDir);
    await mkdir(join(happyHomeDir, 'providers'), { recursive: true });
    await writeFile(path, '{', 'utf8');
    const store = createProviderRuntimeStateStore({
      happyHomeDir,
      machineId: 'machine_a',
      onDiagnostic: () => {
        throw new Error('observer failed');
      },
    });

    await expect(store.read()).resolves.toEqual({
      v: 1,
      machineId: 'machine_a',
      endpointHealth: [],
      catalogs: [],
      installationChecks: [],
      modelLoadStates: [],
    });
  });

  it('rejects an oversized file from stat before JSON parsing', async () => {
    const happyHomeDir = await tempHome();
    const path = resolveProviderRuntimeStatePath(happyHomeDir);
    await mkdir(join(happyHomeDir, 'providers'), { recursive: true });
    await writeFile(path, '{}', 'utf8');
    await truncate(path, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes + 1);
    const diagnostics: Array<{ reason: string }> = [];
    const store = createProviderRuntimeStateStore({
      happyHomeDir, machineId: 'machine_a',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await expect(store.read()).resolves.toMatchObject({ endpointHealth: [] });
    expect(diagnostics).toEqual([expect.objectContaining({ reason: 'encoded_size_exceeded' })]);
  });

  it('preflights raw top-level array counts before element parsing', async () => {
    const happyHomeDir = await tempHome();
    const path = resolveProviderRuntimeStatePath(happyHomeDir);
    await mkdir(join(happyHomeDir, 'providers'), { recursive: true });
    await writeFile(path, JSON.stringify({
      v: 1,
      machineId: 'machine_a',
      endpointHealth: Array.from(
        { length: PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEndpointRecords + 1 },
        () => ({ malformed: true }),
      ),
      catalogs: [],
      installationChecks: [],
      modelLoadStates: [],
    }), 'utf8');
    const diagnostics: Array<{ reason: string }> = [];
    const store = createProviderRuntimeStateStore({
      happyHomeDir, machineId: 'machine_a',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await expect(store.read()).resolves.toMatchObject({ endpointHealth: [] });
    expect(diagnostics).toEqual([expect.objectContaining({ reason: 'limit_exceeded' })]);
  });

  it('resets checking activity on restart without discarding settled health', async () => {
    const happyHomeDir = await tempHome();
    const path = resolveProviderRuntimeStatePath(happyHomeDir);
    await mkdir(join(happyHomeDir, 'providers'), { recursive: true });
    await writeFile(path, JSON.stringify(fileWithEndpoint(endpointRecord('responses', 1, 'checking'))), 'utf8');
    const store = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine_a' });
    await expect(store.read()).resolves.toMatchObject({
      endpointHealth: [{ state: { status: 'available', activity: 'idle', observedAt: 1 } }],
    });
  });

  it('keeps checking activity live in memory but never persists it', async () => {
    const happyHomeDir = await tempHome();
    const store = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine_a' });
    const checking = fileWithEndpoint(endpointRecord('responses', 1, 'checking'));
    await expect(store.update(() => checking)).resolves.toEqual(checking);
    await expect(store.read()).resolves.toEqual(checking);
    const persisted = ProviderRuntimeStateFileV1Schema.parse(JSON.parse(await readFile(store.path, 'utf8')));
    expect(persisted.endpointHealth[0]?.state.activity).toBe('idle');
    expect(persisted.endpointHealth[0]?.state).toMatchObject({ status: 'available', observedAt: 1 });
  });

  it('serializes concurrent mutations without losing either update', async () => {
    const happyHomeDir = await tempHome();
    const store = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine_a' });
    await Promise.all([
      store.update(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ...state, endpointHealth: [...state.endpointHealth, endpointRecord('a', 1)] };
      }),
      store.update((state) => ({
        ...state, endpointHealth: [...state.endpointHealth, endpointRecord('b', 2)],
      })),
    ]);
    expect((await store.read()).endpointHealth.map((record) => record.key.endpointTemplateId))
      .toEqual(['a', 'b']);
  });

  it('rejects an in-memory mutation that changes the store machine envelope', async () => {
    const happyHomeDir = await tempHome();
    const store = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine_a' });
    await expect(store.update((state) => ({ ...state, machineId: 'machine_b' })))
      .rejects.toThrow(/machine/u);
    await expect(store.read()).resolves.toMatchObject({ machineId: 'machine_a' });
  });

  it('retains the previous in-memory and disk state when an atomic write fails', async () => {
    const happyHomeDir = await tempHome();
    let writes = 0;
    const store = createProviderRuntimeStateStore({
      happyHomeDir, machineId: 'machine_a',
      writeJsonAtomic: async (path, value) => {
        writes += 1;
        if (writes === 2) throw new Error('injected write failure');
        await writeJsonAtomic(path, value);
      },
    });
    await store.update(() => fileWithEndpoint(endpointRecord('first', 1)));
    await expect(store.update((state) => ({
      ...state, endpointHealth: [endpointRecord('second', 2)],
    }))).rejects.toThrow(/injected write failure/u);
    expect(await store.read()).toEqual(fileWithEndpoint(endpointRecord('first', 1)));
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(fileWithEndpoint(endpointRecord('first', 1)));
  });

  it('coalesces explicit touches into one durable write and never invents a cache row', async () => {
    const happyHomeDir = await tempHome();
    const writer = vi.fn(writeJsonAtomic);
    const store = createProviderRuntimeStateStore({
      happyHomeDir, machineId: 'machine_a', writeJsonAtomic: writer,
    });
    await store.update(() => fileWithEndpoint(endpointRecord('responses', 1)));
    store.touch({ kind: 'endpointHealth', key: endpointRecord('responses', 1).key, lastAccessedAt: 2 });
    store.touch({ kind: 'endpointHealth', key: endpointRecord('responses', 1).key, lastAccessedAt: 3 });
    store.touch({ kind: 'endpointHealth', key: endpointRecord('missing', 1).key, lastAccessedAt: 99 });
    expect(writer).toHaveBeenCalledTimes(1);
    await store.flushTouches();
    expect(writer).toHaveBeenCalledTimes(2);
    const state = await store.read();
    expect(state.endpointHealth).toHaveLength(1);
    expect(state.endpointHealth[0]?.lastAccessedAt).toBe(3);
  });

  it('snapshots a queued touch so later caller mutation cannot retarget it', async () => {
    const happyHomeDir = await tempHome();
    const store = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine_a' });
    await store.update(() => ({
      ...fileWithEndpoint(),
      endpointHealth: [endpointRecord('a', 1), endpointRecord('b', 1)],
    }));
    const touch = {
      kind: 'endpointHealth' as const,
      key: structuredClone(endpointRecord('a', 1).key),
      lastAccessedAt: 2,
    };
    store.touch(touch);
    touch.key.endpointTemplateId = 'b';
    touch.lastAccessedAt = 99;

    await store.flushTouches();

    const state = await store.read();
    expect(state.endpointHealth.map((record) => [record.key.endpointTemplateId, record.lastAccessedAt]))
      .toEqual([['a', 2], ['b', 1]]);
  });

  it('does not write when every coalesced touch is a cache miss', async () => {
    const happyHomeDir = await tempHome();
    const writer = vi.fn(writeJsonAtomic);
    const store = createProviderRuntimeStateStore({
      happyHomeDir, machineId: 'machine_a', writeJsonAtomic: writer,
    });
    await store.read();
    store.touch({ kind: 'endpointHealth', key: endpointRecord('missing', 1).key, lastAccessedAt: 2 });
    await store.flushTouches();
    expect(writer).not.toHaveBeenCalled();
    await expect(readFile(store.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores coalesced touches after a failed flush', async () => {
    const happyHomeDir = await tempHome();
    let fail = false;
    const writer = vi.fn(async (path: string, value: unknown) => {
      if (fail) throw new Error('touch write failed');
      await writeJsonAtomic(path, value);
    });
    const store = createProviderRuntimeStateStore({
      happyHomeDir, machineId: 'machine_a', writeJsonAtomic: writer,
    });
    await store.update(() => fileWithEndpoint(endpointRecord('responses', 1)));
    store.touch({ kind: 'endpointHealth', key: endpointRecord('responses', 1).key, lastAccessedAt: 5 });
    fail = true;
    await expect(store.flushTouches()).rejects.toThrow(/touch write failed/u);
    expect((await store.read()).endpointHealth[0]?.lastAccessedAt).toBe(1);
    fail = false;
    await store.flushTouches();
    expect((await store.read()).endpointHealth[0]?.lastAccessedAt).toBe(5);
  });

  it('repairs permissive existing directory/file modes on write', async () => {
    if (process.platform === 'win32') return;
    const happyHomeDir = await tempHome();
    const path = resolveProviderRuntimeStatePath(happyHomeDir);
    await mkdir(join(happyHomeDir, 'providers'), { recursive: true });
    await chmod(join(happyHomeDir, 'providers'), 0o777);
    await writeFile(path, JSON.stringify(fileWithEndpoint()), { mode: 0o666 });
    await chmod(path, 0o666);
    const store = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine_a' });
    await store.update((state) => state);
    expect((await stat(join(happyHomeDir, 'providers'))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('refuses a symlinked provider-state directory instead of writing outside the Happier home', async () => {
    if (process.platform === 'win32') return;
    const happyHomeDir = await tempHome();
    const externalDir = await tempHome();
    await symlink(externalDir, join(happyHomeDir, 'providers'));
    const store = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine_a' });

    await expect(store.update(() => fileWithEndpoint())).rejects.toThrow(/symbolic link/u);
    await expect(readFile(join(externalDir, 'runtime-state-v1.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
