import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { packTarball } from '../packTarball.mjs';

describe('packTarball (npmExecpath)', () => {
  it('ignores non-npm npm_execpath values (e.g. yarn) and uses npm on PATH', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      spawnSync: spawn,
      existsSync: () => true,
      cpSync: () => undefined,
      rmSync: () => undefined,
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['pack', '--json', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses node + npm-cli.js when npm_execpath points at npm-cli.js', () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: '' }));

    const npmCliPath = '/somewhere/node_modules/npm/bin/npm-cli.js';
    packTarball({
      packageRoot,
      destDir,
      npmExecpath: npmCliPath,
      spawnSync: spawn,
      existsSync: () => true,
      cpSync: () => undefined,
      rmSync: () => undefined,
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

    const result = packTarball({
      packageRoot,
      destDir,
      npmInvocation: { command: 'npm', args: [] },
      spawnSync: spawn,
      existsSync: () => true,
      cpSync: () => undefined,
      rmSync: () => undefined,
      env: {},
    });

    expect(result.tarballName).toBe(tarballName);
    expect(result.tarballPath).toContain(join(destDir, tarballName));
  });
});
