import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureCliDistSnapshotNodeModules, ensureCliPackSnapshotRuntimeDependencies } from './cliDistSnapshotNodeModules';

const createdDirs: string[] = [];

function createRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-'));
  createdDirs.push(root);
  mkdirSync(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'esm'), {
    recursive: true,
  });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'package.json'), '{"name":"@happier-dev/protocol"}', 'utf8');
  writeFileSync(
    join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js'),
    'export const live = "initial";\n',
    'utf8',
  );
  return root;
}

describe('ensureCliDistSnapshotNodeModules', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies the bundled @happier-dev scope into the snapshot instead of aliasing the live tree', () => {
    const rootDir = createRepoRoot();
    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotFile = join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js');
    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js'),
      'export const live = "mutated";\n',
      'utf8',
    );

    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');
  });

  it('copies direct CLI dependencies into the snapshot so built dist can resolve them', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-direct-deps-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'package.json'), '{"name":"zod"}', 'utf8');
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const live = "initial";\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-direct-deps-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotFile = join(snapshotDir, 'node_modules', 'zod', 'index.js');
    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');

    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const live = "mutated";\n', 'utf8');

    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');
  });

  it('vendors runtime dependencies for copied external packages so nested imports resolve', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-external-runtime-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@sentry', 'node'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', '@sentry', 'node-core'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@sentry', 'node', 'package.json'),
      JSON.stringify({
        name: '@sentry/node',
        version: '10.39.0',
        dependencies: {
          '@sentry/node-core': '10.39.0',
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@sentry', 'node', 'index.js'),
      'export const live = "sentry-node";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', '@sentry', 'node-core', 'package.json'),
      JSON.stringify({
        name: '@sentry/node-core',
        version: '10.39.0',
        main: 'index.js',
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', '@sentry', 'node-core', 'index.js'),
      'export const live = "sentry-node-core";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-external-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotCoreFile = join(
      snapshotDir,
      'node_modules',
      '@sentry',
      'node',
      'node_modules',
      '@sentry',
      'node-core',
      'index.js',
    );
    expect(readFileSync(snapshotCoreFile, 'utf8')).toContain('sentry-node-core');
  });

  it('copies deep bundled runtime dependencies into the snapshot so nested protocol imports resolve', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-deep-runtime-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        dependencies: {
          tweetnacl: '^1.0.3',
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'package.json'),
      JSON.stringify({
        name: 'tweetnacl',
        version: '1.0.3',
        main: 'nacl-fast.js',
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'nacl-fast.js'),
      'export const live = "initial";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-deep-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotFile = join(
      snapshotDir,
      'node_modules',
      '@happier-dev',
      'protocol',
      'node_modules',
      'tweetnacl',
      'nacl-fast.js',
    );
    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');
  });

  it('materializes symlinked bundled runtime dependencies into the snapshot', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-symlinked-runtime-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: '4.3.6',
        main: 'index.js',
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'zod', 'index.js'), 'export const live = "source";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify({ name: '@happier-dev/agents' }, null, 2),
      'utf8',
    );
    symlinkSync(
      resolve(rootDir, 'node_modules', 'zod'),
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod'),
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-symlinked-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotZodDir = join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod');
    expect(lstatSync(snapshotZodDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(snapshotZodDir, 'package.json'), 'utf8')).toContain('"name": "zod"');
    expect(readFileSync(join(snapshotZodDir, 'index.js'), 'utf8')).toContain('source');
  });

  it('backfills missing bundled workspace runtime dependencies from the source root node_modules tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-runtime-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4-mini'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'packages', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'packages', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: { '.': { default: './dist/index.js' } },
        dependencies: { zod: '4.3.6' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'agents', 'dist', 'index.js'),
      'export const agent = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: '4.3.6',
        main: 'index.js',
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'zod', 'index.js'), 'export const live = "source-root";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: { '.': { default: './dist/index.js' } },
        dependencies: { zod: '4.3.6' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      'export const agent = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4', 'index.js'),
      'export const partial = "nested";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4-mini', 'index.js'),
      'export const partialMini = "nested";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotZodDir = join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod');
    expect(existsSync(snapshotZodDir)).toBe(true);
    expect(lstatSync(snapshotZodDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(snapshotZodDir, 'package.json'), 'utf8')).toContain('"name": "zod"');
    expect(readFileSync(join(snapshotZodDir, 'index.js'), 'utf8')).toContain('source-root');
  });

  it('repairs incomplete CLI-local runtime deps by merging in missing files from root node_modules', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-merge-runtime-'));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'v4'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'zod', 'v4', 'locales'), { recursive: true });
    mkdirSync(join(rootDir, 'packages', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'packages', 'agents', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(join(rootDir, 'packages', 'agents', 'dist', 'index.js'), 'export const agent = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      'export const agent = true;\n',
      'utf8',
    );

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const cliRoot = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'v4', 'index.js'),
      'export const cliRootV4 = true;\n',
      'utf8',
    );

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4', 'index.js'),
      'export const bundledPartial = true;\n',
      'utf8',
    );

    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'zod', 'index.js'), 'export const rootFull = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'v4', 'index.js'),
      'export const rootV4 = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'v4', 'locales', 'ru.js'),
      'export default "ru";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-merge-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    expect(
      readFileSync(
        join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4', 'locales', 'ru.js'),
        'utf8',
      ),
    ).toContain('ru');
  });

  it('repairs missing bundled workspace runtime deps from the root node_modules tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-runtime-fallback-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol'), { recursive: true });
    mkdirSync(join(rootDir, 'packages', 'protocol', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'protocol', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'protocol', 'dist', 'index.js'),
      'export const protocol = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify(
        {
          name: 'zod',
          version: '4.3.6',
          main: 'index.js',
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'zod', 'index.js'), 'export const live = "root-zod";\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-runtime-fallback-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    expect(
      readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'zod', 'index.js'), 'utf8'),
    ).toContain('root-zod');
  });

  it('ignores transient dist.__sync_tmp__ directories when copying bundled workspace scopes', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-transient-sync-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist.__sync_tmp__.58760.2'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json'),
      '{"name":"@happier-dev/cli-common"}',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'),
      'export const stable = "stable";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist.__sync_tmp__.58760.2', 'index.js'),
      'export const transient = "transient";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-transient-sync-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    expect(readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'), 'utf8')).toContain(
      'stable',
    );
    expect(existsSync(join(snapshotDir, 'node_modules', '@happier-dev', 'cli-common', 'dist.__sync_tmp__.58760.2'))).toBe(false);
  });

  it('repairs incomplete bundled workspace copies by filling in missing dist files', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-bundled-repair-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
      '{"name":"@happier-dev/release-runtime"}',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'),
      'export const live = "initial";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-bundled-repair-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });
    mkdirSync(join(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
      '{"name":"@happier-dev/release-runtime"}',
      'utf8',
    );

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotFile = join(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js');
    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');
  });

  it('repairs missing workspace package manifests in the copied @happier-dev scope', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-manifest-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'connection-supervisor', 'dist'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'packages', 'connection-supervisor', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'connection-supervisor', 'dist', 'index.js'),
      'export const live = "initial";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'connection-supervisor', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/connection-supervisor',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'packages', 'connection-supervisor', 'dist', 'index.js'), 'export const workspace = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-manifest-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotPackageJson = join(snapshotDir, 'node_modules', '@happier-dev', 'connection-supervisor', 'package.json');
    expect(readFileSync(snapshotPackageJson, 'utf8')).toContain('@happier-dev/connection-supervisor');
  });

  it('overwrites stale bundled workspace manifests with canonical package manifests', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-stale-manifest-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'packages', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        version: '0.0.0',
        type: 'module',
        main: './index.js',
        exports: { '.': { default: './index.js' } },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      'export const bundled = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'packages', 'agents', 'dist', 'index.js'), 'export const workspace = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-stale-manifest-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotPackageJson = JSON.parse(
      readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'package.json'), 'utf8'),
    ) as { main?: unknown; exports?: { '.': { default?: unknown } } };
    expect(snapshotPackageJson.main).toBe('./dist/index.js');
    expect(snapshotPackageJson.exports?.['.']?.default).toBe('./dist/index.js');
  });

  it('overwrites stale bundled plugin workspace manifests with canonical package manifests', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-plugin-manifest-'));
    createdDirs.push(rootDir);
    mkdirSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'plugins-codex', 'dist', 'agent', 'runtime', 'appServer'),
      { recursive: true },
    );
    mkdirSync(join(rootDir, 'packages', 'plugins', 'codex', 'dist', 'agent', 'runtime', 'appServer'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'packages', 'plugins', 'codex', 'dist', 'agent', 'runtime', 'appServer', 'catalog'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'plugins-codex', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-codex',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: { '.': { default: './dist/index.js' } },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'plugins-codex', 'dist', 'index.js'),
      'export const bundled = true;\n',
      'utf8',
    );
    writeFileSync(
      join(
        rootDir,
        'apps',
        'cli',
        'node_modules',
        '@happier-dev',
        'plugins-codex',
        'dist',
        'agent',
        'runtime',
        'appServer',
        'turnInput.js',
      ),
      'export const bundledTurnInput = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'plugins', 'codex', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-codex',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: {
          '.': { default: './dist/index.js' },
          './agent/runtime/appServer/catalog': {
            default: './dist/agent/runtime/appServer/catalog/index.js',
          },
          './agent/runtime/appServer/turnInput': {
            default: './dist/agent/runtime/appServer/turnInput.js',
          },
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'packages', 'plugins', 'codex', 'dist', 'index.js'), 'export const workspace = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'packages', 'plugins', 'codex', 'dist', 'agent', 'runtime', 'appServer', 'turnInput.js'),
      'export const workspaceTurnInput = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'plugins', 'codex', 'dist', 'agent', 'runtime', 'appServer', 'catalog', 'index.js'),
      'export const workspaceCatalog = true;\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-plugin-manifest-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotPackageJson = JSON.parse(
      readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'plugins-codex', 'package.json'), 'utf8'),
    ) as {
      exports?: {
        './agent/runtime/appServer/catalog'?: { default?: unknown };
        './agent/runtime/appServer/turnInput'?: { default?: unknown };
      };
    };
    expect(snapshotPackageJson.exports?.['./agent/runtime/appServer/catalog']?.default).toBe(
      './dist/agent/runtime/appServer/catalog/index.js',
    );
    expect(snapshotPackageJson.exports?.['./agent/runtime/appServer/turnInput']?.default).toBe(
      './dist/agent/runtime/appServer/turnInput.js',
    );
  });

  it('repairs missing workspace dist files from the source package tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-dist-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'packages', 'release-runtime', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/release-runtime',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: {
          './github': './dist/github.js',
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'release-runtime', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/release-runtime',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: {
          './github': './dist/github.js',
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'release-runtime', 'dist', 'github.js'),
      'export const live = "workspace-dist";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-dist-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    const snapshotFile = join(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js');
    expect(readFileSync(snapshotFile, 'utf8')).toContain('workspace-dist');
  });

  it('hydrates packed cli snapshots with missing top-level and bundled runtime dependencies without replacing the packed payload', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-runtime-'));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const z = "source";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'package.json'),
      JSON.stringify({ name: 'tweetnacl', version: '1.0.3', main: 'nacl-fast.js' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'nacl-fast.js'),
      'export const nacl = "source";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-runtime-out-'));
    createdDirs.push(snapshotDir);
    mkdirSync(join(snapshotDir, 'dist'), { recursive: true });
    mkdirSync(join(snapshotDir, 'node_modules', '@happier-dev', 'protocol'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.0.0-test',
        dependencies: { zod: '4.3.6' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(snapshotDir, 'dist', 'index.mjs'), 'export const cli = true;\n', 'utf8');
    writeFileSync(
      join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0-test',
        dependencies: { tweetnacl: '^1.0.3' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'dist-marker.txt'),
      'packed-payload',
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir });

    expect(readFileSync(join(snapshotDir, 'node_modules', 'zod', 'index.js'), 'utf8')).toContain('source');
    expect(
      readFileSync(
        join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'nacl-fast.js'),
        'utf8',
      ),
    ).toContain('source');
    expect(readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'dist-marker.txt'), 'utf8')).toBe(
      'packed-payload',
    );
  });

  it('supports fast packed-snapshot hydration mode that skips recursive merges for already-present dependency trees', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'v4'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const z = "source";\n', 'utf8');
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'v4', 'core.js'), 'export const core = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-out-'));
    createdDirs.push(snapshotDir);
    mkdirSync(join(snapshotDir, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.0.0-test',
        dependencies: { zod: '4.3.6' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(snapshotDir, 'node_modules', 'zod', 'index.js'), 'export const packed = true;\n', 'utf8');

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(readFileSync(join(snapshotDir, 'node_modules', 'zod', 'index.js'), 'utf8')).toContain('packed');
    expect(existsSync(join(snapshotDir, 'node_modules', 'zod', 'v4', 'core.js'))).toBe(false);
  });

  it('avoids copying nested node_modules trees wholesale in fast packed-snapshot mode', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-prune-node-modules-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-a', 'node_modules', 'dep-b'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-a', 'package.json'),
      JSON.stringify({ name: 'dep-a', version: '1.0.0', dependencies: { 'dep-b': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-a', 'index.js'), 'module.exports = "dep-a";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'index.js'),
      'module.exports = "nested-copy";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'package.json'),
      JSON.stringify({ name: 'dep-b', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'index.js'), 'module.exports = "dep-b";\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-prune-node-modules-out-'));
    createdDirs.push(snapshotDir);
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0-test', dependencies: { 'dep-a': '1.0.0' } }, null, 2),
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(readFileSync(join(snapshotDir, 'node_modules', 'dep-a', 'index.js'), 'utf8')).toContain('dep-a');
    expect(readFileSync(join(snapshotDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'index.js'), 'utf8')).toContain(
      'dep-b',
    );
  });

  it('keeps transitive dependency hydration enabled in fast packed-snapshot mode, including peer dependencies', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-transitive-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'package.json'),
      JSON.stringify({ name: 'dep-b', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'index.js'), 'module.exports = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-transitive-out-'));
    createdDirs.push(snapshotDir);
    mkdirSync(join(snapshotDir, 'node_modules', 'dep-a'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0-test', dependencies: { 'dep-a': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', 'dep-a', 'package.json'),
      JSON.stringify({ name: 'dep-a', version: '1.0.0', peerDependencies: { 'dep-b': '1.0.0' } }, null, 2),
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'index.js'))).toBe(true);
  });

  it('skips optional dependency hydration in fast packed-snapshot mode to avoid expensive cross-platform optional trees', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-optional-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-required'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-optional'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-required', 'package.json'),
      JSON.stringify({ name: 'dep-required', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-required', 'index.js'),
      'module.exports = "required";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-optional', 'package.json'),
      JSON.stringify({ name: 'dep-optional', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-optional', 'index.js'),
      'module.exports = "optional";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-optional-out-'));
    createdDirs.push(snapshotDir);
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.0.0-test',
        dependencies: { 'dep-required': '1.0.0' },
        optionalDependencies: { 'dep-optional': '1.0.0' },
      }, null, 2),
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-required', 'index.js'))).toBe(true);
    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-optional', 'index.js'))).toBe(false);
  });

  it('limits fast packed-snapshot hydration to declared runtime graphs and skips unrelated tree-wide scans', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-scope-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-d'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'package.json'),
      JSON.stringify({ name: 'dep-b', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'index.js'), 'module.exports = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-d', 'package.json'),
      JSON.stringify({ name: 'dep-d', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-d', 'index.js'), 'module.exports = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-scope-out-'));
    createdDirs.push(snapshotDir);
    mkdirSync(join(snapshotDir, 'node_modules', 'dep-a'), { recursive: true });
    mkdirSync(join(snapshotDir, 'node_modules', 'dep-c'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0-test', dependencies: { 'dep-a': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', 'dep-a', 'package.json'),
      JSON.stringify({ name: 'dep-a', version: '1.0.0', peerDependencies: { 'dep-b': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', 'dep-c', 'package.json'),
      JSON.stringify({ name: 'dep-c', version: '1.0.0', dependencies: { 'dep-d': '1.0.0' } }, null, 2),
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'index.js'))).toBe(true);
    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-c', 'node_modules', 'dep-d', 'index.js'))).toBe(false);
  });

  it('terminates cyclic peer-dependency vendoring instead of materializing unbounded nested copies (browserslist/update-browserslist-db shape)', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-cycle-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'browserslist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'update-browserslist-db'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'browserslist', 'package.json'),
      JSON.stringify({
        name: 'browserslist',
        version: '4.28.1',
        dependencies: { 'update-browserslist-db': '^1.1.0' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'browserslist', 'index.js'), 'module.exports = "browserslist";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'node_modules', 'update-browserslist-db', 'package.json'),
      JSON.stringify({
        name: 'update-browserslist-db',
        version: '1.1.0',
        peerDependencies: { browserslist: '>= 4.21.0' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'update-browserslist-db', 'index.js'), 'module.exports = "update-browserslist-db";\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-cycle-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    // The runtime dependency is vendored once under its consumer…
    expect(
      existsSync(join(snapshotDir, 'node_modules', 'browserslist', 'node_modules', 'update-browserslist-db', 'index.js')),
    ).toBe(true);
    // …but the peer-dependency cycle must terminate there: node resolution finds the ancestor
    // browserslist two levels up, so the nested copy must never vendor its peer again. Without a
    // traversal-path guard this materializes browserslist/update-browserslist-db copies until the
    // filesystem path-length limit (observed live as ENAMETOOLONG in the daemon cli-dist copy).
    expect(
      existsSync(join(
        snapshotDir,
        'node_modules', 'browserslist',
        'node_modules', 'update-browserslist-db',
        'node_modules', 'browserslist',
      )),
    ).toBe(false);
  });

  it('never vendors dependencies through symlinked snapshot entries into the live source tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-symlink-entry-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'linked-pkg'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'linked-dep'), { recursive: true });
    writeFileSync(
      join(rootDir, 'node_modules', 'linked-pkg', 'package.json'),
      JSON.stringify({ name: 'linked-pkg', version: '1.0.0', dependencies: { 'linked-dep': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'linked-pkg', 'index.js'), 'module.exports = "linked-pkg";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'node_modules', 'linked-dep', 'package.json'),
      JSON.stringify({ name: 'linked-dep', version: '1.0.0' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'linked-dep', 'index.js'), 'module.exports = "linked-dep";\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-symlink-entry-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });
    // Simulate a snapshot whose node_modules was populated as a SYMLINK OVERLAY into the live
    // tree (source-entrypoint mode) and is later re-processed by the dist hydrator: vendoring
    // a dependency "into the snapshot" through such an entry would write into the LIVE tree
    // (observed live 2026-06-12: the daemon launch-spec phase vendored nested dependency copies
    // into the workspace's real node_modules through overlay symlinks).
    mkdirSync(join(snapshotDir, 'node_modules'), { recursive: true });
    symlinkSync(join(rootDir, 'node_modules', 'linked-pkg'), join(snapshotDir, 'node_modules', 'linked-pkg'));

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    // The live package directory must stay pristine — no nested node_modules materialized
    // through the symlinked snapshot entry.
    expect(existsSync(join(rootDir, 'node_modules', 'linked-pkg', 'node_modules'))).toBe(false);
  });

  it('never vendors dependencies through a symlinked SCOPE directory into the live source tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-symlink-scope-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', '@linked-scope', 'scoped-pkg'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'scoped-dep'), { recursive: true });
    writeFileSync(
      join(rootDir, 'node_modules', '@linked-scope', 'scoped-pkg', 'package.json'),
      JSON.stringify({ name: '@linked-scope/scoped-pkg', version: '1.0.0', dependencies: { 'scoped-dep': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', '@linked-scope', 'scoped-pkg', 'index.js'), 'module.exports = "scoped-pkg";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'node_modules', 'scoped-dep', 'package.json'),
      JSON.stringify({ name: 'scoped-dep', version: '1.0.0' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'scoped-dep', 'index.js'), 'module.exports = "scoped-dep";\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-symlink-scope-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });
    // The per-entry symlink guard lstats only the FINAL path component. When the SCOPE
    // directory itself is the overlay symlink, the textual path snapshot/node_modules/@scope/pkg
    // resolves THROUGH the symlink to a real directory, passes that guard, and the hydrator
    // vendors dependencies into the LIVE tree (observed live 2026-06-12: real workspace
    // node_modules/@scope/pkg/node_modules gained vendored copies during the launch-spec phase
    // with the entry-level guard already in place).
    mkdirSync(join(snapshotDir, 'node_modules'), { recursive: true });
    symlinkSync(join(rootDir, 'node_modules', '@linked-scope'), join(snapshotDir, 'node_modules', '@linked-scope'));

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

    expect(existsSync(join(rootDir, 'node_modules', '@linked-scope', 'scoped-pkg', 'node_modules'))).toBe(false);
  });
});
