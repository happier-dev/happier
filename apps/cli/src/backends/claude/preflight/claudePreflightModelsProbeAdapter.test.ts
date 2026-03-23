import { afterEach, describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import { claudePreflightModelsProbeAdapter } from './claudePreflightModelsProbeAdapter';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const envKeys = ['HAPPIER_CLAUDE_PATH', 'PATH'] as const;
let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

function writeFakeClaudeBinary(dir: string, helpText: string): string {
  const isWindows = process.platform === 'win32';
  const fileName = isWindows ? 'claude.cmd' : 'claude';
  const contents = isWindows
    ? [
        '@echo off',
        'set args=%*',
        'echo %args% | findstr /c:"--help" >nul',
        'if %errorlevel%==0 (',
        ...helpText.split(/\r?\n/).map((l) => `  echo ${l}`),
        '  exit /b 0',
        ')',
        'exit /b 0',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  if [ "$a" = "--help" ]; then',
        '    cat <<\'EOF\'',
        helpText,
        'EOF',
        '    exit 0',
        '  fi',
        'done',
        'exit 0',
      ].join('\n');
  return writeExecutableShimSync({ dir, fileName, contents });
}

describe('claudePreflightModelsProbeAdapter', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('adds a model-scoped Thinking option only when the installed Claude CLI supports --effort', async () => {
    tempDir = makeTempDir('happier-claude-preflight-');
    const fakeClaude = writeFakeClaudeBinary(tempDir, '  --effort <level>  Effort level for the current session (low, medium, high, max)');

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_CLAUDE_PATH = fakeClaude;

    const raw = await claudePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 1_500,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'claude-opus-4-6',
        modelOptions: [expect.objectContaining({ id: 'reasoning_effort' })],
      }),
    ]));
    expect(raw).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'claude-haiku-4-5',
        modelOptions: undefined,
      }),
    ]));
  });

  it('returns null when the installed Claude CLI does not expose --effort', async () => {
    tempDir = makeTempDir('happier-claude-preflight-');
    const fakeClaude = writeFakeClaudeBinary(tempDir, 'Claude Code help output without effort');

    process.env.PATH = '/usr/bin:/bin';
    process.env.HAPPIER_CLAUDE_PATH = fakeClaude;

    const raw = await claudePreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 1_500,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(raw).toBeNull();
  });
});
