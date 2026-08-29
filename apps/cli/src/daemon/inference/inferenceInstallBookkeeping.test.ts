import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createInferenceInstallBookkeeping, type InferenceInstallProgress } from './inferenceInstallBookkeeping';

describe('inferenceInstallBookkeeping', () => {
  it('reconciles prior-process transient installs through the canonical artifact verifier', async () => {
    const persisted = {
      modelsById: {
        verified: {
          modelId: 'verified', state: 'installing', version: '1', manifestHash: 'a'.repeat(64),
          kind: 'tts_sherpa', model: 'kokoro', updatedAtMs: 1,
          progress: { phase: 'installing', progress: 0.9 }, lastError: null,
        },
        interrupted: {
          modelId: 'interrupted', state: 'installing', version: '1', manifestHash: 'b'.repeat(64),
          kind: 'stt_sherpa', model: 'zipformer', updatedAtMs: 1,
          progress: { phase: 'verifying', progress: 0.8 }, lastError: null,
        },
      },
    };
    let saved = '';
    const verifyInterruptedInstall = vi.fn(async (model: { modelId: string }) => (
      model.modelId === 'verified' ? 'installed' as const : 'interrupted' as const
    ));
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: '/virtual/installs.json',
      readStateFile: async () => JSON.stringify(persisted),
      ensureParentDir: async () => {},
      writeStateFile: async (_path, contents) => { saved = contents; },
      verifyInterruptedInstall,
      now: () => 42,
    });

    await expect(bookkeeping.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: 'verified', state: 'installed',
        progress: expect.objectContaining({ phase: 'complete', progress: 1 }),
      }),
      expect.objectContaining({
        modelId: 'interrupted', state: 'error', lastError: 'inference_install_interrupted',
        progress: expect.objectContaining({ phase: 'error', message: 'inference_install_interrupted' }),
      }),
    ]));
    expect(verifyInterruptedInstall).toHaveBeenCalledTimes(2);
    expect(saved).toContain('inference_install_interrupted');
    expect(Object.values(JSON.parse(saved).modelsById).map((model: any) => model.state))
      .not.toContain('installing');
  });

  it('shares one initialization read so concurrent status and install cannot observe or overwrite empty state', async () => {
    let releaseRead!: (contents: string) => void;
    const deferredRead = new Promise<string>((resolve) => { releaseRead = resolve; });
    const readStateFile = vi.fn(async () => await deferredRead);
    const writes: string[] = [];
    const performInstall = vi.fn(async () => {});
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: '/virtual/installs.json',
      readStateFile,
      ensureParentDir: async () => {},
      writeStateFile: async (_path, contents) => { writes.push(contents); },
    });

    const status = bookkeeping.status('existing');
    const install = bookkeeping.install({
      modelId: 'new',
      version: '1',
      manifestHash: 'b'.repeat(64),
      performInstall,
    });
    await Promise.resolve();
    expect(readStateFile).toHaveBeenCalledTimes(1);
    expect(performInstall).not.toHaveBeenCalled();
    expect(writes).toEqual([]);

    releaseRead(JSON.stringify({
      modelsById: {
        existing: {
          modelId: 'existing', state: 'installed', version: '1', manifestHash: 'a'.repeat(64),
          kind: 'tts_sherpa', model: 'kokoro', updatedAtMs: 1,
          progress: { phase: 'complete', progress: 1 }, lastError: null,
        },
      },
    }));

    await expect(status).resolves.toMatchObject({ modelId: 'existing', state: 'installed' });
    await install;
    await expect(bookkeeping.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'existing', state: 'installed' }),
      expect.objectContaining({ modelId: 'new', state: 'installed' }),
    ]));
    expect(readStateFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes.at(-1)!).modelsById).toHaveProperty('existing');
  });

  it('serializes fire-and-forget progress before terminal completion and ignores post-terminal progress', async () => {
    let persistedContents = '';
    let releaseDownloadingWrite!: () => void;
    const downloadingWriteGate = new Promise<void>((resolve) => {
      releaseDownloadingWrite = resolve;
    });
    const persistedPhases: string[] = [];
    const captured = {
      reportProgress: null as ((progress: InferenceInstallProgress) => Promise<void>) | null,
    };
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: '/virtual/installs.json',
      readStateFile: async () => {
        throw new Error('not_found');
      },
      ensureParentDir: async () => {},
      writeStateFile: async (_filePath, contents) => {
        const parsed = JSON.parse(contents) as { modelsById: Record<string, { progress: { phase: string } }> };
        const phase = parsed.modelsById['kokoro-82m']?.progress.phase;
        persistedPhases.push(phase);
        if (phase === 'downloading') {
          await downloadingWriteGate;
        }
        persistedContents = contents;
      },
    });

    let installSettled = false;
    const installPromise = bookkeeping.install({
      modelId: 'kokoro-82m',
      version: '1',
      manifestHash: 'a'.repeat(64),
      performInstall: async (reportProgress) => {
        captured.reportProgress = reportProgress;
        void reportProgress({ phase: 'downloading', progress: 0.5 });
      },
    }).finally(() => {
      installSettled = true;
    });

    await vi.waitFor(() => expect(persistedPhases).toEqual(['queued', 'downloading']));
    expect(installSettled).toBe(false);
    releaseDownloadingWrite();
    await installPromise;

    expect(persistedPhases).toEqual(['queued', 'downloading', 'complete']);
    expect(JSON.parse(persistedContents)).toMatchObject({
      modelsById: {
        'kokoro-82m': {
          state: 'installed',
          progress: { phase: 'complete' },
        },
      },
    });

    await captured.reportProgress?.({ phase: 'downloading', progress: 0.9 });
    expect(persistedPhases).toEqual(['queued', 'downloading', 'complete']);
    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'installed',
      progress: { phase: 'complete' },
    });
  });

  it('coalesces same-phase progress latest-wins while persisting phase transitions and terminal state', async () => {
    vi.useFakeTimers();
    try {
      const persisted: Array<{ phase: string; progress: number }> = [];
      const bookkeeping = createInferenceInstallBookkeeping({
        stateFilePath: '/virtual/installs.json',
        readStateFile: async () => { throw new Error('not_found'); },
        ensureParentDir: async () => {},
        writeStateFile: async (_path, contents) => {
          const current = JSON.parse(contents).modelsById.pack.progress;
          persisted.push({ phase: current.phase, progress: current.progress });
        },
        progressPersistenceIntervalMs: 100,
      });

      await bookkeeping.install({
        modelId: 'pack',
        version: '1',
        manifestHash: 'a'.repeat(64),
        performInstall: async (reportProgress) => {
          void reportProgress({ phase: 'downloading', progress: 0.1 });
          void reportProgress({ phase: 'downloading', progress: 0.2 });
          void reportProgress({ phase: 'downloading', progress: 0.3 });
          await vi.advanceTimersByTimeAsync(100);
          void reportProgress({ phase: 'downloading', progress: 0.4 });
          await reportProgress({ phase: 'verifying', progress: 0.9 });
        },
      });

      expect(persisted).toEqual([
        { phase: 'queued', progress: 0 },
        // Entering downloading is itself a phase transition and must become
        // observable immediately. Subsequent same-phase writes coalesce to
        // the latest value at the bounded cadence.
        { phase: 'downloading', progress: 0.1 },
        { phase: 'downloading', progress: 0.3 },
        { phase: 'verifying', progress: 0.9 },
        { phase: 'complete', progress: 1 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a fire-and-forget progress persistence failure and persists terminal error state', async () => {
    let failedDownloadingWrite = false;
    const persistedPhases: string[] = [];
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: '/virtual/installs.json',
      readStateFile: async () => {
        throw new Error('not_found');
      },
      ensureParentDir: async () => {},
      writeStateFile: async (_filePath, contents) => {
        const parsed = JSON.parse(contents) as { modelsById: Record<string, { progress: { phase: string } }> };
        const phase = parsed.modelsById['kokoro-82m']?.progress.phase;
        persistedPhases.push(phase);
        if (phase === 'downloading' && !failedDownloadingWrite) {
          failedDownloadingWrite = true;
          throw new Error('progress_persistence_failed');
        }
      },
    });

    await expect(bookkeeping.install({
      modelId: 'kokoro-82m',
      version: '1',
      manifestHash: 'a'.repeat(64),
      performInstall: async (reportProgress) => {
        void reportProgress({ phase: 'downloading', progress: 0.5 });
      },
    })).rejects.toThrow('progress_persistence_failed');

    expect(persistedPhases).toEqual(['queued', 'downloading', 'error']);
    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'error',
      progress: { phase: 'error' },
      lastError: 'inference_install_failed',
    });
  });

  it('persists installed model state and progress snapshots', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-inference-install-bookkeeping-'));
    const privateProgress = 'downloading /Users/alice/private/model.bin?token=sk-private';
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: join(rootDir, 'installs.json'),
    });
    const snapshots: Array<{ phase: string; message?: string | null }> = [];

    await bookkeeping.install({
      modelId: 'kokoro-82m',
      version: '1',
      manifestHash: 'a'.repeat(64),
      onProgress: async (report) => {
        snapshots.push({ phase: report.phase, message: report.message });
      },
      performInstall: async (reportProgress) => {
        await reportProgress({ phase: 'downloading', progress: 0.5, message: privateProgress });
      },
    });

    expect(snapshots).toEqual([
      { phase: 'queued', message: undefined },
      { phase: 'downloading', message: null },
      { phase: 'complete', message: undefined },
    ]);
    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'installed',
      version: '1',
      manifestHash: 'a'.repeat(64),
    });
    expect(await bookkeeping.list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(rootDir, 'installs.json'), 'utf8'))).toMatchObject({
      modelsById: {
        'kokoro-82m': {
          state: 'installed',
          version: '1',
        },
      },
    });
    expect(readFileSync(join(rootDir, 'installs.json'), 'utf8')).not.toContain(privateProgress);
  });

  it('loads persisted installs when listing from a fresh bookkeeping instance', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-inference-install-bookkeeping-'));
    const stateFilePath = join(rootDir, 'installs.json');
    const firstBookkeeping = createInferenceInstallBookkeeping({
      stateFilePath,
    });

    await firstBookkeeping.install({
      modelId: 'kokoro-82m',
      version: '1',
      manifestHash: 'c'.repeat(64),
      performInstall: async () => {},
    });

    const secondBookkeeping = createInferenceInstallBookkeeping({
      stateFilePath,
    });

    expect(await secondBookkeeping.list()).toEqual([
      expect.objectContaining({
        modelId: 'kokoro-82m',
        state: 'installed',
        version: '1',
        manifestHash: 'c'.repeat(64),
      }),
    ]);

    await expect(secondBookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      modelId: 'kokoro-82m',
      state: 'installed',
      version: '1',
      manifestHash: 'c'.repeat(64),
    });
  });

  it('sanitizes legacy persisted installer prose before projecting or retaining it', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-inference-install-bookkeeping-'));
    const stateFilePath = join(rootDir, 'installs.json');
    const privateFailure = 'provider failure for /Users/alice/private/model.bin with credential sk-private';
    writeFileSync(stateFilePath, JSON.stringify({
      modelsById: {
        'kokoro-82m': {
          modelId: 'kokoro-82m',
          state: 'error',
          version: '1',
          manifestHash: 'a'.repeat(64),
          kind: 'tts_sherpa',
          model: 'kokoro',
          updatedAtMs: 1,
          progress: {
            phase: 'error',
            progress: 1,
            message: privateFailure,
          },
          lastError: privateFailure,
        },
      },
    }), 'utf8');

    const bookkeeping = createInferenceInstallBookkeeping({ stateFilePath });

    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      lastError: 'inference_install_failed',
      progress: {
        phase: 'error',
        message: 'inference_install_failed',
      },
    });
    expect(readFileSync(stateFilePath, 'utf8')).not.toContain(privateFailure);
  });

  it('keeps sanitized legacy status available when the best-effort rewrite cannot be persisted', async () => {
    const privateFailure = 'provider failure for /Users/alice/private/model.bin with credential sk-private';
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: '/read-only/installs.json',
      readStateFile: async () => JSON.stringify({
        modelsById: {
          'kokoro-82m': {
            modelId: 'kokoro-82m',
            state: 'error',
            version: '1',
            manifestHash: 'a'.repeat(64),
            kind: 'tts_sherpa',
            model: 'kokoro',
            updatedAtMs: 1,
            progress: { phase: 'error', progress: 1, message: privateFailure },
            lastError: privateFailure,
          },
        },
      }),
      ensureParentDir: async () => {},
      writeStateFile: async () => {
        throw new Error('read_only');
      },
    });

    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'error',
      lastError: 'inference_install_failed',
      progress: { message: 'inference_install_failed' },
    });
  });

  it('records failed installs and clears them on remove', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-inference-install-bookkeeping-'));
    const privateFailure = 'provider failure for /Users/alice/private/model.bin with credential sk-private';
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: join(rootDir, 'installs.json'),
    });

    await expect(bookkeeping.install({
      modelId: 'kokoro-82m',
      version: '1',
      manifestHash: 'b'.repeat(64),
      performInstall: async () => {
        throw new Error(privateFailure);
      },
    })).rejects.toThrow(privateFailure);

    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'error',
      version: '1',
      manifestHash: 'b'.repeat(64),
      lastError: 'inference_install_failed',
      progress: {
        phase: 'error',
        progress: 1,
        message: 'inference_install_failed',
      },
    });
    expect(readFileSync(join(rootDir, 'installs.json'), 'utf8')).not.toContain(privateFailure);

    await bookkeeping.remove('kokoro-82m');

    expect(await bookkeeping.list()).toEqual([]);
    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'not_installed',
      version: null,
      manifestHash: null,
      progress: null,
      lastError: null,
    });
    expect(JSON.parse(readFileSync(join(rootDir, 'installs.json'), 'utf8'))).toEqual({
      modelsById: {},
    });
  });

  it('preserves the previously installed manifest identity and trusted integrity diagnostic when a reinstall fails', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-inference-install-bookkeeping-'));
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: join(rootDir, 'installs.json'),
    });

    await bookkeeping.install({
      modelId: 'kokoro-82m',
      version: '1',
      manifestHash: 'a'.repeat(64),
      performInstall: async () => {},
    });

    await expect(bookkeeping.install({
      modelId: 'kokoro-82m',
      version: '2',
      manifestHash: 'b'.repeat(64),
      performInstall: async () => {
        throw new Error('model_pack_sha256_mismatch');
      },
    })).rejects.toThrow('model_pack_sha256_mismatch');

    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'error',
      version: '1',
      manifestHash: 'a'.repeat(64),
      lastError: 'model_pack_sha256_mismatch',
    });
    expect(JSON.parse(readFileSync(join(rootDir, 'installs.json'), 'utf8'))).toMatchObject({
      modelsById: {
        'kokoro-82m': {
          state: 'error',
          version: '1',
          manifestHash: 'a'.repeat(64),
          lastError: 'model_pack_sha256_mismatch',
        },
      },
    });

    const reloadedBookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: join(rootDir, 'installs.json'),
    });
    await expect(reloadedBookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      lastError: 'model_pack_sha256_mismatch',
      progress: { message: 'model_pack_sha256_mismatch' },
    });
  });
});
