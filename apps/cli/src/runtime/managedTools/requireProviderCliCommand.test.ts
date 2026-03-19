import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildMissingProviderCliCommandErrorMessage, requireProviderCliCommand } from './requireProviderCliCommand';

describe('requireProviderCliCommand', () => {
  const originalPath = process.env.PATH;
  const originalGeminiPath = process.env.HAPPIER_GEMINI_PATH;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGeminiPath === undefined) delete process.env.HAPPIER_GEMINI_PATH;
    else process.env.HAPPIER_GEMINI_PATH = originalGeminiPath;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
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
    const dir = mkdtempSync(join(tmpdir(), 'happier-required-provider-cli-'));
    tempDirs.push(dir);
    const binPath = join(dir, process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
    writeFileSync(binPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(binPath, 0o755);
    process.env.PATH = dir;
    delete process.env.HAPPIER_GEMINI_PATH;

    expect(requireProviderCliCommand('gemini')).toBe(binPath);
  });

  it('reports an invalid explicit override instead of falling back', () => {
    process.env.PATH = '';
    process.env.HAPPIER_GEMINI_PATH = join(tmpdir(), 'missing-gemini');

    expect(() => requireProviderCliCommand('gemini')).toThrow(/does not point to a supported cli entrypoint/i);
  });
});
