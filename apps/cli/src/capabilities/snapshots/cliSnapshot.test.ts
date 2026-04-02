import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectCliSnapshotOnDaemonPath } from './cliSnapshot';
import { resolveProviderCliManagedCommandPath } from '@/runtime/managedTools/providerCliResolution';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { resolveSystemJavaScriptRuntimeBinary, writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const SCOPED_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'PATH',
  'HAPPIER_HOME_DIR',
  'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON',
  'HAPPIER_CLAUDE_PATH',
  'HAPPIER_CODEX_PATH',
  'HAPPIER_OPENCODE_PATH',
  'HAPPIER_PNPM_BIN',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

type ScopedEnvKey = (typeof SCOPED_ENV_KEYS)[number];

function setEnv(key: ScopedEnvKey, value: string | undefined) {
  applyEnvValues({ [key]: value });
}

function makeTempDir(prefix: string): string {
  return createTempDirSync(prefix);
}

function makeExecutableShim(params: { dir: string; name: string; stdout: string }): string {
  const isWin = process.platform === 'win32';
  const content = isWin
    ? `@echo off\r\n${params.stdout}\r\n`
    : `#!/bin/sh\n${params.stdout}\n`;
  return writeExecutableShimSync({
    dir: params.dir,
    fileName: isWin ? `${params.name}.cmd` : params.name,
    contents: content,
  });
}

describe('detectCliSnapshotOnDaemonPath', () => {
  let workDir: string;
  let homeDir: string;
  let envBaseline: Record<ScopedEnvKey, string | undefined>;

  beforeEach(() => {
    envBaseline = snapshotEnvValues(SCOPED_ENV_KEYS) as Record<ScopedEnvKey, string | undefined>;

    workDir = makeTempDir('happier-cliSnapshot-');
    homeDir = join(workDir, 'home');
    mkdirSync(homeDir, { recursive: true });

    setEnv('HOME', homeDir);
    setEnv('USERPROFILE', homeDir);
    setEnv('LOCALAPPDATA', join(homeDir, 'AppData', 'Local'));
    setEnv('HAPPIER_HOME_DIR', homeDir);
    setEnv('PATH', join(workDir, 'empty-path'));
    mkdirSync(process.env.PATH!, { recursive: true });
    setEnv('HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON', undefined);
    setEnv('HAPPIER_CLAUDE_PATH', undefined);
    setEnv('HAPPIER_CODEX_PATH', undefined);
    setEnv('HAPPIER_OPENCODE_PATH', undefined);
  });

  afterEach(() => {
    restoreEnvValues(envBaseline);
    if (workDir) removeTempDirSync(workDir);
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

  it.skipIf(process.platform === 'win32')(
    'detects OpenCode in ~/.opencode/bin even when it is not on PATH',
    async () => {
      const opencodeBinDir = join(homeDir, '.opencode', 'bin');
      mkdirSync(opencodeBinDir, { recursive: true });
      const opencodePath = makeExecutableShim({
        dir: opencodeBinDir,
        name: 'opencode',
        stdout: 'echo "0.4.1"',
      });

      const snapshot = await detectCliSnapshotOnDaemonPath({});
      expect(snapshot.clis.opencode.available).toBe(true);
      expect(snapshot.clis.opencode.resolvedPath).toBe(opencodePath);
      expect(snapshot.clis.opencode.version).toBe('0.4.1');
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

  it('detects Claude when HAPPIER_CLAUDE_PATH points to a JavaScript entrypoint file', async () => {
    const entryDir = join(workDir, 'claude-js');
    mkdirSync(entryDir, { recursive: true });
    const claudePath = join(entryDir, 'claude.js');
    writeFileSync(
      claudePath,
      [
        '#!/usr/bin/env node',
        'if (process.argv.includes("--version")) console.log("2.0.71 (Claude Code)");',
        'else console.log("ok");',
        '',
      ].join('\n'),
      'utf8',
    );
    if (process.platform !== 'win32') {
      chmodSync(claudePath, 0o644);
    }

    setEnv('HAPPIER_CLAUDE_PATH', claudePath);
    setEnv('HAPPIER_JS_RUNTIME_PATH', resolveSystemJavaScriptRuntimeBinary(envBaseline.PATH));

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.claude.available).toBe(true);
    expect(snapshot.clis.claude.resolvedPath).toBe(claudePath);
    expect(snapshot.clis.claude.version).toBe('2.0.71');
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed when HAPPIER_CLAUDE_PATH is set but invalid even if a common install location exists',
    async () => {
      const localBin = join(homeDir, '.local', 'bin');
      mkdirSync(localBin, { recursive: true });
      makeExecutableShim({
        dir: localBin,
        name: 'claude',
        stdout: 'echo "2.0.70 (Claude Code)"',
      });

      setEnv('HAPPIER_CLAUDE_PATH', join(workDir, 'missing-claude'));

      const snapshot = await detectCliSnapshotOnDaemonPath({});
      expect(snapshot.clis.claude.available).toBe(false);
      expect(snapshot.clis.claude.resolvedPath).toBeUndefined();
    },
  );

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
    'fails closed for a system node-shebang CLI when the explicit JavaScript runtime override is invalid',
    async () => {
      const systemBin = join(workDir, 'bin');
      mkdirSync(systemBin, { recursive: true });
      const geminiPath = join(systemBin, 'gemini');
      writeFileSync(
        geminiPath,
        ['#!/usr/bin/env node', 'console.log("1.2.3");', ''].join('\n'),
        'utf8',
      );
      chmodSync(geminiPath, 0o755);
      setEnv('PATH', systemBin);
      setEnv('HAPPIER_JS_RUNTIME_PATH', join(workDir, 'missing-node'));

      const snapshot = await detectCliSnapshotOnDaemonPath({});
      expect(snapshot.clis.gemini.available).toBe(false);
      expect(snapshot.clis.gemini.resolvedPath).toBeUndefined();
    },
  );

  it('detects managed Codex installs when the system CLI is unavailable', async () => {
    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: homeDir });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(
      managedPath,
      process.platform === 'win32' ? '@echo off\r\necho "0.111.0"\r\n' : '#!/bin/sh\necho "0.111.0"\n',
      'utf8',
    );
    if (process.platform !== 'win32') chmodSync(managedPath, 0o755);

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.codex.available).toBe(true);
    expect(snapshot.clis.codex.resolvedPath).toBe(managedPath);
    expect(snapshot.clis.codex.version).toBe('0.111.0');
  });

  it('prefers the system Codex CLI over a managed install by default', async () => {
    const systemBin = join(workDir, 'bin');
    mkdirSync(systemBin, { recursive: true });
    const systemCodexPath = makeExecutableShim({
      dir: systemBin,
      name: 'codex',
      stdout: 'echo "0.112.0"',
    });
    setEnv('PATH', systemBin);

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: homeDir });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(
      managedPath,
      process.platform === 'win32' ? '@echo off\r\necho "0.111.0"\r\n' : '#!/bin/sh\necho "0.111.0"\n',
      'utf8',
    );
    if (process.platform !== 'win32') chmodSync(managedPath, 0o755);

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.codex.available).toBe(true);
    expect(snapshot.clis.codex.resolvedPath).toBe(systemCodexPath);
    expect(snapshot.clis.codex.resolutionSource).toBe('system');
    expect(snapshot.clis.codex.version).toBe('0.112.0');
  });

  it('prefers HAPPIER_CODEX_PATH over a managed Codex install', async () => {
    const overrideBin = join(workDir, 'override-bin');
    mkdirSync(overrideBin, { recursive: true });
    const overrideCodexPath = makeExecutableShim({
      dir: overrideBin,
      name: 'codex',
      stdout: 'echo "0.113.0"',
    });
    setEnv('HAPPIER_CODEX_PATH', overrideCodexPath);

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: homeDir });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(
      managedPath,
      process.platform === 'win32' ? '@echo off\r\necho "0.111.0"\r\n' : '#!/bin/sh\necho "0.111.0"\n',
      'utf8',
    );
    if (process.platform !== 'win32') chmodSync(managedPath, 0o755);

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.codex.available).toBe(true);
    expect(snapshot.clis.codex.resolvedPath).toBe(overrideCodexPath);
    expect(snapshot.clis.codex.resolutionSource).toBe('override');
    expect(snapshot.clis.codex.version).toBe('0.113.0');
  });

  it('prefers HAPPIER_CODEX_PATH over a system Codex install on PATH', async () => {
    const systemBin = join(workDir, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemCodexPath = makeExecutableShim({
      dir: systemBin,
      name: 'codex',
      stdout: 'echo "0.112.0"',
    });
    setEnv('PATH', systemBin);

    const overrideBin = join(workDir, 'override-bin');
    mkdirSync(overrideBin, { recursive: true });
    const overrideCodexPath = makeExecutableShim({
      dir: overrideBin,
      name: 'codex',
      stdout: 'echo "0.113.0"',
    });
    setEnv('HAPPIER_CODEX_PATH', overrideCodexPath);

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.codex.available).toBe(true);
    expect(snapshot.clis.codex.resolvedPath).toBe(overrideCodexPath);
    expect(snapshot.clis.codex.resolutionSource).toBe('override');
    expect(snapshot.clis.codex.version).toBe('0.113.0');
    expect(snapshot.clis.codex.resolvedPath).not.toBe(systemCodexPath);
  });

  it('fails closed when HAPPIER_CODEX_PATH is set but invalid even if PATH has codex', async () => {
    const systemBin = join(workDir, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    makeExecutableShim({
      dir: systemBin,
      name: 'codex',
      stdout: 'echo "0.112.0"',
    });
    setEnv('PATH', systemBin);
    setEnv('HAPPIER_CODEX_PATH', join(workDir, 'missing-codex'));

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.codex.available).toBe(false);
    expect(snapshot.clis.codex.resolvedPath).toBeUndefined();
    expect(snapshot.clis.codex.resolutionSource).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'probes JS-backed CLI overrides through the resolved JS runtime when PATH lacks node',
    async () => {
      const codexPath = join(workDir, 'fake-codex-auth-cli.js');
      writeFileSync(
        codexPath,
        [
          '#!/usr/bin/env node',
          'const args = process.argv.slice(2);',
          'if (args[0] === "--version" || args[0] === "version" || args[0] === "-v") {',
          '  console.log("codex 0.0.0-fake");',
          '  process.exit(0);',
          '}',
          'if (args[0] === "login" && args[1] === "status") {',
          '  process.exit(1);',
          '}',
          'process.exit(1);',
        ].join('\n'),
        'utf8',
      );
      chmodSync(codexPath, 0o755);

      setEnv('PATH', '');
      setEnv('HAPPIER_CODEX_PATH', codexPath);
      const runtimeBinary = resolveSystemJavaScriptRuntimeBinary(envBaseline.PATH);
      setEnv('HAPPIER_JS_RUNTIME_PATH', runtimeBinary);

      const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true, bypassCache: true });
      expect(snapshot.clis.codex.available).toBe(true);
      expect(snapshot.clis.codex.resolvedPath).toBe(codexPath);
      expect(snapshot.clis.codex.resolvedCommand).toBe(`'${runtimeBinary}' '${codexPath}'`);
      expect(snapshot.clis.codex.version).toBe('0.0.0-fake');
      expect(snapshot.clis.codex.isLoggedIn).toBe(false);
      expect(snapshot.clis.codex.authStatus).toMatchObject({
        state: 'logged_out',
        reason: 'missing_credentials',
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'detects JS-backed system CLIs inside compiled bun bundles when node is available on PATH',
    async () => {
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const codexPath = join(binDir, 'codex');
      const nodePath = join(binDir, 'node');
      const hostNodePath = process.execPath;
      writeFileSync(nodePath, `#!/bin/sh\nexec '${hostNodePath}' "$@"\n`, 'utf8');
      chmodSync(nodePath, 0o755);
      writeFileSync(
        codexPath,
        [
          '#!/usr/bin/env node',
          'if (process.argv.includes("--version")) console.log("codex 0.200.0");',
          'else process.exit(0);',
        ].join('\n'),
        'utf8',
      );
      chmodSync(codexPath, 0o755);

      const originalExecPath = process.execPath;
      const originalBunDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun');
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        value: '/Applications/Happier.app/Contents/MacOS/happier',
      });
      Object.defineProperty(process.versions, 'bun', {
        configurable: true,
        value: '1.2.23',
      });
      setEnv('PATH', binDir);

      try {
        const snapshot = await detectCliSnapshotOnDaemonPath({ requestedCliNames: ['codex'], bypassCache: true });
        expect(snapshot.clis.codex.available).toBe(true);
        expect(snapshot.clis.codex.resolvedPath).toBe(codexPath);
        expect(snapshot.clis.codex.resolvedCommand).toBe(`'${nodePath}' '${codexPath}'`);
        expect(snapshot.clis.codex.version).toBe('0.200.0');
      } finally {
        Object.defineProperty(process, 'execPath', {
          configurable: true,
          value: originalExecPath,
        });
        if (originalBunDescriptor) {
          Object.defineProperty(process.versions, 'bun', originalBunDescriptor);
        } else {
          delete (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails closed for a JS-backed Claude override when the explicit JS runtime override is invalid',
    async () => {
      const entryDir = join(workDir, 'claude-js-invalid-runtime');
      mkdirSync(entryDir, { recursive: true });
      const claudePath = join(entryDir, 'claude.js');
      writeFileSync(
        claudePath,
        [
          '#!/usr/bin/env node',
          'if (process.argv.includes("--version")) console.log("2.0.72 (Claude Code)");',
          'else console.log("ok");',
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(claudePath, 0o644);

      setEnv('HAPPIER_CLAUDE_PATH', claudePath);
      setEnv('HAPPIER_JS_RUNTIME_PATH', join(workDir, 'missing-runtime', 'node'));

      const snapshot = await detectCliSnapshotOnDaemonPath({ bypassCache: true });
      expect(snapshot.clis.claude.available).toBe(false);
      expect(snapshot.clis.claude.resolvedPath).toBeUndefined();
      expect(snapshot.clis.claude.resolvedCommand).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refreshes Codex login status when bypassCache is set',
    async () => {
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      makeExecutableShim({
        dir: binDir,
        name: 'codex',
        stdout: [
          'if [ "$1" = "--version" ] || [ "$1" = "version" ] || [ "$1" = "-v" ]; then',
          '  echo "0.0.0-fake"',
          '  exit 0',
          'fi',
          'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
          '  if [ -f "$HOME/.codex/auth.json" ]; then',
          '    exit 0',
          '  fi',
          '  exit 1',
          'fi',
          'exit 1',
        ].join('\n'),
      });
      setEnv('PATH', binDir);

      const initial = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      expect(initial.clis.codex.available).toBe(true);
      expect(initial.clis.codex.isLoggedIn).toBe(false);
      expect(initial.clis.codex.authStatus).toMatchObject({
        state: 'logged_out',
        reason: 'missing_credentials',
      });

      const authDir = join(homeDir, '.codex');
      mkdirSync(authDir, { recursive: true });
      writeFileSync(
        join(authDir, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: 'header.payload.signature',
            access_token: 'header.payload.signature',
          },
        }),
        'utf8',
      );

      const refreshed = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true, bypassCache: true });
      expect(refreshed.clis.codex.available).toBe(true);
      expect(refreshed.clis.codex.isLoggedIn).toBe(true);
      expect(refreshed.clis.codex.authStatus).toMatchObject({
        state: 'logged_in',
        method: 'oauth_cli',
        source: 'command',
      });
    },
  );

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

  it('reports Claude auth details when ANTHROPIC_API_KEY is set', async () => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    makeExecutableShim({
      dir: binDir,
      name: 'claude',
      stdout: 'echo "2.0.70 (Claude Code)"',
    });

    setEnv('PATH', binDir);
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

    const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
    expect(snapshot.clis.claude.available).toBe(true);
    expect(snapshot.clis.claude.isLoggedIn).toBe(true);
    expect(snapshot.clis.claude.authStatus).toMatchObject({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
      reason: null,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'preserves Claude file auth when version probing times out',
    async () => {
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });
	      const claudePath = makeExecutableShim({
	        dir: binDir,
	        name: 'claude',
	        stdout: [
	          '/bin/sleep 1',
	          'echo "2.0.70 (Claude Code)"',
	        ].join('\n'),
	      });
      const credentialsDir = join(homeDir, '.claude');
      mkdirSync(credentialsDir, { recursive: true });
      writeFileSync(
        join(credentialsDir, '.credentials.json'),
        JSON.stringify({
          accessToken: 'claude-access-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          email: 'tester@example.com',
        }),
        'utf8',
      );

      const previousProbeTimeout = process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS;
      const previousLoginStatusProbeTimeout = process.env.HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS;
      setEnv('PATH', binDir);
      process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS = '25';
      process.env.HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS = '25';

      try {
        const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true, bypassCache: true });
        expect(snapshot.clis.claude.available).toBe(true);
        expect(snapshot.clis.claude.resolvedPath).toBe(claudePath);
        expect(snapshot.clis.claude.version).toBeUndefined();
        expect(snapshot.clis.claude.isLoggedIn).toBe(true);
        expect(snapshot.clis.claude.authStatus).toMatchObject({
          state: 'logged_in',
          method: 'credentials_file',
          source: 'file',
          accountLabel: 'tester@example.com',
        });
      } finally {
        if (typeof previousProbeTimeout === 'string') {
          process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS = previousProbeTimeout;
        } else {
          delete process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS;
        }
        if (typeof previousLoginStatusProbeTimeout === 'string') {
          process.env.HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS = previousLoginStatusProbeTimeout;
        } else {
          delete process.env.HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS;
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'parses OpenCode auth status from `auth list` output',
    async () => {
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });

      makeExecutableShim({
        dir: binDir,
        name: 'opencode',
        stdout: [
          'if [ "$1" = "--version" ] || [ "$1" = "version" ] || [ "$1" = "-v" ]; then',
          '  echo "0.4.1"',
          '  exit 0',
          'fi',
          'if [ "$1" = "auth" ] && [ "$2" = "list" ]; then',
          '  echo "openai alice@example.com default"',
          '  exit 0',
          'fi',
          'exit 1',
        ].join('\n'),
      });

      setEnv('PATH', binDir);

      const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      expect(snapshot.clis.opencode.available).toBe(true);
      expect(snapshot.clis.opencode.isLoggedIn).toBe(true);
      expect(snapshot.clis.opencode.authStatus).toMatchObject({
        state: 'logged_in',
        method: 'oauth_cli',
        source: 'command',
        accountLabel: 'alice@example.com',
      });
    },
  );

  it('detects Kilo from the canonical `kilo` binary', async () => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const kiloPath = makeExecutableShim({
      dir: binDir,
      name: 'kilo',
      stdout: 'echo "1.0.0"',
    });

    setEnv('PATH', binDir);

    const snapshot = await detectCliSnapshotOnDaemonPath({});
    expect(snapshot.clis.kilo.available).toBe(true);
    expect(snapshot.clis.kilo.resolvedPath).toBe(kiloPath);
  });

  it('reports Pi auth details from OPENAI_API_KEY', async () => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    makeExecutableShim({
      dir: binDir,
      name: 'pi',
      stdout: 'echo "0.1.0"',
    });

    setEnv('PATH', binDir);
    setEnv('OPENAI_API_KEY', 'sk-openai-test');

    const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
    expect(snapshot.clis.pi.available).toBe(true);
    expect(snapshot.clis.pi.isLoggedIn).toBe(true);
    expect(snapshot.clis.pi.authStatus).toMatchObject({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });
});
