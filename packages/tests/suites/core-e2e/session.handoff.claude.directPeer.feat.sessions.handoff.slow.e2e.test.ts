import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  computeWorkspaceSyncPolicyDigest,
  SessionHandoffActionResultV1Schema,
  type SessionHandoffActionResultV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { fakeClaudeLogContainsUserText, postPlainUiTextMessage } from '../../src/testkit/sessionHandoffUiMessages';
import {
  fetchSessionMetadataV2,
} from '../../src/testkit/sessionHandoffMetadata';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, createMachineRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { activateLinkedDirectSession } from '../../src/testkit/directSessions/activateLinkedDirectSession';
import { resolveClaudeProjectId } from '../../src/testkit/claudeProjectId.cjs';
import { waitForDaemonSessionWebhookMarker } from '../../src/testkit/daemon/waitForDaemonSessionWebhookMarker';

const run = createRunDirs({ runLabel: 'core' });
const workspaceContentPolicyBase = {
  v: 1,
  selection: 'git_worktree',
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
} as const;
const workspaceContentPolicy = {
  ...workspaceContentPolicyBase,
  policyDigest: computeWorkspaceSyncPolicyDigest(workspaceContentPolicyBase),
};
const twoWayWorkspaceAction = {
  kind: 'create_relationship',
  mode: 'keep_both_in_sync',
  contentPolicy: workspaceContentPolicy,
  flushBeforeCommit: true,
} as const;

async function executeSessionHandoffAction(params: Readonly<{
  machineRpc: ReturnType<typeof createDataKeyRpcClient>;
  sourceMachineId: string;
  input: Record<string, unknown> & Readonly<{ accountServerId: string }>;
  context: string;
}>): Promise<SessionHandoffActionResultV1> {
  const raw = unwrapDataKeyRpcResult(
    await params.machineRpc.call(
      `${params.sourceMachineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`,
      params.input,
    ),
    params.context,
  );
  const parsed = SessionHandoffActionResultV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Expected current terminal session handoff Action result for ${params.context}`);
  }
  return parsed.data;
}

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

function requireAbsoluteWorkspaceRoot(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected absolute workspace root string for ${context}`);
  }
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(`Expected absolute workspace root for ${context}`);
  }
  return trimmed;
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
  }, 60_000);

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
    const targetWorkspaceDir = resolve(join(testDir, 'workspace-target'));
    const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
    const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-direct'));
    const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-direct.jsonl'));
    const targetClaudeConfigDir = resolve(join(targetHomeDir, '.claude'));
    const targetFakeClaudeLog = resolve(join(testDir, 'fake-claude-target.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();
    await mkdir(sourceHomeDir, { recursive: true });
    await mkdir(targetHomeDir, { recursive: true });
    await mkdir(sourceWorkspaceDir, { recursive: true });
    await mkdir(targetWorkspaceDir, { recursive: true });
    await mkdir(sourceClaudeProjectDir, { recursive: true });
    await mkdir(targetClaudeConfigDir, { recursive: true });
    await mkdir(sourceDaemonDir, { recursive: true });
    await mkdir(targetDaemonDir, { recursive: true });
    await writeFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'session handoff test\n', 'utf8');
    await writeFile(resolve(join(sourceWorkspaceDir, 'deleted-after-first-handoff.txt')), 'delete me after first handoff\n', 'utf8');
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

    const sourceSeed = await seedCliAuthForTestAccount({
      cliHome: sourceHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
    });
    const targetSeed = await seedCliAuthForTestAccount({
      cliHome: targetHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
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

    const sourceMachineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);
    const targetMachineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);

    const machineIds = await waitForMachineIds({
      baseUrl: server.baseUrl,
      token: auth.token,
      count: 2,
      timeoutMs: 120_000,
    });
    expect(machineIds).toEqual(expect.arrayContaining([sourceSeed.machineId, targetSeed.machineId]));

    const linked = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
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

    const started = await executeSessionHandoffAction({
      machineRpc: sourceMachineRpc,
      sourceMachineId: sourceSeed.machineId,
      input: {
        sessionId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: targetSeed.machineId,
        sessionStorageMode: 'direct',
        targetPath: targetWorkspaceDir,
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceAction: twoWayWorkspaceAction,
        accountServerId: sourceSeed.serverId,
      },
      context: 'source direct-peer session handoff Action',
    });
    expect(started.status).toEqual(expect.objectContaining({
      status: 'completed',
      transportStrategy: 'direct_peer',
    }));
    expect(started.workspace).toEqual(expect.objectContaining({
      kind: 'relationship',
      relationshipId: expect.any(String),
      created: true,
    }));
    if (started.workspace.kind !== 'relationship') {
      throw new Error('Expected direct-peer handoff to create a workspace relationship');
    }

    const targetMetadata = await fetchSessionMetadataV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      machineKeys: [auth.accountMachineKey],
    });
    const targetWorkspaceRootPath = requireAbsoluteWorkspaceRoot(targetMetadata.path, 'target Session metadata path');
    expect(targetWorkspaceRootPath).toBe(targetWorkspaceDir);
    const targetProjectId = resolveClaudeProjectId(targetWorkspaceRootPath);
    const targetImportedTranscriptPath = resolve(
      join(targetClaudeConfigDir, 'projects', targetProjectId, 'sess-handoff-direct.jsonl'),
    );
    await expect(readFile(targetImportedTranscriptPath, 'utf8')).resolves.toContain('source direct reply');
    await expect(readFile(resolve(join(targetWorkspaceRootPath, 'README.md')), 'utf8')).resolves.toBe('session handoff test\n');
    await expect(readFile(resolve(join(targetWorkspaceRootPath, 'deleted-after-first-handoff.txt')), 'utf8')).resolves.toBe(
      'delete me after first handoff\n',
    );
    await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
      timeoutMs: 90_000,
      intervalMs: 100,
      context: 'source daemon session removed after handoff cutover',
    });
    await waitFor(async () => (await listDaemonSessions(targetDaemon!)).includes(sessionId) === true, {
      timeoutMs: 90_000,
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
    expect(targetMetadata).toEqual(expect.objectContaining({
      machineId: targetSeed.machineId,
      path: targetWorkspaceRootPath,
      flavor: 'claude',
      claudeSessionId: expect.any(String),
      directSessionV1: expect.objectContaining({
        providerId: 'claude',
        machineId: targetSeed.machineId,
        remoteSessionId: expect.any(String),
      }),
    }));
    expect(targetMetadata.claudeTranscriptPath).toBeUndefined();
    expect(targetMetadata.externalHistoryImportV1).toBeUndefined();
    expect(
      (targetMetadata.directSessionV1 as Readonly<{ remoteSessionId?: unknown }> | undefined)?.remoteSessionId,
    ).toBe(targetMetadata.claudeSessionId);

    await writeFile(resolve(join(targetWorkspaceRootPath, 'README.md')), 'session handoff test after second pass\n', 'utf8');
    await writeFile(resolve(join(targetWorkspaceRootPath, 'added-after-first-handoff.txt')), 'added after first handoff\n', 'utf8');
    await rm(resolve(join(targetWorkspaceRootPath, 'deleted-after-first-handoff.txt')));
    await waitForDaemonSessionWebhookMarker({
      happyHomeDir: targetHomeDir,
      sessionId,
      machineId: targetSeed.machineId,
    });

    const secondStarted = await executeSessionHandoffAction({
      machineRpc: targetMachineRpc,
      sourceMachineId: targetSeed.machineId,
      input: {
        sessionId,
        sourceMachineId: targetSeed.machineId,
        targetMachineId: sourceSeed.machineId,
        sessionStorageMode: 'direct',
        targetPath: sourceWorkspaceDir,
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceAction: {
          kind: 'relationship',
          relationshipId: started.workspace.relationshipId,
          flushBeforeCommit: true,
        },
        accountServerId: targetSeed.serverId,
      },
      context: 'target direct-peer session handoff-back Action',
    });
    expect(secondStarted.handoffId).not.toBe(started.handoffId);
    expect(secondStarted.status).toEqual(expect.objectContaining({
      status: 'completed',
      transportStrategy: 'direct_peer',
    }));
    expect(secondStarted.workspace).toEqual(expect.objectContaining({
      kind: 'relationship',
      relationshipId: started.workspace.relationshipId,
      created: false,
    }));

    await waitFor(async () => (await listDaemonSessions(targetDaemon!)).includes(sessionId) === false, {
      timeoutMs: 30_000,
      intervalMs: 100,
      context: 'target daemon session removed after handoff-back cutover',
    });
    await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === true, {
      timeoutMs: 30_000,
      intervalMs: 100,
      context: 'source daemon session active after handoff-back resume',
    });
    await expect(readFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'utf8')).resolves.toBe(
      'session handoff test after second pass\n',
    );
    await expect(readFile(resolve(join(sourceWorkspaceDir, 'added-after-first-handoff.txt')), 'utf8')).resolves.toBe(
      'added after first handoff\n',
    );
    await expect(readFile(resolve(join(sourceWorkspaceDir, 'deleted-after-first-handoff.txt')), 'utf8')).rejects.toThrow();
  }, 420_000);

  it('does not let a late plaintext UI message execute on the source once direct-peer cutover has started', async () => {
    const testDir = run.testDir('session-handoff-direct-peer-late-message-cutover');
    const sourceDaemonDir = resolve(join(testDir, 'daemon-source'));
    const targetDaemonDir = resolve(join(testDir, 'daemon-target'));
    const sourceHomeDir = resolve(join(testDir, 'source-home'));
    const targetHomeDir = resolve(join(testDir, 'target-home'));
    const sourceWorkspaceDir = resolve(join(testDir, 'workspace-source'));
    const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
    const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-direct-late'));
    const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-direct-late.jsonl'));
    const targetClaudeConfigDir = resolve(join(targetHomeDir, '.claude'));
    const targetFakeClaudeLog = resolve(join(testDir, 'fake-claude-target.jsonl'));
    const sourceFakeClaudeLog = resolve(join(testDir, 'fake-claude-source.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();

    await mkdir(sourceHomeDir, { recursive: true });
    await mkdir(targetHomeDir, { recursive: true });
    await mkdir(sourceWorkspaceDir, { recursive: true });
    await mkdir(sourceClaudeProjectDir, { recursive: true });
    await mkdir(targetClaudeConfigDir, { recursive: true });
    await mkdir(sourceDaemonDir, { recursive: true });
    await mkdir(targetDaemonDir, { recursive: true });
    await writeFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'late cutover proof\n', 'utf8');
    await writeFile(
      sourceClaudeSessionFile,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'handoff-direct-late-u1',
          cwd: sourceWorkspaceDir,
          message: { content: 'hello from source direct late session' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'handoff-direct-late-a1',
          cwd: sourceWorkspaceDir,
          message: {
            model: 'claude-test',
            content: [{ type: 'text', text: 'source direct late reply' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const sourceSeed = await seedCliAuthForTestAccount({
      cliHome: sourceHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
    });
    const targetSeed = await seedCliAuthForTestAccount({
      cliHome: targetHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
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
        HAPPIER_E2E_FAKE_CLAUDE_LOG: sourceFakeClaudeLog,
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
      context: 'user-scoped socket connected for late cutover proof',
    });

    const sourceMachineRpc = createMachineRpcClient(ui, { mode: 'plain' });

    const machineIds = await waitForMachineIds({
      baseUrl: server.baseUrl,
      token: auth.token,
      count: 2,
      timeoutMs: 120_000,
    });
    expect(machineIds).toEqual(expect.arrayContaining([sourceSeed.machineId, targetSeed.machineId]));

    const sourceDirectSessionSource = {
      kind: 'claudeConfig',
      configDir: sourceClaudeConfigDir,
      projectId: 'proj-handoff-direct-late',
    } as const;
    const linked = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
        machineId: sourceSeed.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-handoff-direct-late',
        directoryHint: sourceWorkspaceDir,
        titleHint: 'handoff direct late session',
        source: sourceDirectSessionSource,
      }),
      'source direct session link for late cutover direct-peer handoff',
    ) as Readonly<{ ok: true; sessionId: string }>;
    const sessionId = linked.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing linked session id from late cutover direct session source');
    }
    await activateLinkedDirectSession({
      machineRpc: sourceMachineRpc,
      machineId: sourceSeed.machineId,
      sessionId,
      providerId: 'claude',
      remoteSessionId: 'sess-handoff-direct-late',
      source: sourceDirectSessionSource,
      context: 'late cutover direct-peer source activation',
    });
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

    const handoffResultPromise = executeSessionHandoffAction({
      machineRpc: sourceMachineRpc,
      sourceMachineId: sourceSeed.machineId,
      input: {
        sessionId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: targetSeed.machineId,
        sessionStorageMode: 'direct',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        accountServerId: sourceSeed.serverId,
      },
      context: 'source direct-peer handoff Action for late cutover proof',
    });

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

    const completed = await handoffResultPromise;
    expect(completed.status).toEqual(expect.objectContaining({ status: 'completed' }));

    await waitFor(() => fakeClaudeLogContainsUserText(targetFakeClaudeLog, latePrompt), {
      timeoutMs: 120_000,
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

    const sourceSeed = await seedCliAuthForTestAccount({
      cliHome: sourceHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
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

    const sourceMachineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);

    const machineIds = await waitForMachineIds({
      baseUrl: server.baseUrl,
      token: auth.token,
      count: 1,
      timeoutMs: 120_000,
    });
    expect(machineIds).toContain(sourceSeed.machineId);

    const linked = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
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
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`, {
        sessionId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: 'machine_target_unused',
        sessionStorageMode: 'direct',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceAction: { kind: 'copy_once', contentPolicy: workspaceContentPolicy },
        accountServerId: sourceSeed.serverId,
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
