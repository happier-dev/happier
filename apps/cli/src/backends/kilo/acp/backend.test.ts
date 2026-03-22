import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createKiloBackend } from './backend';

type AcpBackendLike = {
  options: {
    command: string;
  };
};

describe('createKiloBackend command resolution', () => {
  const envKeys = ['HAPPIER_KILO_PATH', 'HAPPIER_HOME_DIR', 'PATH'] as const;
  let envScope = createEnvKeyScope(envKeys);
  const tempDirs: string[] = [];

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) removeTempDirSync(dir);
    }
  });

  it.each([
    { label: 'unset override', override: undefined },
    { label: 'whitespace override', override: '   ' },
    { label: 'non-existent override', override: '/tmp/definitely-missing-kilo-binary' },
  ])('fails closed for $label when no Kilo CLI is resolvable', ({ override }) => {
    const homeDir = createTempDirSync('happier-kilo-home-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.PATH = '';
    if (override === undefined) delete process.env.HAPPIER_KILO_PATH;
    else process.env.HAPPIER_KILO_PATH = override;

    expect(() => createKiloBackend({ cwd: '/tmp', env: {} })).toThrow(
      /Kilo CLI \(kilo\) .*available/i,
    );
  });

  it('uses HAPPIER_KILO_PATH when it points to an existing executable', () => {
    const workDir = createTempDirSync('happier-kilo-backend-');
    tempDirs.push(workDir);
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const isWindows = process.platform === 'win32';
    const kiloPath = writeExecutableShimSync({
      dir: binDir,
      fileName: isWindows ? 'kilo.cmd' : 'kilo',
      contents: isWindows ? ['@echo off', 'echo ok', ''].join('\r\n') : ['#!/bin/sh', 'echo "ok"', ''].join('\n'),
    });

    process.env.HAPPIER_KILO_PATH = kiloPath;

    const backend = createKiloBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(kiloPath);
  });
});
