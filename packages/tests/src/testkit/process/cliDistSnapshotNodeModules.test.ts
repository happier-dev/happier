import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
