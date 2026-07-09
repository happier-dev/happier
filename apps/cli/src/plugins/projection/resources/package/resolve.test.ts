import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveContainedPluginResourcePath, resolvePluginResourcePath } from './resolve';

let fixtureRoot: string;
let pluginRoot: string;

describe('resolvePluginResourcePath', () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-resource-path-'));
    pluginRoot = join(fixtureRoot, 'plugin');
    await mkdir(join(pluginRoot, 'resources'), { recursive: true });
    await writeFile(join(pluginRoot, 'resources', 'review.md'), '# review\n');
    await writeFile(join(fixtureRoot, 'outside.md'), '# outside\n');
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('resolves package-relative resource paths inside the plugin root', () => {
    const resolved = resolvePluginResourcePath({
      pluginRootPath: pluginRoot,
      resourcePath: './resources/review.md',
    });

    expect(resolved).toEqual({
      absolutePath: join(pluginRoot, 'resources', 'review.md'),
      relativePath: 'resources/review.md',
    });
  });

  it('rejects plugin resource paths that escape the plugin root', () => {
    const resolved = resolvePluginResourcePath({
      pluginRootPath: pluginRoot,
      resourcePath: '../secrets.txt',
    });

    expect(resolved).toBeNull();
  });

  it('rejects symlinked plugin resource targets that escape the plugin root after realpath containment', async () => {
    await symlink(join(fixtureRoot, 'outside.md'), join(pluginRoot, 'resources', 'escape.md'));

    await expect(resolveContainedPluginResourcePath({
      pluginRootPath: pluginRoot,
      resourcePath: './resources/escape.md',
    })).resolves.toBeNull();

    await expect(resolveContainedPluginResourcePath({
      pluginRootPath: pluginRoot,
      resourcePath: './resources/review.md',
    })).resolves.toEqual({
      absolutePath: await realpath(join(pluginRoot, 'resources', 'review.md')),
      relativePath: 'resources/review.md',
    });
  });
});
