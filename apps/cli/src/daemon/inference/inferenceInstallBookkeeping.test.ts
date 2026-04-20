import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInferenceInstallBookkeeping } from './inferenceInstallBookkeeping';

describe('inferenceInstallBookkeeping', () => {
  it('persists installed model state and progress snapshots', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-inference-install-bookkeeping-'));
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: join(rootDir, 'installs.json'),
    });
    const phases: string[] = [];

    await bookkeeping.install({
      modelId: 'kokoro-82m',
      version: '1',
      manifestHash: 'a'.repeat(64),
      onProgress: async (report) => {
        phases.push(report.phase);
      },
      performInstall: async (reportProgress) => {
        await reportProgress({ phase: 'downloading', progress: 0.5 });
      },
    });

    expect(phases).toEqual(['queued', 'downloading', 'complete']);
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

  it('records failed installs and clears them on remove', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-inference-install-bookkeeping-'));
    const bookkeeping = createInferenceInstallBookkeeping({
      stateFilePath: join(rootDir, 'installs.json'),
    });

    await expect(bookkeeping.install({
      modelId: 'kokoro-82m',
      version: '1',
      manifestHash: 'b'.repeat(64),
      performInstall: async () => {
        throw new Error('download_failed');
      },
    })).rejects.toThrow('download_failed');

    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'error',
      version: '1',
      manifestHash: 'b'.repeat(64),
      lastError: 'download_failed',
      progress: {
        phase: 'error',
        progress: 1,
        message: 'download_failed',
      },
    });

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

  it('preserves the previously installed manifest identity when a reinstall fails', async () => {
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
        throw new Error('reinstall_failed');
      },
    })).rejects.toThrow('reinstall_failed');

    await expect(bookkeeping.status('kokoro-82m')).resolves.toMatchObject({
      state: 'error',
      version: '1',
      manifestHash: 'a'.repeat(64),
      lastError: 'reinstall_failed',
    });
    expect(JSON.parse(readFileSync(join(rootDir, 'installs.json'), 'utf8'))).toMatchObject({
      modelsById: {
        'kokoro-82m': {
          state: 'error',
          version: '1',
          manifestHash: 'a'.repeat(64),
          lastError: 'reinstall_failed',
        },
      },
    });
  });
});
