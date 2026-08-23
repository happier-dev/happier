import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { packTarball } from '../packTarball.mjs';

function createPackageRoot(): string {
  const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  return packageRoot;
}

describe('packTarball (npmExecpath)', () => {
  it('ignores non-npm npm_execpath values (e.g. yarn) and uses npm on PATH', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createPackageRoot();
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      spawnSync: spawn,
      existsSync,
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['pack', '--json', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses node + npm-cli.js on Windows when npm_execpath points to a non-npm runner', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createPackageRoot();
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));
    const nodeExecPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCliPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

    packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'win32',
      processExecPath: nodeExecPath,
      spawnSync: spawn,
      existsSync: (targetPath) => {
        const normalized = String(targetPath).replaceAll('\\', '/').toLowerCase();
        const normalizedNpmCli = npmCliPath.replaceAll('\\', '/').toLowerCase();
        return existsSync(targetPath) || normalized === normalizedNpmCli;
      },
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [npmCliPath, 'pack', '--json', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('falls back to npm.cmd on Windows when npm-cli.js cannot be resolved from node.exe', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createPackageRoot();
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'win32',
      processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      spawnSync: spawn,
      existsSync,
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'npm.cmd',
      ['pack', '--json', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses node + npm-cli.js on Windows when npm_execpath is missing', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createPackageRoot();
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));
    const nodeExecPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCliPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

    packTarball({
      packageRoot,
      destDir,
      npmExecpath: '',
      platform: 'win32',
      processExecPath: nodeExecPath,
      spawnSync: spawn,
      existsSync: (targetPath) => {
        const normalized = String(targetPath).replaceAll('\\', '/').toLowerCase();
        const normalizedNpmCli = npmCliPath.replaceAll('\\', '/').toLowerCase();
        return existsSync(targetPath) || normalized === normalizedNpmCli;
      },
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [npmCliPath, 'pack', '--json', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses node + npm-cli.js when npm_execpath points at npm-cli.js', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createPackageRoot();
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    const npmCliPath = '/somewhere/node_modules/npm/bin/npm-cli.js';
    packTarball({
      packageRoot,
      destDir,
      npmExecpath: npmCliPath,
      spawnSync: spawn,
      existsSync,
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [npmCliPath, 'pack', '--json', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('parses npm pack --json output even when prepack logs are mixed into stdout', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createPackageRoot();
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

    const result = packTarball({
      packageRoot,
      destDir,
      npmInvocation: { command: 'npm', args: [] },
      spawnSync: spawn,
      existsSync,
      env: {},
    });

    expect(result.tarballName).toBe(tarballName);
    expect(result.tarballPath).toContain(join(destDir, tarballName));
  });

  it('applies a bounded timeout to npm pack invocations to prevent indefinite hangs', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createPackageRoot();
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    packTarball({
      packageRoot,
      destDir,
      spawnSync: spawn,
      existsSync,
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

  it('does not mask incomplete package-dist filesystem adapters', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createPackageRoot();
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    expect(() =>
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
    ).toThrow(/incomplete filesystem adapter/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
