import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env.testkit';
import type { Credentials } from '@/persistence';

describe('memoryWorker', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-memory-worker-'));
    applyEnvValues({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: 'https://api.example.test',
      HAPPIER_WEBAPP_URL: 'https://app.example.test',
    });
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.resetModules();
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
  });

  it('creates the tier-1 sqlite DB when enabled', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });

    const { configuration } = await import('@/configuration');
    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.reloadSettings();
    const s = await stat(join(configuration.activeServerDir, 'memory', 'memory.sqlite'));
    expect(s.isFile()).toBe(true);

    worker.stop();
  });

  it('creates the deep sqlite DB when enabled in deep mode', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep' });

    const { configuration } = await import('@/configuration');
    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.reloadSettings();
    const s = await stat(join(configuration.activeServerDir, 'memory', 'deep.sqlite'));
    expect(s.isFile()).toBe(true);

    worker.stop();
  });

  it('deletes DBs when disabled with deleteOnDisable=true', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });

    const { configuration } = await import('@/configuration');
    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.reloadSettings();
    const dummyCacheDir = join(configuration.activeServerDir, 'memory', 'models', 'transformers');
    await mkdir(dummyCacheDir, { recursive: true });
    await writeFile(join(dummyCacheDir, 'dummy.bin'), 'x', 'utf8');
    await writeMemorySettingsToDisk({ v: 1, enabled: false, indexMode: 'hints', deleteOnDisable: true });
    await worker.reloadSettings();

    await expect(stat(join(configuration.activeServerDir, 'memory', 'memory.sqlite'))).rejects.toBeTruthy();
    await expect(stat(join(dummyCacheDir, 'dummy.bin'))).rejects.toBeTruthy();
    worker.stop();
  });

  it('ingests session_summary_shard.v1 transcript artifacts into the tier-1 index', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });

    const { startMemoryWorker } = await import('./memoryWorker');
    const { searchTier1Memory } = await import('./searchMemory');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = startMemoryWorker({
      credentials,
      machineId: 'machine_1',
      deps: {
        fetchDecryptedTranscriptPageAfterSeq: async () => [
          {
            seq: 12,
            createdAtMs: 2000,
            role: 'agent' as const,
            content: { type: 'text', text: '[memory]' },
            meta: {
              happier: {
                kind: 'session_summary_shard.v1',
                payload: {
                  v: 1,
                  seqFrom: 10,
                  seqTo: 12,
                  createdAtFromMs: 1000,
                  createdAtToMs: 2000,
                  summary: 'We discussed integrating OpenClaw memory search.',
                  keywords: ['openclaw', 'memory'],
                  entities: ['Happier'],
                  decisions: ['Make memory search opt-in'],
                },
              },
            },
          },
        ],
      },
    });

    await worker.reloadSettings();
    await worker.ensureUpToDate('sess-1');

    const dbPath = worker.getTier1DbPath();
    expect(dbPath).toBeTruthy();

    const result = searchTier1Memory({
      dbPath: dbPath!,
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]!.sessionId).toBe('sess-1');

    worker.stop();
  });

  it('indexes transcript text into the deep index when ensureUpToDate is called', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep' });

    const { startMemoryWorker } = await import('./memoryWorker');
    const { searchTier2Memory } = await import('./searchMemory');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = startMemoryWorker({
      credentials,
      machineId: 'machine_1',
      deps: {
        fetchDecryptedTranscriptPageAfterSeq: async () => [
          { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'hello openclaw' } },
          { seq: 2, createdAtMs: 2000, role: 'agent' as const, content: { type: 'text', text: 'we discussed memory search' } },
        ],
      },
    });

    await worker.reloadSettings();
    await worker.ensureUpToDate('sess-1');

    const tier1Path = worker.getTier1DbPath();
    expect(tier1Path).toBeTruthy();
    if (tier1Path) {
      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      const cursors = tier1.getSessionCursors({ sessionId: 'sess-1', nowMs: Date.now() });
      expect(cursors.lastDeepIndexedSeq).toBe(2);
      tier1.close();
    }

    const deepPath = worker.getDeepDbPath();
    expect(deepPath).toBeTruthy();

    const result = await searchTier2Memory({
      dbPath: deepPath!,
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep' },
      previewChars: 240,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.sessionId).toBe('sess-1');

    worker.stop();
  });
});
