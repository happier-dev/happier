import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectCliSnapshotOnDaemonPath } from './cliSnapshot';

const SCOPED_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'PATH',
  'HAPPIER_CLAUDE_PATH',
  'HAPPIER_OPENCODE_PATH',
] as const;

type ScopedEnvKey = (typeof SCOPED_ENV_KEYS)[number];

function setEnv(key: ScopedEnvKey, value: string | undefined) {
  if (typeof value === 'string') process.env[key] = value;
  else delete process.env[key];
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeExecutableShim(params: { dir: string; name: string; stdout: string }): string {
  const isWin = process.platform === 'win32';
  const filePath = join(params.dir, isWin ? `${params.name}.cmd` : params.name);
  const content = isWin
    ? `@echo off\r\n${params.stdout}\r\n`
    : `#!/bin/sh\n${params.stdout}\n`;
  writeFileSync(filePath, content, 'utf8');
  if (!isWin) {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

describe('detectCliSnapshotOnDaemonPath', () => {
  let workDir: string;
  let homeDir: string;
  let envBaseline: Record<ScopedEnvKey, string | undefined>;

  beforeEach(() => {
    envBaseline = Object.fromEntries(
      SCOPED_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<ScopedEnvKey, string | undefined>;

    workDir = makeTempDir('happier-cliSnapshot-');
    homeDir = join(workDir, 'home');
    mkdirSync(homeDir, { recursive: true });

    setEnv('HOME', homeDir);
    setEnv('USERPROFILE', homeDir);
    setEnv('LOCALAPPDATA', join(homeDir, 'AppData', 'Local'));
    setEnv('PATH', join(workDir, 'empty-path'));
    mkdirSync(process.env.PATH!, { recursive: true });
    setEnv('HAPPIER_CLAUDE_PATH', undefined);
    setEnv('HAPPIER_OPENCODE_PATH', undefined);
  });

  afterEach(() => {
    for (const key of SCOPED_ENV_KEYS) {
      setEnv(key, envBaseline[key]);
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'detects Claude Code in ~/.local/bin/claude even when it is not on PATH',
    async () => {
      const localBin = join(homeDir, '.local', 'bin');
      mkdirSync(localBin, { recursive: true });
      const claudePath = makeExecutableShim({
        dir: localBin,
        name: 'claude',
        stdout: 'echo "2.0.69 (Claude Code)"',
      });

      const snapshot = await detectCliSnapshotOnDaemonPath({});
      expect(snapshot.clis.claude.available).toBe(true);
      expect(snapshot.clis.claude.resolvedPath).toBe(claudePath);
      expect(snapshot.clis.claude.version).toBe('2.0.69');
    },
  );

  it('detects Claude when HAPPIER_CLAUDE_PATH is set even when it is not on PATH', async () => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const claudePath = makeExecutableShim({
      dir: binDir,
      name: 'claude',
      stdout: 'echo "2.0.70 (Claude Code)"',
    });

    setEnv('HAPPIER_CLAUDE_PATH', claudePath);

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.claude.available).toBe(true);
    expect(snapshot.clis.claude.resolvedPath).toBe(claudePath);
    expect(snapshot.clis.claude.version).toBe('2.0.70');
  });

  it('detects OpenCode when HAPPIER_OPENCODE_PATH is set even when it is not on PATH', async () => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const opencodePath = makeExecutableShim({
      dir: binDir,
      name: 'opencode',
      stdout: 'echo "0.0.0-test (OpenCode)"',
    });

    setEnv('HAPPIER_OPENCODE_PATH', opencodePath);

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.opencode.available).toBe(true);
    expect(snapshot.clis.opencode.resolvedPath).toBe(opencodePath);
    expect(snapshot.clis.opencode.version).toBe('0.0.0-test');
  });

  it.skipIf(process.platform === 'win32')(
    'does not run `gemini auth status` when probing login status',
    async () => {
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });

      const invocationsPath = join(workDir, 'gemini-invocations.txt');
      const geminiPath = makeExecutableShim({
        dir: binDir,
        name: 'gemini',
        stdout: [
          `echo "$@" >> "${invocationsPath}"`,
          'if [ "$1" = "--version" ] || [ "$1" = "version" ] || [ "$1" = "-v" ]; then',
          '  echo "1.2.3"',
          '  exit 0',
          'fi',
          'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
          '  exit 1',
          'fi',
          'exit 0',
        ].join('\n'),
      });

      setEnv('PATH', binDir);

      const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      expect(snapshot.clis.gemini.available).toBe(true);
      expect(snapshot.clis.gemini.resolvedPath).toBe(geminiPath);
      expect(snapshot.clis.gemini.isLoggedIn).toBe(false);

      const invocations = readFileSync(invocationsPath, 'utf8');
      expect(invocations).not.toContain('auth status');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports Gemini as logged in when ~/.gemini/oauth_creds.json exists',
    async () => {
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });

      const invocationsPath = join(workDir, 'gemini-invocations.txt');
      makeExecutableShim({
        dir: binDir,
        name: 'gemini',
        stdout: [
          `echo "$@" >> "${invocationsPath}"`,
          // Version detection should still work.
          'if [ "$1" = "--version" ] || [ "$1" = "version" ] || [ "$1" = "-v" ]; then',
          '  echo "1.2.3"',
          '  exit 0',
          'fi',
          // The old probe (`gemini auth status`) is intentionally non-zero to catch regressions.
          'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
          '  exit 1',
          'fi',
          'exit 0',
        ].join('\n'),
      });

      const geminiDir = join(homeDir, '.gemini');
      mkdirSync(geminiDir, { recursive: true });
      writeFileSync(
        join(geminiDir, 'oauth_creds.json'),
        JSON.stringify({ access_token: 'token', token_type: 'Bearer' }),
        'utf8',
      );

      setEnv('PATH', binDir);

      const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      expect(snapshot.clis.gemini.available).toBe(true);
      expect(snapshot.clis.gemini.isLoggedIn).toBe(true);

      const invocations = readFileSync(invocationsPath, 'utf8');
      expect(invocations).not.toContain('auth status');
    },
  );
});
