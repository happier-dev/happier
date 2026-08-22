import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePluginAuthorTypeScriptConfigBoundary } from './typescriptConfigBoundary';

describe('plugin author TypeScript config boundary', () => {
  it('allows a missing config and an inherited contained wildcard mapping', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-config-contained-'));
    const packageRoot = join(parentRoot, 'plugin');
    const entryPath = join(packageRoot, 'index.ts');
    await mkdir(join(packageRoot, 'config'), { recursive: true });
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(entryPath, 'export {};\n', 'utf8');

    try {
      await expect(resolvePluginAuthorTypeScriptConfigBoundary({ packageRootPath: packageRoot, entryPath }))
        .resolves.toEqual({
          tsconfigPath: null, aliases: {}, bundlerTsconfigRaw: {}, emitOutputRelativePath: null,
        });
      await writeFile(join(packageRoot, 'config', 'base.json'), JSON.stringify({
        compilerOptions: {
          baseUrl: '..',
          paths: { 'local/*': ['src/*'] },
        },
      }), 'utf8');
      await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        extends: './config/base.json',
      }), 'utf8');
      await expect(resolvePluginAuthorTypeScriptConfigBoundary({ packageRootPath: packageRoot, entryPath }))
        .resolves.toEqual({
          tsconfigPath: await realpath(join(packageRoot, 'tsconfig.json')),
          aliases: { 'local/': `${join(await realpath(packageRoot), 'src')}${sep}` },
          bundlerTsconfigRaw: {
            compilerOptions: {
              paths: { 'local/*': [join(await realpath(packageRoot), 'src', '*')] },
            },
          },
          // No `outDir`: the compiler writes beside each source file, which is
          // never a declared daemon entry, so there is nothing to guard.
          emitOutputRelativePath: null,
        });
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['a declared outDir', { outDir: 'dist' }, 'dist'],
    ['a nested outDir', { outDir: 'build/out' }, 'build/out'],
    ['an outDir the config cannot emit into', { outDir: 'dist', noEmit: true }, null],
    ['a declarations-only emit', { outDir: 'dist', emitDeclarationOnly: true }, null],
    ['no declared outDir', {}, null],
  ] as const)('reports %s as the emit directory a daemon entry must avoid', async (
    _label,
    compilerOptions,
    expected,
  ) => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-config-emit-'));
    const entryPath = join(packageRoot, 'src', 'index.ts');
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(entryPath, 'export {};\n', 'utf8');
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { rootDir: 'src', ...compilerOptions },
      include: ['src/**/*.ts'],
    }), 'utf8');

    try {
      const boundary = await resolvePluginAuthorTypeScriptConfigBoundary({
        packageRootPath: packageRoot,
        entryPath,
      });
      expect(boundary.emitOutputRelativePath).toBe(expected);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('reports no emit directory for an outDir outside the package root', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-config-emit-outside-'));
    const packageRoot = join(parentRoot, 'plugin');
    const entryPath = join(packageRoot, 'src', 'index.ts');
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(entryPath, 'export {};\n', 'utf8');
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { rootDir: 'src', outDir: '../outside' },
      include: ['src/**/*.ts'],
    }), 'utf8');

    try {
      const boundary = await resolvePluginAuthorTypeScriptConfigBoundary({
        packageRootPath: packageRoot,
        entryPath,
      });
      expect(boundary.emitOutputRelativePath).toBeNull();
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects an inherited absolute wildcard target outside the package root', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-config-extends-'));
    const packageRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    const entryPath = join(packageRoot, 'index.ts');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(entryPath, 'export {};\n', 'utf8');
    await writeFile(join(packageRoot, 'base.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'escape/*': [`${outsideRoot.replaceAll('\\', '/')}/*`] },
      },
    }), 'utf8');
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({ extends: './base.json' }), 'utf8');

    try {
      await expect(resolvePluginAuthorTypeScriptConfigBoundary({ packageRootPath: packageRoot, entryPath }))
        .rejects.toThrow(/paths.*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects a contained mapping whose physical target traverses an outside symlink', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-config-symlink-'));
    const packageRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    const entryPath = join(packageRoot, 'index.ts');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(entryPath, 'export {};\n', 'utf8');
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'escape/*': ['linked/*'] },
      },
    }), 'utf8');

    try {
      try {
        await symlink(
          outsideRoot,
          join(packageRoot, 'linked'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }
      await expect(resolvePluginAuthorTypeScriptConfigBoundary({ packageRootPath: packageRoot, entryPath }))
        .rejects.toThrow(/paths.*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects an extends chain that resolves outside the package root directly or through a symlink', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-config-extends-boundary-'));
    const packageRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    const entryPath = join(packageRoot, 'index.ts');
    const outsideConfigPath = join(outsideRoot, 'base.json');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(entryPath, 'export {};\n', 'utf8');
    await writeFile(outsideConfigPath, JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');

    try {
      await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        extends: '../outside/base.json',
      }), 'utf8');
      await expect(resolvePluginAuthorTypeScriptConfigBoundary({ packageRootPath: packageRoot, entryPath }))
        .rejects.toThrow(/extends.*outside.*package root/u);

      try {
        await symlink(outsideConfigPath, join(packageRoot, 'linked-base.json'), 'file');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('file symlinks are unavailable on this host');
          return;
        }
        throw error;
      }
      await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        extends: './linked-base.json',
      }), 'utf8');
      await expect(resolvePluginAuthorTypeScriptConfigBoundary({ packageRootPath: packageRoot, entryPath }))
        .rejects.toThrow(/extends.*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed effective config JSON', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-config-malformed-'));
    const packageRoot = join(parentRoot, 'plugin');
    const entryPath = join(packageRoot, 'index.ts');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(entryPath, 'export {};\n', 'utf8');
    await writeFile(join(packageRoot, 'tsconfig.json'), '{ "compilerOptions": {', 'utf8');

    try {
      await expect(resolvePluginAuthorTypeScriptConfigBoundary({ packageRootPath: packageRoot, entryPath }))
        .rejects.toThrow(/TypeScript config is invalid/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });
});
