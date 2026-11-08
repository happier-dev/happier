import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';
import { startManagedOpenCodeServer } from './openCodeManagedServer';
import { openCodePreflightSessionControlsProbeAdapter } from '../preflight/openCodePreflightSessionControlsProbeAdapter';
import { resolveOpenCodeManagedServerStateCredential } from './openCodeManagedServerCredential';
import {
  resolveOpenCodeServerAuthHeaders,
  type OpenCodeServerAuthCredential,
} from './openCodeServerAuth';
import {
  ensureSharedManagedOpenCodeServerBaseUrl,
  stopSharedManagedOpenCodeServerFromEnvBestEffort,
} from './sharedManagedServer';

/**
 * Fake `opencode serve` that mirrors the released OpenCode 2.0.15 server-process contract
 * (`packages/cli/src/server-process.ts` + `packages/server/src/{auth,process}.ts` at
 * 6f3639d82ed0760091792189b78f8eeb44f699b1):
 *  - every default `serve` is password protected: the supplied `OPENCODE_PASSWORD`
 *    (legacy `OPENCODE_SERVER_PASSWORD` as fallback) or a freshly generated random secret,
 *  - the Basic username is fixed to `opencode`,
 *  - `/api/info` is the released readiness surface and is authenticated,
 *  - the generated secret is printed ONLY when no password came from the environment.
 */
const FAKE_OPEN_CODE_V2_SERVE = `#!/usr/bin/env node
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { appendFileSync, writeFileSync } = require('node:fs');
if (process.env.OPENCODE_TEST_PID_FILE) writeFileSync(process.env.OPENCODE_TEST_PID_FILE, String(process.pid));

function parseArg(name) {
  const prefix = name + '=';
  const raw = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix)) || '';
  return raw.slice(prefix.length);
}

const hostname = parseArg('--hostname') || '127.0.0.1';
const port = Number(parseArg('--port') || '0');
if (!Number.isFinite(port) || port <= 0) {
  console.error('missing --port');
  process.exit(2);
}

const environmentPassword = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || '';
const password = environmentPassword || randomBytes(32).toString('base64url');
const expected = 'Basic ' + Buffer.from('opencode:' + password, 'utf8').toString('base64');
let catalogsReady = false;

const server = http.createServer((req, res) => {
  if ((req.headers.authorization || '') !== expected) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' });
    res.end();
    return;
  }
  if (req.url && req.url.startsWith('/global/health') && process.env.OPENCODE_TEST_LEGACY_API) {
    if (process.env.OPENCODE_TEST_READY_FILE) writeFileSync(process.env.OPENCODE_TEST_READY_FILE, 'ready');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ healthy: true, version: '1.18.33' })); return;
  }
  // OpenCode 1.18.35 answers both health routes, but its MCP API remains V1.
  if (process.env.OPENCODE_TEST_LEGACY_API) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/health' || (path === '/mcp' && req.method === 'POST')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(path === '/api/health' ? { healthy: true } : { happier: { status: 'connected' } }));
      return;
    }
    if (path === '/session/ses_fixture/prompt_async' && req.method === 'POST') {
      res.writeHead(204); res.end(); return;
    }
  }
  if (req.url && req.url.startsWith('/api/info') && process.env.OPENCODE_TEST_LEGACY_API) { res.writeHead(404); res.end(); return; }
  if (req.url && req.url.startsWith('/api/info')) {
    if (process.env.OPENCODE_TEST_READY_FILE) writeFileSync(process.env.OPENCODE_TEST_READY_FILE, 'ready');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '2.0.15', pid: process.pid, urls: [], paths: {} }));
    return;
  }
  // V2 2.0.20: integration.list awaits Plugin.awaitActivation for this location;
  // command.list and skill.list read the registry without waiting themselves.
  if (req.url && req.url.startsWith('/api/integration')) {
    if (process.env.OPENCODE_TEST_CATALOG_READ_FILE) appendFileSync(process.env.OPENCODE_TEST_CATALOG_READ_FILE, '/api/integration;');
    if (process.env.OPENCODE_TEST_HANG_COMMANDS) return;
    catalogsReady = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] })); return;
  }
  if (req.url && (req.url.startsWith('/api/command') || req.url.startsWith('/command'))) {
    if (process.env.OPENCODE_TEST_CATALOG_READ_FILE) appendFileSync(process.env.OPENCODE_TEST_CATALOG_READ_FILE, req.url.split('?')[0] + ';');
    if (process.env.OPENCODE_TEST_HANG_COMMANDS) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(process.env.OPENCODE_TEST_LEGACY_API ? [] : { data: catalogsReady ? [{ name: 'review' }] : [] })); return;
  }
  if (req.url && req.url.startsWith('/skill')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([])); return;
  }
  if (req.url && req.url.startsWith('/api/skill')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: catalogsReady ? [{ id: 'native-reviewer', name: 'reviewer', path: '/fixture/SKILL.md' }] : [] }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, hostname, () => {
  console.log('server listening on http://' + hostname + ':' + port);
  if (!environmentPassword) console.log('server password ' + password);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

const envKeys = [
  'PATH',
  'HOME',
  'HAPPIER_HOME_DIR',
  'HAPPIER_OPENCODE_PATH',
  'HAPPIER_OPENCODE_CLI_GENERATION',
  'HAPPIER_OPENCODE_SERVER_STATE_PATH',
  'HAPPIER_OPENCODE_SERVER_URL',
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_TEST_LEGACY_API',
] as const;

const TEMP_DIRS = new Set<string>();
const TEST_NATIVE_PIDS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function prepareManagedServerEnv(): Promise<Readonly<{ root: string; logsDir: string }>> {
  const root = createTempDirSync('happier-opencode-managed-auth-');
  TEMP_DIRS.add(root);
  const shimPath = await writeExecutableShim({
    dir: root,
    fileName: 'fake-opencode',
    contents: FAKE_OPEN_CODE_V2_SERVE,
  });
  process.env.HAPPIER_HOME_DIR = join(root, 'happier-home');
  process.env.HAPPIER_OPENCODE_PATH = shimPath;
  delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
  delete process.env.OPENCODE_PASSWORD;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  return { root, logsDir: join(root, 'logs') };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of TEST_NATIVE_PIDS) {
    try { process.kill(Number(readFileSync(path, 'utf8')), 'SIGKILL'); } catch {}
  }
  TEST_NATIVE_PIDS.clear();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of TEMP_DIRS) removeTempDirSync(dir);
  TEMP_DIRS.clear();
});

describe('startManagedOpenCodeServer managed credential', () => {
  it('shares a minted-password server while its first runtime client is still active', async () => {
    const { root } = await prepareManagedServerEnv();
    const statePath = join(root, 'managed-server.json');
    envScope.patch({
      HAPPIER_OPENCODE_SERVER_STATE_PATH: statePath,
      HAPPIER_OPENCODE_SERVER_URL: undefined,
      HAPPIER_OPENCODE_CLI_GENERATION: 'v2',
      OPENCODE_TEST_LEGACY_API: undefined,
    });
    const first = await createOpenCodeServerRuntimeClient({ directory: root, messageBuffer: new MessageBuffer() });
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      expect(typeof state.authPassword).toBe('string');
      expect((await fetch(`${state.baseUrl}/api/info`)).status).toBe(401);

      const second = await createOpenCodeServerRuntimeClient({ directory: root, messageBuffer: new MessageBuffer() });
      try {
        const reused = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
        expect(reused.pid).toBe(state.pid);
        expect(reused.baseUrl).toBe(state.baseUrl);
        await expect(second.appCommands()).resolves.toEqual([{ name: 'review' }]);
      } finally {
        await second.dispose();
      }
      await expect(first.appCommands()).resolves.toEqual([{ name: 'review' }]);
    } finally {
      await first.dispose();
      await stopSharedManagedOpenCodeServerFromEnvBestEffort();
    }
  }, 30_000);

  it('keeps dual-health V1 prompts working across reuse of a stale persisted V2 hint', async () => {
    const { root } = await prepareManagedServerEnv();
    const statePath = join(root, 'managed-server.json');
    envScope.patch({
      HAPPIER_OPENCODE_SERVER_STATE_PATH: statePath,
      HAPPIER_OPENCODE_SERVER_URL: undefined,
      HAPPIER_OPENCODE_CLI_GENERATION: 'stable',
      OPENCODE_TEST_LEGACY_API: '1',
      OPENCODE_SERVER_PASSWORD: 'fixture-password',
    });
    try {
      const first = await createOpenCodeServerRuntimeClient({ directory: root, messageBuffer: new MessageBuffer() });
      await first.dispose();
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      expect(state.apiGeneration).toBe('auto');
      await writeFile(statePath, JSON.stringify({ ...state, apiGeneration: 'v2' }));

      const reused = await createOpenCodeServerRuntimeClient({ directory: root, messageBuffer: new MessageBuffer() });
      try {
        await expect(reused.mcpAdd({ name: 'happier', config: { type: 'local', enabled: true } }))
          .resolves.toEqual({ status: 'connected' });
        await expect(reused.sessionPromptAsync({ sessionId: 'ses_fixture', parts: [{ type: 'text', text: 'hello' }] }))
          .resolves.toBeUndefined();
        expect(JSON.parse(await readFile(statePath, 'utf8')).pid).toBe(state.pid);
      } finally {
        await reused.dispose();
      }
    } finally {
      await stopSharedManagedOpenCodeServerFromEnvBestEffort();
    }
  }, 30_000);

  it('reports failure when the OS refuses to terminate its owned native server', async () => {
    const { root, logsDir } = await prepareManagedServerEnv();
    const pidPath = join(root, 'refused-termination-pid');
    TEST_NATIVE_PIDS.add(pidPath);
    const started = await startManagedOpenCodeServer({ logsDir, timeoutMs: 10_000,
      env: { ...process.env, OPENCODE_TEST_PID_FILE: pidPath } });
    const realKill = process.kill.bind(process);
    // Process signaling is the genuine OS boundary; health, tracking and stop policy stay real.
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (Math.abs(pid) === started.pid && signal !== 0) {
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      }
      return realKill(pid, signal);
    });
    try {
      await expect(started.close()).rejects.toMatchObject({ code: 'open_code_server_termination_incomplete' });
    } finally {
      kill.mockRestore();
      try { realKill(started.pid, 'SIGKILL'); } catch {}
    }
  }, 30_000);

  it('discovers cold V2 catalogs after native activation without creating a session', async () => {
    const { root } = await prepareManagedServerEnv();
    await expect(openCodePreflightSessionControlsProbeAdapter.probeCatalogsRaw?.({
      cwd: root, timeoutMs: 15_000, processEnv: { ...process.env },
    })).resolves.toMatchObject({ commands: [{ name: 'review' }], skills: [{ id: 'native-reviewer', name: 'reviewer' }] });
  }, 30_000);

  it.each(['v1', 'v2'] as const)('bounds %s native catalog readiness/reads by the caller deadline after a slow server startup', async (generation) => {
    const { root } = await prepareManagedServerEnv();
    const pidPath = join(root, 'catalog-native-pid');
    TEST_NATIVE_PIDS.add(pidPath);
    const readyPath = join(root, 'catalog-native-ready');
    const catalogReadPath = join(root, 'catalog-native-read');
    const startedAt = Date.now();
    const realNow = Date.now.bind(Date);
    let readinessObservedAt: number | undefined;
    // The clock is a genuine system boundary: reproduce startup consuming nearly the
    // whole caller budget without a timing-sensitive slow subprocess fixture.
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (!existsSync(readyPath)) return startedAt;
      readinessObservedAt ??= realNow();
      return startedAt + 9_500 + realNow() - readinessObservedAt;
    });
    const pending = openCodePreflightSessionControlsProbeAdapter.probeCatalogsRaw?.({
      cwd: root, timeoutMs: 10_000,
      processEnv: { ...process.env, OPENCODE_TEST_PID_FILE: pidPath,
        OPENCODE_TEST_READY_FILE: readyPath, OPENCODE_TEST_CATALOG_READ_FILE: catalogReadPath,
        OPENCODE_TEST_HANG_COMMANDS: '1', ...(generation === 'v1' ? { OPENCODE_TEST_LEGACY_API: '1' } : {}),
        HAPPIER_OPENCODE_CLI_GENERATION: generation === 'v1' ? 'stable' : 'v2', OPENCODE_SERVER_PASSWORD: 'deadline-fixture-password' },
    });
    try {
      await expect(pending).rejects.toThrow(/timed out/i);
      expect(existsSync(readyPath)).toBe(true);
      expect(await readFile(catalogReadPath, 'utf8')).toContain(generation === 'v1' ? '/command' : '/api/integration');
      expect(readinessObservedAt).toBeDefined();
      // The remaining 500ms may include real process cleanup. This generous observation
      // window still distinguishes a fresh 10s read budget from the containing budget.
      expect(realNow() - readinessObservedAt!).toBeLessThan(2_000);
    } finally {
      const pid = Number(await readFile(pidPath, 'utf8').catch(() => ''));
      if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }, 15_000);

  it('uses the selected probe environment without changing the daemon environment', async () => {
    const { logsDir } = await prepareManagedServerEnv();
    const env = { ...process.env, OPENCODE_PASSWORD: 'selected-probe-password' };
    const started = await startManagedOpenCodeServer({ timeoutMs: 15_000, logsDir, env });
    try {
      expect(started.authPassword).toBeUndefined();
      const response = await fetch(`${started.baseUrl}/api/info`, {
        headers: resolveOpenCodeServerAuthHeaders({ username: 'opencode', password: env.OPENCODE_PASSWORD }),
      });
      expect(response.status).toBe(200);
      expect(process.env.OPENCODE_PASSWORD).toBeUndefined();
    } finally {
      await started.close();
    }
  }, 25_000);

  it('reaches readiness against a password-protected server without any password in the environment', async () => {
    const { logsDir } = await prepareManagedServerEnv();

    const started = await startManagedOpenCodeServer({ timeoutMs: 15_000, logsDir });
    try {
      expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(started.authPassword?.length ?? 0).toBeGreaterThanOrEqual(32);

      const unauthenticated = await fetch(`${started.baseUrl}/api/info`);
      expect(unauthenticated.status).toBe(401);

      // Any later reader of THIS server (reuse probe, restarted daemon, attaching terminal) resolves
      // the credential from the retained state and reaches the same running server.
      const retained = resolveOpenCodeManagedServerStateCredential({
        state: { baseUrl: started.baseUrl, ...(started.authPassword ? { authPassword: started.authPassword } : {}) },
        baseUrl: started.baseUrl,
        env: {},
      });
      expect(retained).toEqual({ username: 'opencode', password: started.authPassword });
      const authenticated = await fetch(`${started.baseUrl}/api/info`, {
        headers: resolveOpenCodeServerAuthHeaders(retained),
      });
      expect(authenticated.status).toBe(200);
    } finally {
      await started.close();
    }
  }, 25_000);

  it('keeps the managed credential out of the durable managed-server log', async () => {
    const { logsDir } = await prepareManagedServerEnv();

    const started = await startManagedOpenCodeServer({ timeoutMs: 15_000, logsDir });
    try {
      const log = await readFile(started.logPath, 'utf8');
      expect(log).toContain('server listening on');
      expect(log).not.toContain('server password');
      expect(log).not.toContain(started.authPassword ?? '<no credential>');
    } finally {
      await started.close();
    }
  }, 25_000);

  it('retains the credential in a private managed-server state file and authenticates the reuse probe', async () => {
    const { root } = await prepareManagedServerEnv();
    const statePath = join(root, 'managed-server.json');
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = statePath;
    const probedCredentials: Array<unknown> = [];

    const probeHealth = async (
      candidateBaseUrl: string,
      _apiGeneration?: 'auto' | 'v2',
      auth?: OpenCodeServerAuthCredential | null,
    ): Promise<boolean> => {
      probedCredentials.push(auth ?? null);
      const response = await fetch(`${candidateBaseUrl}/api/info`, {
        headers: resolveOpenCodeServerAuthHeaders(auth ?? null),
      }).catch(() => null);
      return response?.status === 200;
    };

    const baseUrl = await ensureSharedManagedOpenCodeServerBaseUrl({ probeHealth });
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      expect(state.baseUrl).toBe(baseUrl);
      expect(typeof state.authPassword).toBe('string');
      expect((state.authPassword as string).length).toBeGreaterThanOrEqual(32);
      if (process.platform !== 'win32') {
        expect(statSync(statePath).mode & 0o777).toBe(0o600);
      }

      // A second resolution reuses the running server, and the probe that decides reuse authenticates
      // with the retained credential (an unauthenticated probe would 401 and force a replacement).
      const reusedBaseUrl = await ensureSharedManagedOpenCodeServerBaseUrl({ probeHealth });
      expect(reusedBaseUrl).toBe(baseUrl);
      expect(probedCredentials).toEqual([{ username: 'opencode', password: state.authPassword }]);
    } finally {
      await stopSharedManagedOpenCodeServerFromEnvBestEffort();
    }
  }, 30_000);

  it('uses an operator-configured legacy server password instead of minting one', async () => {
    const { logsDir } = await prepareManagedServerEnv();
    process.env.OPENCODE_SERVER_PASSWORD = 'operator-legacy-secret';

    const started = await startManagedOpenCodeServer({ timeoutMs: 15_000, logsDir });
    try {
      // Nothing to retain: the operator credential is re-derived from the environment.
      expect(started.authPassword).toBeUndefined();
      const authenticated = await fetch(`${started.baseUrl}/api/info`, {
        headers: resolveOpenCodeServerAuthHeaders({ username: 'opencode', password: 'operator-legacy-secret' }),
      });
      expect(authenticated.status).toBe(200);
    } finally {
      await started.close();
    }
  }, 25_000);
});
