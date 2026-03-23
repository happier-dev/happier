import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureCliDistSnapshotNodeModules } from './cliDistSnapshotNodeModules';

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
});
