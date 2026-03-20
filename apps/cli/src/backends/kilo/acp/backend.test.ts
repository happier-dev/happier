import { afterEach, describe, expect, it } from 'vitest';

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createKiloBackend } from './backend';

type AcpBackendLike = {
  options: {
    command: string;
  };
};

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeUnixExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, params.name);
  writeFileSync(filePath, params.content, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

function makeWindowsCmdExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, `${params.name}.cmd`);
  writeFileSync(filePath, params.content, 'utf8');
  return filePath;
}

describe('createKiloBackend command resolution', () => {
  const originalKiloPath = process.env.HAPPIER_KILO_PATH;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalPath = process.env.PATH;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalKiloPath === undefined) delete process.env.HAPPIER_KILO_PATH;
    else process.env.HAPPIER_KILO_PATH = originalKiloPath;
    if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHomeDir;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'unset override', override: undefined },
    { label: 'whitespace override', override: '   ' },
    { label: 'non-existent override', override: '/tmp/definitely-missing-kilo-binary' },
  ])('fails closed for $label when no Kilo CLI is resolvable', ({ override }) => {
    const homeDir = makeTempDir('happier-kilo-home-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.PATH = '';
    if (override === undefined) delete process.env.HAPPIER_KILO_PATH;
    else process.env.HAPPIER_KILO_PATH = override;

    expect(() => createKiloBackend({ cwd: '/tmp', env: {} })).toThrow(
      /Kilo CLI \(kilo\) is not available from any configured source/,
    );
  });

  it('uses HAPPIER_KILO_PATH when it points to an existing executable', () => {
    const workDir = makeTempDir('happier-kilo-backend-');
    tempDirs.push(workDir);
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const kiloPath = process.platform === 'win32'
      ? makeWindowsCmdExecutable({
          dir: binDir,
          name: 'kilo',
          content: ['@echo off', 'echo ok', ''].join('\r\n'),
        })
      : makeUnixExecutable({
          dir: binDir,
          name: 'kilo',
          content: ['#!/bin/sh', 'echo "ok"', ''].join('\n'),
        });

    process.env.HAPPIER_KILO_PATH = kiloPath;

    const backend = createKiloBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(kiloPath);
  });
});
