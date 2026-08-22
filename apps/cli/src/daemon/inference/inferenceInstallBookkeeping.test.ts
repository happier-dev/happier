import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInferenceInstallBookkeeping } from './inferenceInstallBookkeeping';

describe('inferenceInstallBookkeeping', () => {
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
