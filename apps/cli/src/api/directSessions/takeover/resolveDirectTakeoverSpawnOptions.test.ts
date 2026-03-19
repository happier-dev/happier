import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RawSessionRecord } from '@/sessionControl/sessionsHttp';
import type { LoadedLinkedDirectSession } from './loadLinkedDirectSession';
import { resolveDirectTakeoverSpawnOptions } from './resolveDirectTakeoverSpawnOptions';

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    isDaemonProcess: false,
  },
}));

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function writeFakeCodexAppServerScript(params: Readonly<{
  dir: string;
  nonArchivedThreads?: Array<Record<string, unknown>>;
  archivedThreads?: Array<Record<string, unknown>>;
}>): Promise<string> {
  const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
  const script = [
    '#!/usr/bin/env node',
    'import readline from "node:readline";',
    `const nonArchivedThreads = ${JSON.stringify(params.nonArchivedThreads ?? [])};`,
    `const archivedThreads = ${JSON.stringify(params.archivedThreads ?? [])};`,
    'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'for await (const line of rl) {',
    '  if (!line.trim()) continue;',
    '  const msg = JSON.parse(line);',
    '  if (msg.method === "initialize") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "initialized") continue;',
    '  if (msg.method === "thread/list") {',
    '    const archived = msg.params?.archived === true;',
    '    const data = archived ? archivedThreads : nonArchivedThreads;',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data, nextCursor: null } }) + "\\n");',
    '    continue;',
    '  }',
    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
    '}',
  ].join('\n');
  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  return scriptPath;
}

function createLinkedCodexSessionFixture(params: Readonly<{
  remoteSessionId: string;
  source: LoadedLinkedDirectSession['source'];
  sessionPath?: string | null;
  metadata?: LoadedLinkedDirectSession['metadata'];
  codexBackendMode?: 'mcp' | 'acp' | 'appServer';
}>): LoadedLinkedDirectSession {
  return {
    rawSession: {} as RawSessionRecord,
    metadata: params.metadata ?? {},
    sessionPath: params.sessionPath ?? null,
    providerId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    codexBackendMode: params.codexBackendMode ?? null,
  };
}

function createLinkedOpenCodeSessionFixture(params: Readonly<{
  remoteSessionId: string;
  source: LoadedLinkedDirectSession['source'];
  sessionPath?: string | null;
}>): LoadedLinkedDirectSession {
  return {
    rawSession: {} as RawSessionRecord,
    metadata: {},
    sessionPath: params.sessionPath ?? null,
    providerId: 'opencode',
    machineId: 'machine-1',
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    codexBackendMode: null,
  };
}

describe('resolveDirectTakeoverSpawnOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets direct Codex takeovers inherit the default backend mode instead of forcing ACP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-'));
    const codexHome = join(root, '.codex');
    const rolloutFile = join(
      codexHome,
      'sessions',
      '2026',
      '03',
      '06',
      'rollout-2026-03-06T00-00-00-11111111-1111-1111-1111-111111111111.jsonl',
    );
    await mkdir(join(codexHome, 'sessions', '2026', '03', '06'), { recursive: true });
    await writeFile(
      rolloutFile,
      jsonlLine({
        type: 'session_meta',
        payload: {
          id: '11111111-1111-1111-1111-111111111111',
          timestamp: '2026-03-06T00:00:00.000Z',
          cwd: '/tmp/direct-codex-takeover-project',
        },
      }),
      'utf8',
    );
    vi.stubEnv('CODEX_HOME', codexHome);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: '11111111-1111-1111-1111-111111111111',
        source: { kind: 'codexHome', home: 'user' },
      }),
      sessionId: 'sess_happy_direct_codex',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-codex-takeover-project',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: 'sess_happy_direct_codex',
      resume: '11111111-1111-1111-1111-111111111111',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: {
        CODEX_HOME: codexHome,
      },
    });
  });

  it('keeps app-server codex backend affinity during direct takeover', async () => {
    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: '11111111-1111-1111-1111-111111111111',
        sessionPath: '/tmp/direct-codex-app-server-project',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-codex-app-server-project',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: 'sess_happy_direct_codex',
      resume: '11111111-1111-1111-1111-111111111111',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      codexBackendMode: 'appServer',
      environmentVariables: {
        CODEX_HOME: '/Users/leeroy/.codex',
      },
    });
  });

  it('refuses ambiguous connected-service Codex takeovers when the source does not identify an exact profile/home', async () => {
    const firstHome = '/tmp/happier-test-active-server/daemon/connected-services/homes/openai-codex/profile-a/codex/codex-home';
    const secondHome = '/tmp/happier-test-active-server/daemon/connected-services/homes/openai-codex/profile-b/codex/codex-home';
    await mkdir(firstHome, { recursive: true });
    await mkdir(secondHome, { recursive: true });

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'ambiguous-thread-1',
        sessionPath: '/tmp/direct-codex-ambiguous-project',
        source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex' },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_ambiguous',
    });

    expect(spawnOptions).toBeNull();
  });

  it('refuses connected-service Codex takeovers when an exact homePath belongs to a different service', async () => {
    const foreignHome = '/tmp/happier-test-active-server/daemon/connected-services/homes/other-service/profile-a/codex/codex-home';
    await mkdir(foreignHome, { recursive: true });

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'wrong-home-thread-1',
        sessionPath: '/tmp/direct-codex-wrong-home-project',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          homePath: foreignHome,
        },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_wrong_home',
    });

    expect(spawnOptions).toBeNull();
  });

  it('refuses connected-service Codex takeovers when homePath points below codex-home instead of the exact home', async () => {
    const nestedHome = '/tmp/happier-test-active-server/daemon/connected-services/homes/openai-codex/profile-a/codex/codex-home/sessions';
    await mkdir(nestedHome, { recursive: true });

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'wrong-depth-thread-1',
        sessionPath: '/tmp/direct-codex-wrong-depth-project',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          homePath: nestedHome,
        },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_wrong_depth',
    });

    expect(spawnOptions).toBeNull();
  });

  it('refuses connected-service Codex takeovers when homePath is a symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-symlink-'));
    const realHome = join(root, 'daemon', 'connected-services', 'homes', 'other-service', 'profile-a', 'codex', 'codex-home');
    const linkedHome = join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', 'profile-a', 'codex', 'codex-home');
    await mkdir(realHome, { recursive: true });
    await mkdir(join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', 'profile-a', 'codex'), { recursive: true });
    await rm(linkedHome, { recursive: true, force: true });
    await symlink(realHome, linkedHome);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'wrong-link-thread-1',
        sessionPath: '/tmp/direct-codex-wrong-link-project',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-a',
          homePath: linkedHome,
        },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_wrong_link',
    });

    expect(spawnOptions).toBeNull();
  });

  it('keeps ACP codex backend affinity backward compatible during direct takeover', async () => {
    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'acp-thread-1',
        sessionPath: '/tmp/direct-codex-acp-project',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'acp',
      }),
      sessionId: 'sess_happy_direct_codex_acp',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-codex-acp-project',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: 'sess_happy_direct_codex_acp',
      resume: 'acp-thread-1',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      codexBackendMode: 'acp',
      environmentVariables: {
        CODEX_HOME: '/Users/leeroy/.codex',
      },
    });
  });

  it('uses app-server thread cwd when an app-server-linked codex session has no stored path or rollout metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-app-server-cwd-'));
    const codexHome = join(root, '.codex');
    await mkdir(codexHome, { recursive: true });
    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: root,
      nonArchivedThreads: [{
        id: '22222222-2222-2222-2222-222222222222',
        cwd: '/tmp/direct-codex-app-server-cwd-project',
        updatedAt: 1_736_000_100,
      }],
    });
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', fakeAppServer);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: '22222222-2222-2222-2222-222222222222',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_app_server_cwd',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-codex-app-server-cwd-project',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: 'sess_happy_direct_codex_app_server_cwd',
      resume: '22222222-2222-2222-2222-222222222222',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      codexBackendMode: 'appServer',
      environmentVariables: {
        CODEX_HOME: codexHome,
      },
    });
  });

  it('marks direct OpenCode server takeovers as explicit server affinity', async () => {
    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedOpenCodeSessionFixture({
        remoteSessionId: 'opencode-session-1',
        sessionPath: '/tmp/direct-opencode-takeover-project',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
      }),
      sessionId: 'sess_happy_direct_opencode',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-opencode-takeover-project',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      existingSessionId: 'sess_happy_direct_opencode',
      resume: 'opencode-session-1',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
    });
  });
});
