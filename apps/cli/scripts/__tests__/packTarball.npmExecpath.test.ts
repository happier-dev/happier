import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { packTarball } from '../packTarball.mjs';

const noopBundleWorkspaceDeps = async () => undefined;

function createPackageDistFsAdapter(baseExists: (targetPath: unknown) => boolean) {
  const syntheticPaths = new Set<string>();
  const key = (targetPath: unknown) => String(targetPath);

  return {
    existsSync(targetPath: unknown) {
      return syntheticPaths.has(key(targetPath)) || baseExists(targetPath);
    },
    cpSync(_sourcePath: unknown, targetPath: unknown) {
      syntheticPaths.add(key(targetPath));
    },
    mkdirSync() {
      return undefined;
    },
    renameSync(sourcePath: unknown, targetPath: unknown) {
      syntheticPaths.delete(key(sourcePath));
      syntheticPaths.add(key(targetPath));
    },
    rmSync(targetPath: unknown) {
      syntheticPaths.delete(key(targetPath));
    },
    bundleWorkspaceDeps: noopBundleWorkspaceDeps,
  };
}

describe('packTarball (npmExecpath)', () => {
  it('ignores non-npm npm_execpath values (e.g. yarn) and uses npm on PATH', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses node + npm-cli.js when npm_execpath points at npm-cli.js', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    const npmCliPath = '/somewhere/node_modules/npm/bin/npm-cli.js';
    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: npmCliPath,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [npmCliPath, 'pack', '--json', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses node + npm-cli.js on Windows when npm_execpath points to a non-npm runner', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));
    const nodeExecPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCliPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'win32',
      processExecPath: nodeExecPath,
      spawnSync: spawn,
      ...createPackageDistFsAdapter((targetPath) => {
        const normalized = String(targetPath).replaceAll('\\', '/').toLowerCase();
        const normalizedNpmCli = npmCliPath.replaceAll('\\', '/').toLowerCase();
        return normalized === normalizedNpmCli || normalized.endsWith(`/${tarballName}`) || normalized.endsWith('/dist');
      }),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [npmCliPath, 'pack', '--json', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('falls back to npm.cmd on Windows when npm-cli.js cannot be resolved from node.exe', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'win32',
      processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      spawnSync: spawn,
      ...createPackageDistFsAdapter((targetPath) => {
        const normalized = String(targetPath).replaceAll('\\', '/').toLowerCase();
        return normalized.endsWith(`/${tarballName}`) || normalized.endsWith('/dist');
      }),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'npm.cmd',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses node + npm-cli.js on Windows when npm_execpath is missing', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));
    const nodeExecPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCliPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '',
      platform: 'win32',
      processExecPath: nodeExecPath,
      spawnSync: spawn,
      ...createPackageDistFsAdapter((targetPath) => {
        const normalized = String(targetPath).replaceAll('\\', '/').toLowerCase();
        const normalizedNpmCli = npmCliPath.replaceAll('\\', '/').toLowerCase();
        return normalized === normalizedNpmCli || normalized.endsWith(`/${tarballName}`) || normalized.endsWith('/dist');
      }),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [npmCliPath, 'pack', '--json', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('parses npm pack --json output even when prepack logs are mixed into stdout', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({
      status: 0,
      stdout: [
        '> @happier-dev/cli@0.1.0 prepack',
        '> yarn -s build && node scripts/bundleWorkspaceDeps.mjs',
        'Generated an empty chunk: "index".',
        '[',
        `  { "filename": "${tarballName}" }`,
        ']',
        '',
      ].join('\n'),
      stderr: '',
    }));

    const result = await packTarball({
      packageRoot,
      destDir,
      npmInvocation: { command: 'npm', args: [] },
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {},
    });

    expect(result.tarballName).toBe(tarballName);
    expect(result.tarballPath).toContain(join(destDir, tarballName));
  });

  it('applies a bounded timeout to npm pack invocations to prevent indefinite hangs', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    await packTarball({
      packageRoot,
      destDir,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {
        HAPPIER_CLI_PACK_TARBALL_TIMEOUT_MS: '123456',
      },
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        timeout: 123_456,
      }),
    );
  });

  it('runs the canonical bundled workspace dependency closure before npm pack', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const events: string[] = [];
    const spawn = vi.fn(() => {
      events.push('pack');
      return { status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' };
    });
    const bundleWorkspaceDeps = vi.fn(async () => {
      events.push('bundle');
    });

    await packTarball({
      packageRoot,
      destDir,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      bundleWorkspaceDeps,
      env: {},
    });

    expect(bundleWorkspaceDeps).toHaveBeenCalledWith({ packageRoot });
    expect(events).toEqual(['bundle', 'pack']);
  });

  it('does not mask incomplete package-dist filesystem adapters', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    await expect(
      packTarball({
        packageRoot,
        destDir,
        spawnSync: spawn,
        existsSync(targetPath) {
          return String(targetPath).endsWith('/dist') || String(targetPath).endsWith(`/${tarballName}`);
        },
        cpSync() {
          return undefined;
        },
        env: {},
      }),
    ).rejects.toThrow(/incomplete filesystem adapter/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
