import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { normalizeSpawnSessionRequestBody } from '../../src/testkit/daemon/normalizeSpawnSessionRequestBody';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { fakeClaudeLogContainsUserText, postPlainUiTextMessage } from '../../src/testkit/sessionHandoffUiMessages';
import {
  fetchSessionMetadataV2,
  patchSessionHandoffMetadataV1,
  resolveSessionHandoffBackTargetRootPath,
} from '../../src/testkit/sessionHandoffMetadata';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { activateLinkedDirectSession } from '../../src/testkit/directSessions/activateLinkedDirectSession';
// @ts-expect-error - This CJS helper is consumed directly by the runtime test fixture.
import { resolveClaudeProjectId } from '../../src/testkit/claudeProjectId.cjs';
import { waitForDaemonSessionWebhookMarker } from '../../src/testkit/daemon/waitForDaemonSessionWebhookMarker';

const run = createRunDirs({ runLabel: 'core' });

type HandoffStartResult = Readonly<{
  handoffId: string;
  endpointCandidates: readonly Readonly<{ kind: string; url: string; expiresAt: number }>[];
  targetPath: string;
  handoffMetadataV2?: unknown;
  agentBundle?: unknown;
}>;

type HandoffStartResponse = HandoffStartResult | Readonly<{ ok: false; error?: unknown; errorCode?: unknown }>;

type HandoffPrepareResult = Readonly<{
  handoffId: string;
  status: Readonly<{
    handoffId: string;
    status: string;
    phase: string;
    jobId?: string;
    transportStrategy?: 'direct_peer' | 'server_routed_stream';
    progress?: Readonly<{
      checkpoint: string;
      planned: Readonly<{
        totalFiles?: number;
        totalBytes?: number;
        added?: number;
        changed?: number;
        removed?: number;
      }>;
      transferred: Readonly<{
        files?: number;
        bytes?: number;
        blobs?: number;
      }>;
      current?: Readonly<{
        relativePath?: string;
        digest?: string;
        phaseDetail?: string;
      }>;
    }>;
    workspacePreflightSummary?: Readonly<{
      addedPathsCount: number;
      changedPathsCount: number;
      removedPathsCount: number;
      totalBytes?: number;
    }>;
  }>;
  resume?: Readonly<{
    directory: string;
    agent: 'claude' | 'codex' | 'opencode';
    resume: string;
    transcriptStorage: 'persisted' | 'direct';
    approvedNewDirectoryCreation: true;
    environmentVariables?: Record<string, string>;
  }>;
}>;

type HandoffStatusResult = Readonly<{
  handoffId: string;
  status: Readonly<{
    handoffId: string;
    status: string;
    phase: string;
    jobId?: string;
    transportStrategy?: 'direct_peer' | 'server_routed_stream';
    lastErrorMessage?: string;
  }>;
}>;

function requirePreparedResume(
  result: HandoffPrepareResult,
  context: string,
): NonNullable<HandoffPrepareResult['resume']> {
  if (!result.resume) {
    throw new Error(`Missing resume payload for ${context}`);
  }
  return result.resume;
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

async function waitForReadyHandoffPrepareResult(params: Readonly<{
  machineRpc: ReturnType<typeof createDataKeyRpcClient>;
  machineId: string;
  handoffId: string;
  initialResult: HandoffPrepareResult;
  context: string;
}>): Promise<HandoffPrepareResult> {
  const readInnerRpcErrorCode = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const candidate = value as { ok?: unknown; errorCode?: unknown; error?: unknown };
    if (candidate.ok !== false) {
      return null;
    }
    if (typeof candidate.errorCode === 'string' && candidate.errorCode.trim().length > 0) {
      return candidate.errorCode;
    }
    if (typeof candidate.error === 'string' && candidate.error.trim().length > 0) {
      return candidate.error;
    }
    return 'rpc_failed';
  };

  if (params.initialResult.resume && params.initialResult.status.status === 'ready_for_cutover') {
    return params.initialResult;
  }

  let readyResult: HandoffPrepareResult | null = null;
  await waitFor(async () => {
    const polledRaw = unwrapDataKeyRpcResult(
      await params.machineRpc.call(`${params.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET}`, {
        handoffId: params.handoffId,
      }),
      `${params.context} result get`,
    );
    const polledErrorCode = readInnerRpcErrorCode(polledRaw);
    const status = unwrapDataKeyRpcResult(
      await params.machineRpc.call(`${params.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET}`, {
        handoffId: params.handoffId,
      }),
      `${params.context} status get`,
    ) as HandoffStatusResult;
    if (polledErrorCode && polledErrorCode !== 'not_found' && polledErrorCode !== 'awaiting_recovery') {
      const lastError = typeof status.status.lastErrorMessage === 'string' && status.status.lastErrorMessage.trim().length > 0
        ? `; lastErrorMessage: ${status.status.lastErrorMessage}`
        : '';
      throw new Error(`${params.context} result get failed: ${polledErrorCode}${lastError}`);
    }
    if (status.status.status === 'failed' || status.status.status === 'aborted') {
      const lastError = typeof status.status.lastErrorMessage === 'string' && status.status.lastErrorMessage.trim().length > 0
        ? `; lastErrorMessage: ${status.status.lastErrorMessage}`
        : '';
      throw new Error(`${params.context} entered terminal status ${status.status.status}${lastError}`);
    }

    const polled = polledErrorCode ? null : polledRaw as HandoffPrepareResult;
    if (polled && polled.resume && polled.status.status === 'ready_for_cutover') {
      readyResult = polled;
      return true;
    }
    return false;
  }, {
    timeoutMs: 30_000,
    intervalMs: 100,
    context: `${params.context} ready for cutover`,
  });

  if (!readyResult) {
    throw new Error(`Expected ready handoff prepare result for ${params.handoffId}`);
  }

  return readyResult;
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

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object for ${context}`);
  }
  return value as Record<string, unknown>;
}

function requireHandoffMetadataV2(result: HandoffStartResult, context: string): Record<string, unknown> {
  return requireObject(result.handoffMetadataV2, `handoffMetadataV2 for ${context}`);
}

function requireAbsoluteWorkspaceRoot(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected absolute workspace root string for ${context}`);
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(`Expected absolute workspace root for ${context}`);
  }
  return trimmed;
}

function requireHandoffStartOk(result: HandoffStartResponse, context: string): HandoffStartResult {
  if ((result as any)?.ok === false) {
    const errorCode = typeof (result as any).errorCode === 'string' ? (result as any).errorCode : '';
    const error = typeof (result as any).error === 'string' ? (result as any).error : '';
    throw new Error(`${context} failed: ${errorCode || error || 'unknown-error'}`);
  }
  return result as HandoffStartResult;
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
    const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
    const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-direct'));
    const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-direct.jsonl'));
    const targetClaudeConfigDir = resolve(join(targetHomeDir, '.claude'));
    const sourceFakeClaudeLog = resolve(join(testDir, 'fake-claude-source.jsonl'));
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

    const started = requireHandoffStartOk(unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
        sessionId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: targetSeed.machineId,
        sessionStorageMode: 'direct',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer: {
          enabled: true,
          strategy: 'transfer_snapshot',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
      'source handoff start',
    ) as HandoffStartResponse, 'source handoff start');

    expect(started).toEqual(expect.objectContaining({
      handoffId: expect.any(String),
      targetPath: expect.any(String),
      endpointCandidates: expect.any(Array),
    }));
    expect(started.agentBundle).toBeUndefined();
    const handoffMetadataV2 = requireHandoffMetadataV2(started, 'source handoff start');
    expect(requireObject(handoffMetadataV2.agentBundleTransferPublication, 'agentBundleTransferPublication')).toEqual(expect.objectContaining({
      transferId: expect.any(String),
      sizeBytes: expect.any(Number),
      manifestHash: expect.any(String),
    }));
    expect(requireObject(handoffMetadataV2.workspaceReplicationManifestTransferPublication, 'workspaceReplicationManifestTransferPublication')).toEqual(expect.objectContaining({
      transferId: expect.any(String),
    }));
    await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
      timeoutMs: 90_000,
      intervalMs: 100,
      context: 'source daemon session removed immediately after direct-peer handoff start cutover',
    });

    const prepared = await waitForReadyHandoffPrepareResult({
      machineRpc: targetMachineRpc,
      machineId: targetSeed.machineId,
      handoffId: started.handoffId,
      initialResult: unwrapDataKeyRpcResult(
        await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET}`, {
          handoffId: started.handoffId,
          sourceMachineId: sourceSeed.machineId,
          targetMachineId: targetSeed.machineId,
          negotiatedTransportStrategy: 'direct_peer',
          allowServerRoutedFallback: false,
          sourceSessionStorageMode: 'direct',
          targetPath: started.targetPath,
          endpointCandidates: started.endpointCandidates,
          handoffMetadataV2,
          workspaceTransfer: {
            enabled: true,
            strategy: 'transfer_snapshot',
            conflictPolicy: 'replace_existing',
            includeIgnoredMode: 'exclude',
            ignoredIncludeGlobs: [],
          },
        }),
        'target handoff prepare',
      ) as HandoffPrepareResult,
      context: 'target handoff prepare',
    });
    const preparedResume = requirePreparedResume(prepared, 'target handoff prepare');
    expect(prepared.status.transportStrategy).toBe('direct_peer');
    expect(preparedResume.agent).toBe('claude');
    expect(preparedResume.transcriptStorage).toBe('direct');
    const targetProjectId = resolveClaudeProjectId(preparedResume.directory);
    const targetImportedTranscriptPath = resolve(
      join(targetClaudeConfigDir, 'projects', targetProjectId, 'sess-handoff-direct.jsonl'),
    );
    await expect(readFile(targetImportedTranscriptPath, 'utf8')).resolves.toContain('source direct reply');
    await expect(readFile(resolve(join(preparedResume.directory, 'README.md')), 'utf8')).resolves.toBe('session handoff test\n');
    await expect(readFile(resolve(join(preparedResume.directory, 'deleted-after-first-handoff.txt')), 'utf8')).resolves.toBe(
      'delete me after first handoff\n',
    );

    const targetSpawnResult = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: targetDaemon.state.httpPort,
      path: '/spawn-session',
      controlToken: targetDaemon.state.controlToken,
      body: normalizeSpawnSessionRequestBody({
        directory: preparedResume.directory,
        agent: preparedResume.agent,
        existingSessionId: sessionId,
        resume: preparedResume.resume,
        transcriptStorage: preparedResume.transcriptStorage,
        environmentVariables: sessionChildEnv({
          homeDir: targetHomeDir,
          serverBaseUrl: server.baseUrl,
          fakeClaudePath,
          fakeClaudeLogPath: targetFakeClaudeLog,
          extraEnvironmentVariables: preparedResume.environmentVariables,
        }),
      }),
      timeoutMs: 90_000,
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
    const originalSourceWorkspaceRootPath = requireAbsoluteWorkspaceRoot(
      handoffMetadataV2.workspaceReplicationSourceRootPath,
      'source handoff start workspaceReplicationSourceRootPath',
    );
    await patchSessionHandoffMetadataV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      machineKeys: [targetMachineKey, sourceMachineKey],
      providerId: 'claude',
      sourceMachineId: sourceSeed.machineId,
      targetMachineId: targetSeed.machineId,
      sourceWorkspaceRootPath: originalSourceWorkspaceRootPath,
      targetWorkspaceRootPath: preparedResume.directory,
      sessionStorageBefore: 'direct',
      sessionStorageAfter: 'direct',
      transportStrategy: 'direct_peer',
    });

    const patchedMetadata = await fetchSessionMetadataV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      machineKeys: [targetMachineKey, sourceMachineKey],
    });
    expect(patchedMetadata).toEqual(expect.objectContaining({
      machineId: targetSeed.machineId,
      path: preparedResume.directory,
      flavor: 'claude',
      claudeSessionId: expect.any(String),
      directSessionV1: expect.objectContaining({
        providerId: 'claude',
        machineId: targetSeed.machineId,
        remoteSessionId: expect.any(String),
      }),
      handoffV1: expect.objectContaining({
        transportStrategy: 'direct_peer',
      }),
    }));
    expect(patchedMetadata.claudeTranscriptPath).toBeUndefined();
    expect(patchedMetadata.externalHistoryImportV1).toBeUndefined();
    expect(
      (patchedMetadata.directSessionV1 as Readonly<{ remoteSessionId?: unknown }> | undefined)?.remoteSessionId,
    ).toBe(patchedMetadata.claudeSessionId);

    // Persist the reverse-direction baseline so the handoff-back round can use `sync_changes`
    // rather than forcing a fresh snapshot export.
    unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT}`, {
        handoffId: started.handoffId,
        mode: 'source_cleanup',
        workspaceReplicationReverseSourceRootPath: preparedResume.directory,
        workspaceReplicationReverseTargetRootPath: originalSourceWorkspaceRootPath,
      }),
      'source handoff source cleanup',
    );
    await writeFile(resolve(join(preparedResume.directory, 'README.md')), 'session handoff test after second pass\n', 'utf8');
    await writeFile(resolve(join(preparedResume.directory, 'added-after-first-handoff.txt')), 'added after first handoff\n', 'utf8');
    await rm(resolve(join(preparedResume.directory, 'deleted-after-first-handoff.txt')));
    await waitForDaemonSessionWebhookMarker({
      happyHomeDir: targetHomeDir,
      sessionId,
      machineId: targetSeed.machineId,
    });

    const secondStarted = requireHandoffStartOk(unwrapDataKeyRpcResult(
      await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
        sessionId,
        sourceMachineId: targetSeed.machineId,
        targetMachineId: sourceSeed.machineId,
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
      'target handoff-back start',
    ) as HandoffStartResponse, 'target handoff-back start');
    expect(secondStarted.handoffId).not.toBe(started.handoffId);
    const secondHandoffMetadataV2 = requireHandoffMetadataV2(secondStarted, 'target handoff-back start');
    expect(requireObject(secondHandoffMetadataV2.agentBundleTransferPublication, 'agentBundleTransferPublication')).toEqual(expect.objectContaining({
      transferId: expect.any(String),
      sizeBytes: expect.any(Number),
      manifestHash: expect.any(String),
    }));
    const secondHandoffBackTargetRootPath = requireAbsoluteWorkspaceRoot(
      resolveSessionHandoffBackTargetRootPath({
        metadata: patchedMetadata,
        requestedTargetMachineId: sourceSeed.machineId,
      }),
      'target handoff-back start resolved workspaceReplicationHandoffBackTargetRootPath',
    );
    expect(secondHandoffBackTargetRootPath).toBe(originalSourceWorkspaceRootPath);
    expect(requireObject(secondHandoffMetadataV2.workspaceReplicationManifestTransferPublication, 'workspaceReplicationManifestTransferPublication')).toEqual(expect.objectContaining({
      transferId: expect.any(String),
    }));
    const secondPrepared = await waitForReadyHandoffPrepareResult({
      machineRpc: sourceMachineRpc,
      machineId: sourceSeed.machineId,
      handoffId: secondStarted.handoffId,
      initialResult: unwrapDataKeyRpcResult(
        await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET}`, {
          handoffId: secondStarted.handoffId,
          sourceMachineId: targetSeed.machineId,
          targetMachineId: sourceSeed.machineId,
          negotiatedTransportStrategy: 'direct_peer',
          // The handoff-back round still prefers direct peer, but it must be able to recover
          // through the server-routed channel when the peer is not immediately reachable.
          allowServerRoutedFallback: true,
          sourceSessionStorageMode: 'direct',
          targetPath: secondHandoffBackTargetRootPath,
          endpointCandidates: secondStarted.endpointCandidates,
          handoffMetadataV2: secondHandoffMetadataV2,
          workspaceTransfer: {
            enabled: true,
            strategy: 'sync_changes',
            conflictPolicy: 'replace_existing',
            includeIgnoredMode: 'exclude',
            ignoredIncludeGlobs: [],
          },
        }),
        'source handoff-back prepare',
      ) as HandoffPrepareResult,
      context: 'source handoff-back prepare',
    });
    const secondPreparedResume = requirePreparedResume(secondPrepared, 'source handoff-back prepare');
    expect(secondPrepared.status.workspacePreflightSummary).toEqual(expect.objectContaining({
      addedPathsCount: expect.any(Number),
      changedPathsCount: expect.any(Number),
      removedPathsCount: expect.any(Number),
      totalBytes: expect.any(Number),
    }));
    expect(secondPrepared.status.progress).toEqual(expect.objectContaining({
      checkpoint: 'import_session',
      planned: expect.objectContaining({
        totalFiles: expect.any(Number),
        added: expect.any(Number),
        changed: expect.any(Number),
        removed: expect.any(Number),
      }),
      transferred: expect.objectContaining({
        files: expect.any(Number),
        bytes: expect.any(Number),
      }),
      current: expect.objectContaining({
        phaseDetail: 'ready_for_cutover',
      }),
    }));

    const sourceRespawnResult = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: sourceDaemon.state.httpPort,
      path: '/spawn-session',
      controlToken: sourceDaemon.state.controlToken,
      body: normalizeSpawnSessionRequestBody({
        directory: secondPreparedResume.directory,
        agent: secondPreparedResume.agent,
        existingSessionId: sessionId,
        resume: secondPreparedResume.resume,
        transcriptStorage: secondPreparedResume.transcriptStorage,
        environmentVariables: sessionChildEnv({
          homeDir: sourceHomeDir,
          serverBaseUrl: server.baseUrl,
          fakeClaudePath,
          fakeClaudeLogPath: sourceFakeClaudeLog,
          extraEnvironmentVariables: secondPreparedResume.environmentVariables,
        }),
      }),
      timeoutMs: 30_000,
    });
    expect(sourceRespawnResult.status).toBe(200);
    expect(sourceRespawnResult.data.success).toBe(true);
    expect(sourceRespawnResult.data.sessionId).toBe(sessionId);
    await waitForDaemonSessionWebhookMarker({
      happyHomeDir: sourceHomeDir,
      sessionId,
      machineId: sourceSeed.machineId,
    });
    const secondCommitted = unwrapDataKeyRpcResult(
      await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT}`, {
        handoffId: secondStarted.handoffId,
      }),
      'target handoff-back commit',
    ) as Readonly<{ status: Readonly<{ status: string; phase: string }> }>;
    expect(secondCommitted.status.status).toBe('completed');

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
    await expect(readFile(resolve(join(secondPreparedResume.directory, 'README.md')), 'utf8')).resolves.toBe(
      'session handoff test after second pass\n',
    );
    await expect(readFile(resolve(join(secondPreparedResume.directory, 'added-after-first-handoff.txt')), 'utf8')).resolves.toBe(
      'added after first handoff\n',
    );
    await expect(readFile(resolve(join(secondPreparedResume.directory, 'deleted-after-first-handoff.txt')), 'utf8')).rejects.toThrow();
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

    const sourceMachineRpc = createDataKeyRpcClient(ui, sourceMachineKey);
    const targetMachineRpc = createDataKeyRpcClient(ui, targetMachineKey);

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

    const started = unwrapDataKeyRpcResult(
      await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
        sessionId,
        sourceMachineId: sourceSeed.machineId,
        targetMachineId: targetSeed.machineId,
        sessionStorageMode: 'direct',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
      }),
      'source handoff start for late cutover proof',
    ) as HandoffStartResult;
    const lateCutoverMetadataV2 = requireHandoffMetadataV2(started, 'source handoff start for late cutover proof');
    expect(requireObject(lateCutoverMetadataV2.agentBundleTransferPublication, 'agentBundleTransferPublication')).toEqual(expect.objectContaining({
      transferId: expect.any(String),
      sizeBytes: expect.any(Number),
      manifestHash: expect.any(String),
    }));

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

    const prepared = await waitForReadyHandoffPrepareResult({
      machineRpc: targetMachineRpc,
      machineId: targetSeed.machineId,
      handoffId: started.handoffId,
      initialResult: unwrapDataKeyRpcResult(
        await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET}`, {
          handoffId: started.handoffId,
          sourceMachineId: sourceSeed.machineId,
          targetMachineId: targetSeed.machineId,
          negotiatedTransportStrategy: 'direct_peer',
          allowServerRoutedFallback: false,
          sourceSessionStorageMode: 'direct',
          targetPath: started.targetPath,
          endpointCandidates: started.endpointCandidates,
          handoffMetadataV2: lateCutoverMetadataV2,
        }),
        'target handoff prepare for late cutover proof',
      ) as HandoffPrepareResult,
      context: 'target handoff prepare for late cutover proof',
    });
    const lateCutoverPreparedResume = requirePreparedResume(prepared, 'target handoff prepare for late cutover proof');

    const targetSpawnResult = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: targetDaemon.state.httpPort,
      path: '/spawn-session',
      controlToken: targetDaemon.state.controlToken,
      body: normalizeSpawnSessionRequestBody({
        directory: lateCutoverPreparedResume.directory,
        agent: lateCutoverPreparedResume.agent,
        existingSessionId: sessionId,
        resume: lateCutoverPreparedResume.resume,
        transcriptStorage: lateCutoverPreparedResume.transcriptStorage,
        environmentVariables: sessionChildEnv({
          homeDir: targetHomeDir,
          serverBaseUrl: server.baseUrl,
          fakeClaudePath,
          fakeClaudeLogPath: targetFakeClaudeLog,
          extraEnvironmentVariables: lateCutoverPreparedResume.environmentVariables,
        }),
      }),
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
