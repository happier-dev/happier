import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { resolvePersonalHomeRuntimeLayout } from './layout.js';
import { erasePersonalHomeData } from './erase.js';

describe('Personal Home erase', () => {
  it('requires explicit confirmation before deleting the data root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-erase-'));
    const layout = resolvePersonalHomeRuntimeLayout({
      homeDir: root,
      env: {
        HAPPIER_SELF_HOST_INSTALL_ROOT: join(root, 'runtime'),
        HAPPIER_SERVER_LIGHT_DATA_DIR: join(root, 'runtime', 'data'),
      },
    });
    await mkdir(layout.dataDir, { recursive: true });
    const marker = join(layout.dataDir, 'marker.txt');
    await writeFile(marker, 'keep?');

    await expect(erasePersonalHomeData({ layout, confirmed: false })).rejects.toMatchObject({
      code: 'confirmation_required',
    });
    await expect(readFile(marker, 'utf8')).resolves.toBe('keep?');
  });

  it('removes only the validated Personal Home data root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-erase-'));
    const layout = resolvePersonalHomeRuntimeLayout({
      homeDir: root,
      env: {
        HAPPIER_SELF_HOST_INSTALL_ROOT: join(root, 'runtime'),
        HAPPIER_SERVER_LIGHT_DATA_DIR: join(root, 'runtime', 'data'),
      },
    });
    await mkdir(layout.dataDir, { recursive: true });
    await writeFile(join(layout.dataDir, 'marker.txt'), 'remove');
    const sibling = join(root, 'sibling.txt');
    await writeFile(sibling, 'preserve');

    await expect(erasePersonalHomeData({ layout, confirmed: true })).resolves.toEqual({
      removedPaths: [layout.dataDir],
    });
    await expect(readFile(sibling, 'utf8')).resolves.toBe('preserve');
    await expect(readFile(join(layout.dataDir, 'marker.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
