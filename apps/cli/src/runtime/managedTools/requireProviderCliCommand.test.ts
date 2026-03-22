import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { buildMissingProviderCliCommandErrorMessage, requireProviderCliCommand } from './requireProviderCliCommand';

describe('requireProviderCliCommand', () => {
  let envScope = createEnvKeyScope(['PATH', 'HAPPIER_GEMINI_PATH']);
  const tempDirs: string[] = [];

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['PATH', 'HAPPIER_GEMINI_PATH']);

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) removeTempDirSync(dir);
    }
  });

  it('throws a provider-specific error when the CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    expect(() => requireProviderCliCommand('gemini')).toThrow(
      buildMissingProviderCliCommandErrorMessage('gemini'),
    );
  });

  it('returns the resolved command path when the CLI is available', () => {
    const dir = createTempDirSync('happier-required-provider-cli-');
    tempDirs.push(dir);
    const binPath = writeExecutableShimSync({
      dir,
      fileName: process.platform === 'win32' ? 'gemini.cmd' : 'gemini',
      contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
    });
    process.env.PATH = dir;
    delete process.env.HAPPIER_GEMINI_PATH;

    expect(requireProviderCliCommand('gemini')).toBe(binPath);
  });

  it('reports an invalid explicit override instead of falling back', () => {
    process.env.PATH = '';
    const dir = createTempDirSync('happier-required-provider-cli-missing-');
    tempDirs.push(dir);
    process.env.HAPPIER_GEMINI_PATH = join(dir, 'missing-gemini');

    expect(() => requireProviderCliCommand('gemini')).toThrow(/does not point to a supported cli entrypoint/i);
  });
});
