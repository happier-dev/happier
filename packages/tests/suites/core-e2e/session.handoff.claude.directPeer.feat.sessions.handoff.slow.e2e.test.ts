import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { fakeClaudeLogContainsUserText, postPlainUiTextMessage } from '../../src/testkit/sessionHandoffUiMessages';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type HandoffStartResult = Readonly<{
  handoffId: string;
  endpointCandidates: readonly Readonly<{ kind: string; url: string; expiresAt: number }>[];
  targetPath: string;
  providerBundle?: unknown;
}>;

type HandoffPrepareResult = Readonly<{
  handoffId: string;
  status: Readonly<{
    handoffId: string;
    status: string;
    phase: string;
    transportStrategy?: 'direct_peer' | 'server_routed_stream';
  }>;
  resume: Readonly<{
    directory: string;
    agent: 'claude' | 'codex' | 'opencode';
    resume: string;
    transcriptStorage: 'persisted' | 'direct';
    approvedNewDirectoryCreation: true;
    environmentVariables?: Record<string, string>;
  }>;
}>;

type SessionSnapshotRow = Readonly<{
  session?: Readonly<{
    id?: string;
    active?: boolean;
  }>;
}>;

async function listMachineIds(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<string[]> {
  const response = await fetchJson<Array<{ id?: unknown }>>(`${params.baseUrl}/v1/machines`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
    },
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!response || response.status !== 200 || !Array.isArray(response.data)) return [];
  return response.data
    .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
    .filter((value) => value.length > 0);
}

async function waitForMachineIds(params: Readonly<{
  baseUrl: string;
  token: string;
  count: number;
  timeoutMs?: number;
}>): Promise<string[]> {
  let machineIds: string[] = [];
  await waitFor(async () => {
    machineIds = await listMachineIds({
      baseUrl: params.baseUrl,
      token: params.token,
    });
    return machineIds.length >= params.count;
  }, {
    timeoutMs: params.timeoutMs ?? 120_000,
    intervalMs: 250,
    context: `machine count >= ${params.count}`,
  });
  return machineIds;
}

async function listDaemonSessions(daemon: StartedDaemon): Promise<string[]> {
  const response = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string }> }>({
    port: daemon.state.httpPort,
    path: '/list',
    controlToken: daemon.state.controlToken,
  });
  if (response.status !== 200 || !Array.isArray(response.data.children)) {
    throw new Error(`Failed to list daemon sessions on port ${daemon.state.httpPort}`);
  }
  return response.data.children
    .map((child) => (typeof child?.happySessionId === 'string' ? child.happySessionId.trim() : ''))
    .filter((value) => value.length > 0);
}

async function fetchSessionSnapshot(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<SessionSnapshotRow> {
  const response = await fetchJson<SessionSnapshotRow>(`${params.baseUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
    },
    timeoutMs: 5_000,
  });
  if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
    throw new Error(`Failed to fetch session snapshot ${params.sessionId}`);
  }
  return response.data;
}

function sessionChildEnv(params: Readonly<{
  homeDir: string;
  serverBaseUrl: string;
  fakeClaudePath: string;
  fakeClaudeLogPath: string;
  extraEnvironmentVariables?: Record<string, string> | undefined;
}>): Record<string, string> {
  return {
    HAPPIER_HOME_DIR: params.homeDir,
    HAPPIER_SERVER_URL: params.serverBaseUrl,
    HAPPIER_WEBAPP_URL: params.serverBaseUrl,
    HAPPIER_VARIANT: 'dev',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
    HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fakeClaudeLogPath,
    ...(params.extraEnvironmentVariables ?? {}),
  };
}

describe('core e2e: session handoff via direct peer', () => {
  let server: StartedServer | null = null;
  let sourceDaemon: StartedDaemon | null = null;
  let targetDaemon: StartedDaemon | null = null;
  let ui: SocketCollector | null = null;

  afterEach(async () => {
    ui?.close();
    ui = null;
    await targetDaemon?.stop().catch(() => {});
    targetDaemon = null;
    await sourceDaemon?.stop().catch(() => {});
    sourceDaemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    ui?.close();
    await targetDaemon?.stop().catch(() => {});
    await sourceDaemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('hands off a linked Claude direct session to a second online daemon over direct peer transport', async () => {
    const testDir = run.testDir('session-handoff-claude-direct-peer');
    const sourceDaemonDir = resolve(join(testDir, 'daemon-source'));
    const targetDaemonDir = resolve(join(testDir, 'daemon-target'));
    const sourceHomeDir = resolve(join(testDir, 'source-home'));
    const targetHomeDir = resolve(join(testDir, 'target-home'));
    const sourceWorkspaceDir = resolve(join(testDir, 'workspace-source'));
    const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
    const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-direct'));
    const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-direct.jsonl'));
    const targetClaudeConfigDir = resolve(join(testDir, 'target-claude-config'));
    const targetFakeClaudeLog = resolve(join(testDir, 'fake-claude-target.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();

    await mkdir(sourceHomeDir, { recursive: true });
    await mkdir(targetHomeDir, { recursive: true });
    await mkdir(sourceWorkspaceDir, { recursive: true });
    await mkdir(sourceClaudeProjectDir, { recursive: true });
    await mkdir(targetClaudeConfigDir, { recursive: true });
    await mkdir(sourceDaemonDir, { recursive: true });
    await mkdir(targetDaemonDir, { recursive: true });
    await writeFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'session handoff test\n', 'utf8');
    await writeFile(
      sourceClaudeSessionFile,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'handoff-u1',
          cwd: sourceWorkspaceDir,
          message: { content: 'hello from source direct session' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'handoff-a1',
          cwd: sourceWorkspaceDir,
          message: {
            model: 'claude-test',
            content: [{ type: 'text', text: 'source direct reply' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const sourceMachineKey = Uint8Array.from(randomBytes(32));
    const targetMachineKey = Uint8Array.from(randomBytes(32));
    const sourceSeed = await seedCliDataKeyAuthForServer({
      cliHome: sourceHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey: sourceMachineKey,
    });
    const targetSeed = await seedCliDataKeyAuthForServer({
      cliHome: targetHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey: targetMachineKey,
    });

    sourceDaemon = await startTestDaemon({
      testDir: sourceDaemonDir,
      happyHomeDir: sourceHomeDir,
      startupTimeoutMs: 90_000,
      env: {
        ...process.env,
        HOME: sourceHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: sourceHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
        HAPPIER_SESSION_HANDOFF_DIRECT_PEER_BIND_HOST: '127.0.0.1',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });
    targetDaemon = await startTestDaemon({
      testDir: targetDaemonDir,
      happyHomeDir: targetHomeDir,
      startupTimeoutMs: 90_000,
      env: {
        ...process.env,
        HOME: targetHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: targetHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_CLAUDE_CONFIG_DIR: targetClaudeConfigDir,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: targetFakeClaudeLog,
        HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
        HAPPIER_SESSION_HANDOFF_DIRECT_PEER_BIND_HOST: '127.0.0.1',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui?.isConnected() === true, {
      timeoutMs: 20_000,
      context: 'user-scoped socket connected for handoff e2e',
    });

    const sourceMachineRpc = createDataKeyRpcClient(ui, sourceMachineKey);
    const targetMachineRpc = createDataKeyRpcClient(ui, targetMachineKey);

    const machineIds = await waitForMachineIds({
      baseUrl: server.baseUrl,
      token: auth.token,
      count: 2,
      timeoutMs: 120_000,
    });
    expect(machineIds).toEqual(expect.arrayContaining([sourceSeed.machineId, targetSeed.machineId]));

    const linked = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
        machineId: sourceSeed.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-handoff-direct',
        directoryHint: sourceWorkspaceDir,
        titleHint: 'handoff direct session',
        source: {
          kind: 'claudeConfig',
          configDir: sourceClaudeConfigDir,
          projectId: 'proj-handoff-direct',
        },
      }),
      'source direct session link',
    ) as Readonly<{ ok: true; sessionId: string }>;
    const sessionId = linked.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing linked session id from direct session source');
    }

    const started = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
        sessionId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: targetSeed.machineId,
        sessionStorageMode: 'direct',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
      'source handoff start',
    ) as HandoffStartResult;

    expect(started).toEqual(expect.objectContaining({
      handoffId: expect.any(String),
      targetPath: expect.any(String),
      endpointCandidates: expect.any(Array),
    }));
    expect(started.providerBundle).toBeUndefined();
    expect(started.endpointCandidates.length).toBeGreaterThan(0);
    expect(started.endpointCandidates[0]?.url).toContain('127.0.0.1');
    await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
      timeoutMs: 30_000,
      intervalMs: 100,
      context: 'source daemon session removed immediately after direct-peer handoff start cutover',
    });

    const prepared = unwrapDataKeyRpcResult(
      await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET}`, {
        handoffId: started.handoffId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: targetSeed.machineId,
        negotiatedTransportStrategy: 'direct_peer',
        allowServerRoutedFallback: false,
        sourceSessionStorageMode: 'direct',
        targetPath: started.targetPath,
        endpointCandidates: started.endpointCandidates,
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
      'target handoff prepare',
    ) as HandoffPrepareResult;
    expect(prepared.status.transportStrategy).toBe('direct_peer');
    expect(prepared.resume.agent).toBe('claude');
    expect(prepared.resume.transcriptStorage).toBe('direct');
    const targetProjectId = prepared.resume.directory.replace(/[^a-zA-Z0-9-]/g, '-');
    const targetImportedTranscriptPath = resolve(
      join(targetClaudeConfigDir, 'projects', targetProjectId, 'sess-handoff-direct.jsonl'),
    );
    await expect(readFile(targetImportedTranscriptPath, 'utf8')).resolves.toContain('source direct reply');
    await expect(readFile(resolve(join(prepared.resume.directory, 'README.md')), 'utf8')).resolves.toBe('session handoff test\n');

    const targetSpawnResult = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: targetDaemon.state.httpPort,
      path: '/spawn-session',
      controlToken: targetDaemon.state.controlToken,
      body: {
        directory: prepared.resume.directory,
        agent: prepared.resume.agent,
        existingSessionId: sessionId,
        resume: prepared.resume.resume,
        transcriptStorage: prepared.resume.transcriptStorage,
        environmentVariables: sessionChildEnv({
          homeDir: targetHomeDir,
          serverBaseUrl: server.baseUrl,
          fakeClaudePath,
          fakeClaudeLogPath: targetFakeClaudeLog,
          extraEnvironmentVariables: prepared.resume.environmentVariables,
        }),
      },
      timeoutMs: 30_000,
    });
    expect(targetSpawnResult.status).toBe(200);
    expect(targetSpawnResult.data.success).toBe(true);
    expect(targetSpawnResult.data.sessionId).toBe(sessionId);

    const committed = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT}`, {
        handoffId: started.handoffId,
      }),
      'source handoff commit',
    ) as Readonly<{ status: Readonly<{ status: string; phase: string }> }>;

    expect(committed.status.status).toBe('completed');
    expect(committed.status.phase).toBe('finalizing');
    await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
      timeoutMs: 30_000,
      intervalMs: 100,
      context: 'source daemon session removed after handoff cutover',
    });
    await waitFor(async () => (await listDaemonSessions(targetDaemon!)).includes(sessionId) === true, {
      timeoutMs: 30_000,
      intervalMs: 100,
      context: 'target daemon session active after handoff resume',
    });
    await waitFor(async () => {
      const snapshot = await fetchSessionSnapshot({
        baseUrl: server!.baseUrl,
        token: auth.token,
        sessionId,
      });
      return snapshot.session?.active === true;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      context: 'server session active after handoff',
    });
  }, 180_000);

  it('does not let a late plaintext UI message execute on the source once direct-peer cutover has started', async () => {
    const testDir = run.testDir('session-handoff-direct-peer-late-message-cutover');
    const sourceDaemonDir = resolve(join(testDir, 'daemon-source'));
    const targetDaemonDir = resolve(join(testDir, 'daemon-target'));
    const sourceHomeDir = resolve(join(testDir, 'source-home'));
    const targetHomeDir = resolve(join(testDir, 'target-home'));
    const sourceWorkspaceDir = resolve(join(testDir, 'workspace-source'));
    const targetFakeClaudeLog = resolve(join(testDir, 'fake-claude-target.jsonl'));
    const sourceFakeClaudeLog = resolve(join(testDir, 'fake-claude-source.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();

    await mkdir(sourceHomeDir, { recursive: true });
    await mkdir(targetHomeDir, { recursive: true });
    await mkdir(sourceWorkspaceDir, { recursive: true });
    await mkdir(sourceDaemonDir, { recursive: true });
    await mkdir(targetDaemonDir, { recursive: true });
    await writeFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'late cutover proof\n', 'utf8');

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const sourceMachineKey = Uint8Array.from(randomBytes(32));
    const targetMachineKey = Uint8Array.from(randomBytes(32));
    const sourceSeed = await seedCliDataKeyAuthForServer({
      cliHome: sourceHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey: sourceMachineKey,
    });
    const targetSeed = await seedCliDataKeyAuthForServer({
      cliHome: targetHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey: targetMachineKey,
    });

    sourceDaemon = await startTestDaemon({
      testDir: sourceDaemonDir,
      happyHomeDir: sourceHomeDir,
      startupTimeoutMs: 90_000,
      env: {
        ...process.env,
        HOME: sourceHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: sourceHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: sourceFakeClaudeLog,
        HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
        HAPPIER_SESSION_HANDOFF_DIRECT_PEER_BIND_HOST: '127.0.0.1',
      },
    });
    targetDaemon = await startTestDaemon({
      testDir: targetDaemonDir,
      happyHomeDir: targetHomeDir,
      startupTimeoutMs: 90_000,
      env: {
        ...process.env,
        HOME: targetHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: targetHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: targetFakeClaudeLog,
        HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
        HAPPIER_SESSION_HANDOFF_DIRECT_PEER_BIND_HOST: '127.0.0.1',
      },
    });

    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui?.isConnected() === true, {
      timeoutMs: 20_000,
      context: 'user-scoped socket connected for late cutover proof',
    });

    const sourceMachineRpc = createDataKeyRpcClient(ui, sourceMachineKey);
    const targetMachineRpc = createDataKeyRpcClient(ui, targetMachineKey);

    const machineIds = await waitForMachineIds({
      baseUrl: server.baseUrl,
      token: auth.token,
      count: 2,
      timeoutMs: 120_000,
    });
    expect(machineIds).toEqual(expect.arrayContaining([sourceSeed.machineId, targetSeed.machineId]));

    const spawned = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: sourceDaemon.state.httpPort,
      path: '/spawn-session',
      controlToken: sourceDaemon.state.controlToken,
      body: {
        directory: sourceWorkspaceDir,
        terminal: { mode: 'plain' },
        environmentVariables: sessionChildEnv({
          homeDir: sourceHomeDir,
          serverBaseUrl: server.baseUrl,
          fakeClaudePath,
          fakeClaudeLogPath: sourceFakeClaudeLog,
        }),
      },
      timeoutMs: 30_000,
    });
    expect(spawned.status).toBe(200);
    expect(spawned.data.success).toBe(true);
    const sessionId = spawned.data.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from source daemon spawn-session');
    }

    const initialPrompt = 'before-cutover-direct-peer-proof';
    await postPlainUiTextMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      text: initialPrompt,
      localId: 'late-cutover-before-start',
    });
    await waitFor(() => fakeClaudeLogContainsUserText(sourceFakeClaudeLog, initialPrompt), {
      timeoutMs: 60_000,
      intervalMs: 200,
      context: 'source fake Claude receives the pre-cutover prompt',
    });

    const started = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
        sessionId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: targetSeed.machineId,
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
      }),
      'source handoff start for late cutover proof',
    ) as HandoffStartResult;

    await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
      timeoutMs: 30_000,
      intervalMs: 100,
      context: 'source daemon session removed before late prompt delivery proof',
    });

    const latePrompt = 'after-cutover-start-direct-peer-proof';
    await postPlainUiTextMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      text: latePrompt,
      localId: 'late-cutover-after-start',
    });

    await waitFor(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
      return (await fakeClaudeLogContainsUserText(sourceFakeClaudeLog, latePrompt)) === false;
    }, {
      timeoutMs: 5_000,
      intervalMs: 200,
      context: 'late prompt never reaches the stopped source session after cutover start',
    });

    const prepared = unwrapDataKeyRpcResult(
      await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET}`, {
        handoffId: started.handoffId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: targetSeed.machineId,
        negotiatedTransportStrategy: 'direct_peer',
        allowServerRoutedFallback: false,
        sourceSessionStorageMode: 'persisted',
        targetPath: started.targetPath,
        endpointCandidates: started.endpointCandidates,
      }),
      'target handoff prepare for late cutover proof',
    ) as HandoffPrepareResult;

    const targetSpawnResult = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: targetDaemon.state.httpPort,
      path: '/spawn-session',
      controlToken: targetDaemon.state.controlToken,
      body: {
        directory: prepared.resume.directory,
        agent: prepared.resume.agent,
        existingSessionId: sessionId,
        resume: prepared.resume.resume,
        transcriptStorage: prepared.resume.transcriptStorage,
        environmentVariables: sessionChildEnv({
          homeDir: targetHomeDir,
          serverBaseUrl: server.baseUrl,
          fakeClaudePath,
          fakeClaudeLogPath: targetFakeClaudeLog,
          extraEnvironmentVariables: prepared.resume.environmentVariables,
        }),
      },
      timeoutMs: 30_000,
    });
    expect(targetSpawnResult.status).toBe(200);
    expect(targetSpawnResult.data.success).toBe(true);
    expect(targetSpawnResult.data.sessionId).toBe(sessionId);

    const committed = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT}`, {
        handoffId: started.handoffId,
      }),
      'source handoff commit for late cutover proof',
    ) as Readonly<{ status: Readonly<{ status: string; phase: string }> }>;
    expect(committed.status.status).toBe('completed');

    await waitFor(() => fakeClaudeLogContainsUserText(targetFakeClaudeLog, latePrompt), {
      timeoutMs: 60_000,
      intervalMs: 200,
      context: 'late prompt reaches the resumed target session after cutover',
    });
    expect(await fakeClaudeLogContainsUserText(sourceFakeClaudeLog, latePrompt)).toBe(false);
  }, 240_000);

  it('rejects workspace transfer from a home-directory-backed direct session before exporting handoff bundles', async () => {
    const testDir = run.testDir('session-handoff-unsafe-home-workspace-transfer');
    const sourceDaemonDir = resolve(join(testDir, 'daemon-source'));
    const sourceHomeDir = resolve(join(testDir, 'source-home'));
    const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
    const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-home-root'));
    const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-home-root.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();

    await mkdir(sourceHomeDir, { recursive: true });
    await mkdir(sourceClaudeProjectDir, { recursive: true });
    await mkdir(sourceDaemonDir, { recursive: true });
    await writeFile(resolve(join(sourceHomeDir, 'README.md')), 'unsafe workspace transfer home-dir test\n', 'utf8');
    await writeFile(
      sourceClaudeSessionFile,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'handoff-home-u1',
          cwd: sourceHomeDir,
          message: { content: 'home directory session' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'handoff-home-a1',
          cwd: sourceHomeDir,
          message: {
            model: 'claude-test',
            content: [{ type: 'text', text: 'home directory reply' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const sourceMachineKey = Uint8Array.from(randomBytes(32));
    const sourceSeed = await seedCliDataKeyAuthForServer({
      cliHome: sourceHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey: sourceMachineKey,
    });

    sourceDaemon = await startTestDaemon({
      testDir: sourceDaemonDir,
      happyHomeDir: sourceHomeDir,
      startupTimeoutMs: 90_000,
      env: {
        ...process.env,
        HOME: sourceHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: sourceHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
        HAPPIER_SESSION_HANDOFF_DIRECT_PEER_BIND_HOST: '127.0.0.1',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui?.isConnected() === true, {
      timeoutMs: 20_000,
      context: 'user-scoped socket connected for unsafe workspace transfer handoff e2e',
    });

    const sourceMachineRpc = createDataKeyRpcClient(ui, sourceMachineKey);

    const machineIds = await waitForMachineIds({
      baseUrl: server.baseUrl,
      token: auth.token,
      count: 1,
      timeoutMs: 120_000,
    });
    expect(machineIds).toContain(sourceSeed.machineId);

    const linked = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
        machineId: sourceSeed.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-handoff-home-root',
        directoryHint: sourceHomeDir,
        titleHint: 'unsafe home workspace handoff session',
        source: {
          kind: 'claudeConfig',
          configDir: sourceClaudeConfigDir,
          projectId: 'proj-handoff-home-root',
        },
      }),
      'source direct session link for unsafe workspace transfer',
    ) as Readonly<{ ok: true; sessionId: string }>;
    const sessionId = linked.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing linked session id for unsafe workspace transfer source');
    }

    const started = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
        sessionId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: 'machine_target_unused',
        sessionStorageMode: 'direct',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
      'source handoff start for unsafe workspace transfer',
    ) as Readonly<{
      ok: false;
      errorCode: string;
      error: string;
      reasonCode: string;
    }>;

    expect(started).toEqual({
      ok: false,
      errorCode: 'unsafe_workspace_transfer_path',
      error: 'Workspace transfer is unavailable for this source path',
      reasonCode: 'path_is_home_directory',
    });
  }, 180_000);
});
