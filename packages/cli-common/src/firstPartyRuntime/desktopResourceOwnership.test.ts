import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  readDesktopResourceOwnership, recordDesktopResourceUse, releaseDesktopResourceUse,
  resolveDesktopResourceOwnershipPath, withDesktopResourceOwnership,
} from './desktopResourceOwnership.js';

async function withResource(test: (resourcePath: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'happier-desktop-resource-'));
  const resourcePath = join(home, 'service.definition');
  try {
    await writeFile(resourcePath, 'original definition');
    await test(resourcePath);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('Desktop resource lifecycle', () => {
  it.each(['file', 'directory'] as const)('retries cleanup bookkeeping after the %s was removed before teardown failed', async (kind) => {
    await withResource(async (resourcePath) => {
      if (kind === 'directory') { await rm(resourcePath); await mkdir(resourcePath); }
      await recordDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', created: true });
      await expect(releaseDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', remove: async () => {
        await rm(resourcePath, { recursive: true });
        throw new Error('later cleanup denied');
      } })).rejects.toThrow('later cleanup denied');
      expect((await readDesktopResourceOwnership(resourcePath))?.consumers).toEqual(['dev.happier.app']);
      let retried = false;
      expect(await releaseDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', remove: async () => { retried = true; } })).toBe('removed');
      expect(retried).toBe(true);
      expect(await readDesktopResourceOwnership(resourcePath)).toBeNull();
    });
  });

  it('retains unknown adoption and removes a created resource only after the last consumer; failures remain retryable', async () => {
    await withResource(async (resourcePath) => {
      await recordDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.preview', created: false });
      expect(await readDesktopResourceOwnership(resourcePath)).toBeNull();
      await recordDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', created: true });
      await recordDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.preview', created: false });
      let removed = false;
      const remove = async () => { removed = true; await rm(resourcePath); };
      expect(await releaseDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', remove })).toBe('retained');
      expect(removed).toBe(false);
      await expect(releaseDesktopResourceUse({
        resourcePath, bundleId: 'dev.happier.preview', remove: async () => { throw new Error('access denied'); },
      })).rejects.toThrow('access denied');
      expect((await readDesktopResourceOwnership(resourcePath))?.consumers).toEqual(['dev.happier.preview']);
      expect(await releaseDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.preview', remove })).toBe('removed');
      await expect(readFile(resourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readDesktopResourceOwnership(resourcePath)).toBeNull();
    });
  });

  it('refuses deletion of an unrecognized replacement definition even when its predecessor was Desktop-created', async () => {
    await withResource(async (resourcePath) => {
      await recordDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', created: true });
      await writeFile(resourcePath, 'user replacement definition');
      let removed = false;
      await expect(releaseDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', remove: async () => { removed = true; } }))
        .rejects.toThrow();
      expect(removed).toBe(false);
      expect(await readFile(resourcePath, 'utf8')).toBe('user replacement definition');
    });
  });

  it('preserves authority across an owner-controlled update but never on explicit standalone install or malformed metadata', async () => {
    await withResource(async (resourcePath) => {
      await recordDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', created: true });
      await withDesktopResourceOwnership({ resourcePath, preserve: true, operation: async () => {
        await writeFile(resourcePath, 'updated definition');
        return { value: undefined, created: false };
      } });
      expect((await readDesktopResourceOwnership(resourcePath))?.consumers).toEqual(['dev.happier.app']);
      await withDesktopResourceOwnership({ resourcePath, operation: async () => ({ value: undefined, created: false }) });
      expect(await readDesktopResourceOwnership(resourcePath)).toBeNull();
      await writeFile(resolveDesktopResourceOwnershipPath(resourcePath), '{"version":99}');
      let removed = false;
      await expect(releaseDesktopResourceUse({ resourcePath, bundleId: 'dev.happier.app', remove: async () => { removed = true; } }))
        .rejects.toThrow();
      expect(removed).toBe(false);
    });
  });
});
