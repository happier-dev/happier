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
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalKiloPath === undefined) delete process.env.HAPPIER_KILO_PATH;
    else process.env.HAPPIER_KILO_PATH = originalKiloPath;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'unset override', override: undefined, expected: 'kilo' },
    { label: 'whitespace override', override: '   ', expected: 'kilo' },
    { label: 'non-existent override', override: '/tmp/definitely-missing-kilo-binary', expected: 'kilo' },
  ])('falls back to kilo for $label', ({ override, expected }) => {
    if (override === undefined) delete process.env.HAPPIER_KILO_PATH;
    else process.env.HAPPIER_KILO_PATH = override;

    const backend = createKiloBackend({ cwd: '/tmp', env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(expected);
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
