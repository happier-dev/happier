import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const cacheHome = vi.hoisted(
  () => `${process.env.TMPDIR ?? '/tmp'}/happier-released-startup-overrides-v1-${process.pid}`,
);

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: cacheHome,
  },
}));

import {
  resolveReleasedCodexStartupOverridesCacheV1Compatibility,
} from './releasedStartupOverridesCacheV1';

describe('releasedStartupOverridesCacheV1 compatibility adapter', () => {
  afterAll(async () => {
    await rm(cacheHome, { recursive: true, force: true });
  });

  it('reads the exact deployed cli-v0.2.0 V1 file through the Codex-only owner', async () => {
    await rm(cacheHome, { recursive: true, force: true });
    const cachePath = join(cacheHome, 'cli', 'startup-overrides-cache.json');
    await mkdir(join(cacheHome, 'cli'), { recursive: true });
    await writeFile(cachePath, JSON.stringify({
      version: 1,
      byBackend: {
        codex: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 41,
          modelId: 'gpt-5.1-codex-max',
          modelUpdatedAt: 42,
          updatedAt: 43,
        },
      },
    }), 'utf8');
    const compatibility = resolveReleasedCodexStartupOverridesCacheV1Compatibility('codex');
    if (!compatibility) throw new Error('expected deployed Codex compatibility owner');

    expect(compatibility.read({
      nowMs: 50,
      maxAgeMs: 7,
    })).toEqual({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 41,
      modelId: 'gpt-5.1-codex-max',
      modelUpdatedAt: 42,
      updatedAt: 43,
    });
    expect(compatibility.read({
      nowMs: 51,
      maxAgeMs: 7,
    })).toBeNull();
    expect(resolveReleasedCodexStartupOverridesCacheV1Compatibility('claude')).toBeNull();
  });

  it('preserves the deployed V1 path, schema, timestamps, and max-age semantics', async () => {
    const compatibility = resolveReleasedCodexStartupOverridesCacheV1Compatibility('codex');
    if (!compatibility) throw new Error('expected deployed Codex compatibility owner');

    compatibility.write({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 101,
      modelId: 'gpt-5.1-codex-max',
      modelUpdatedAt: 102,
      updatedAt: 103,
    });
    compatibility.write({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 104,
      modelId: 'gpt-5.2-codex',
      modelUpdatedAt: 105,
      updatedAt: 106,
    });

    const cachePath = join(cacheHome, 'cli', 'startup-overrides-cache.json');
    await vi.waitFor(async () => {
      await expect(readFile(cachePath, 'utf8')).resolves.toBe(
        JSON.stringify({
          version: 1,
          byBackend: {
            codex: {
              permissionMode: 'yolo',
              permissionModeUpdatedAt: 104,
              modelId: 'gpt-5.2-codex',
              modelUpdatedAt: 105,
              updatedAt: 106,
            },
          },
        }),
      );
    });

    expect(compatibility.read({
      nowMs: 113,
      maxAgeMs: 7,
    })).toEqual({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 104,
      modelId: 'gpt-5.2-codex',
      modelUpdatedAt: 105,
      updatedAt: 106,
    });
    expect(compatibility.read({
      nowMs: 114,
      maxAgeMs: 7,
    })).toBeNull();
  });
});
