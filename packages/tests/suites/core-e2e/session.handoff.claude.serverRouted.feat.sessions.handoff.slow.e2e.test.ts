import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
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

type HandoffPrepareRpcResponse = HandoffPrepareResult | Readonly<{ ok: false; error?: unknown; errorCode?: unknown }>;

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

function requireObject(value: unknown, context: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Expected object for ${context}`);
    }
    return value as Record<string, unknown>;
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

function expectAgentBundleTransferPublicationMaybe(value: unknown): void {
    if (value === undefined) return;
    expect(requireObject(value, 'agentBundleTransferPublication')).toEqual(expect.objectContaining({
        transferId: expect.any(String),
        sizeBytes: expect.any(Number),
        manifestHash: expect.any(String),
    }));
}

function requireHandoffMetadataV2(result: HandoffStartResult, context: string): Record<string, unknown> {
    return requireObject(result.handoffMetadataV2, `handoffMetadataV2 for ${context}`);
}

function readRpcFailureCode(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as { ok?: unknown; errorCode?: unknown; error?: unknown };
    if (candidate.ok !== false) return null;
    if (typeof candidate.errorCode === 'string' && candidate.errorCode.trim().length > 0) return candidate.errorCode;
    if (typeof candidate.error === 'string' && candidate.error.trim().length > 0) return candidate.error;
    return 'rpc_failed';
}

async function waitForPrepareTargetAccepted(params: Readonly<{
    machineRpc: ReturnType<typeof createDataKeyRpcClient>;
    machineId: string;
    payload: Record<string, unknown>;
    context: string;
    timeoutMs?: number;
}>): Promise<HandoffPrepareResult> {
    let accepted: HandoffPrepareResult | null = null;
    await waitFor(async () => {
        const raw = unwrapDataKeyRpcResult(
            await params.machineRpc.call(`${params.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET}`, params.payload),
            params.context,
        ) as HandoffPrepareRpcResponse;
        const errorCode = readRpcFailureCode(raw);
        if (!errorCode) {
            accepted = raw as HandoffPrepareResult;
            return true;
        }
        if (errorCode === 'not_found') return false;
        throw new Error(`${params.context} failed: ${errorCode}`);
    }, {
        timeoutMs: params.timeoutMs ?? 90_000,
        intervalMs: 250,
        context: `${params.context} accepted`,
    });
    if (!accepted) {
        throw new Error(`Expected accepted prepare-target response for ${params.context}`);
    }
    return accepted;
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

function buildBulkFixturePayload(index: number): string {
    return `bulk fixture ${index}\n${'x'.repeat(4096)}\n`;
}

describe('core e2e: session handoff via server-routed transfer', () => {
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

    it('hands off a linked Claude direct session to a second online daemon over forced server-routed transfer', async () => {
        const testDir = run.testDir('session-handoff-claude-server-routed');
        const sourceDaemonDir = resolve(join(testDir, 'daemon-source'));
        const targetDaemonDir = resolve(join(testDir, 'daemon-target'));
        const sourceHomeDir = resolve(join(testDir, 'source-home'));
        const targetHomeDir = resolve(join(testDir, 'target-home'));
        const sourceWorkspaceDir = resolve(join(testDir, 'workspace-source'));
        const targetWorkspaceDir = resolve(join(testDir, 'workspace-target'));
        const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
        const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-server-routed'));
        const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-server-routed.jsonl'));
        const targetClaudeConfigDir = resolve(join(targetHomeDir, '.claude'));
        const sourceFakeClaudeLog = resolve(join(testDir, 'fake-claude-source.jsonl'));
        const targetFakeClaudeLog = resolve(join(testDir, 'fake-claude-target.jsonl'));
        const fakeClaudePath = fakeClaudeFixturePath();
        await mkdir(sourceHomeDir, { recursive: true });
        await mkdir(targetHomeDir, { recursive: true });
        await mkdir(sourceWorkspaceDir, { recursive: true });
        await mkdir(targetWorkspaceDir, { recursive: true });
        await mkdir(resolve(join(sourceWorkspaceDir, 'bulk')), { recursive: true });
        await mkdir(sourceClaudeProjectDir, { recursive: true });
        await mkdir(targetClaudeConfigDir, { recursive: true });
        await mkdir(sourceDaemonDir, { recursive: true });
        await mkdir(targetDaemonDir, { recursive: true });
        const fullWorkspaceTransferBytes =
            Buffer.byteLength('server routed session handoff test\n', 'utf8')
            + Buffer.byteLength('delete me after first handoff\n', 'utf8')
            + Array.from({ length: 12 }, (_, index) => index).reduce(
                (sum: number, index) => sum + Buffer.byteLength(buildBulkFixturePayload(index), 'utf8'),
                0,
            );
        const initialWorkspaceFileCount = 14;
        await writeFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'server routed session handoff test\n', 'utf8');
        await writeFile(resolve(join(sourceWorkspaceDir, 'deleted-after-first-handoff.txt')), 'delete me after first handoff\n', 'utf8');
        await Promise.all(
            Array.from({ length: 12 }, async (_, index) => {
                const fileName = `fixture-${String(index).padStart(2, '0')}.txt`;
                await writeFile(
                    resolve(join(sourceWorkspaceDir, 'bulk', fileName)),
                    buildBulkFixturePayload(index),
                    'utf8',
                );
            }),
        );
        await writeFile(
            sourceClaudeSessionFile,
            [
                JSON.stringify({
                    type: 'user',
                    uuid: 'handoff-server-routed-u1',
                    cwd: sourceWorkspaceDir,
                    message: { content: 'hello from source server-routed session' },
                }),
                JSON.stringify({
                    type: 'assistant',
                    uuid: 'handoff-server-routed-a1',
                    cwd: sourceWorkspaceDir,
                    message: {
                        model: 'claude-test',
                        content: [{ type: 'text', text: 'source server-routed reply' }],
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
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            },
        });

        ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
        ui.connect();
        await waitFor(() => ui?.isConnected() === true, {
            timeoutMs: 20_000,
            context: 'user-scoped socket connected for server-routed handoff e2e',
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
                remoteSessionId: 'sess-handoff-server-routed',
                directoryHint: sourceWorkspaceDir,
                titleHint: 'handoff server-routed session',
                source: {
                    kind: 'claudeConfig',
                    configDir: sourceClaudeConfigDir,
                    projectId: 'proj-handoff-server-routed',
                },
            }),
            'source direct session link for server-routed handoff',
        ) as Readonly<{ ok: true; sessionId: string }>;
        const sessionId = linked.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('Missing linked session id from server-routed direct session source');
        }

        const started = unwrapDataKeyRpcResult(
            await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
                sessionId,
                sourceMachineId: sourceSeed.machineId,
                targetMachineId: targetSeed.machineId,
                sessionStorageMode: 'direct',
                preferredTransportStrategies: ['server_routed_stream'],
                negotiatedTransportStrategy: 'server_routed_stream',
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'transfer_snapshot',
                    conflictPolicy: 'replace_existing',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            }),
            'source server-routed handoff start',
        ) as HandoffStartResult;

        expect(started).toEqual(expect.objectContaining({
            handoffId: expect.any(String),
            targetPath: expect.any(String),
            endpointCandidates: [],
        }));
        expect(started.agentBundle).toBeUndefined();
        const handoffMetadataV2 = requireHandoffMetadataV2(started, 'source server-routed handoff start');
        expectAgentBundleTransferPublicationMaybe(handoffMetadataV2.agentBundleTransferPublication);
        expect(requireObject(handoffMetadataV2.workspaceReplicationManifestTransferPublication, 'workspaceReplicationManifestTransferPublication')).toEqual(expect.objectContaining({
            transferId: expect.any(String),
        }));
        await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'source daemon session removed immediately after server-routed handoff start cutover',
        });

        const prepared = await waitForReadyHandoffPrepareResult({
            machineRpc: targetMachineRpc,
            machineId: targetSeed.machineId,
            handoffId: started.handoffId,
            initialResult: await waitForPrepareTargetAccepted({
                machineRpc: targetMachineRpc,
                machineId: targetSeed.machineId,
                context: 'target server-routed handoff prepare',
                payload: {
                    handoffId: started.handoffId,
                    sourceMachineId: sourceSeed.machineId,
                    targetMachineId: targetSeed.machineId,
                    negotiatedTransportStrategy: 'server_routed_stream',
                    sourceSessionStorageMode: 'direct',
                    targetPath: targetWorkspaceDir,
                    handoffMetadataV2,
                    workspaceTransfer: {
                        enabled: true,
                        strategy: 'transfer_snapshot',
                        conflictPolicy: 'replace_existing',
                        includeIgnoredMode: 'exclude',
                        ignoredIncludeGlobs: [],
                    },
                },
            }),
            context: 'target server-routed handoff prepare',
        });
        const preparedResume = requirePreparedResume(prepared, 'target server-routed handoff prepare');
        const originalSourceWorkspaceRootPath = requireAbsoluteWorkspaceRoot(
            handoffMetadataV2.workspaceReplicationSourceRootPath,
            'source server-routed handoff start workspaceReplicationSourceRootPath',
        );

        expect(prepared.status.transportStrategy).toBe('server_routed_stream');
        expect(prepared.status.workspacePreflightSummary).toEqual(expect.objectContaining({
            addedPathsCount: expect.any(Number),
            changedPathsCount: expect.any(Number),
            removedPathsCount: expect.any(Number),
            totalBytes: expect.any(Number),
        }));
        expect(prepared.status.progress).toEqual(expect.objectContaining({
            checkpoint: 'import_session',
            planned: expect.objectContaining({
                added: prepared.status.workspacePreflightSummary?.addedPathsCount,
                changed: prepared.status.workspacePreflightSummary?.changedPathsCount,
                removed: prepared.status.workspacePreflightSummary?.removedPathsCount,
            }),
            transferred: expect.objectContaining({
                files: expect.any(Number),
                bytes: expect.any(Number),
            }),
            current: expect.objectContaining({
                phaseDetail: 'ready_for_cutover',
            }),
        }));
        expect(preparedResume.agent).toBe('claude');
        expect(preparedResume.transcriptStorage).toBe('direct');
        const targetProjectId = resolveClaudeProjectId(preparedResume.directory);
        const targetImportedTranscriptPath = resolve(
            join(targetClaudeConfigDir, 'projects', targetProjectId, 'sess-handoff-server-routed.jsonl'),
        );
        await expect(readFile(targetImportedTranscriptPath, 'utf8')).resolves.toContain('source server-routed reply');
        await expect(readFile(resolve(join(preparedResume.directory, 'README.md')), 'utf8')).resolves.toBe('server routed session handoff test\n');
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
            'source server-routed handoff commit',
        ) as Readonly<{ status: Readonly<{ status: string; phase: string }> }>;

        expect(committed.status.status).toBe('completed');
        expect(committed.status.phase).toBe('finalizing');
        await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'source daemon session removed after server-routed handoff cutover',
        });
        await waitFor(async () => (await listDaemonSessions(targetDaemon!)).includes(sessionId) === true, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'target daemon session active after server-routed handoff resume',
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
            context: 'server session active after server-routed handoff',
        });
        await patchSessionHandoffMetadataV1({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            machineKeys: [auth.accountMachineKey],
            providerId: 'claude',
            sourceMachineId: sourceSeed.machineId,
            targetMachineId: targetSeed.machineId,
            sourceWorkspaceRootPath: originalSourceWorkspaceRootPath,
            targetWorkspaceRootPath: preparedResume.directory,
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            transportStrategy: 'server_routed_stream',
        });
        const patchedMetadata = await fetchSessionMetadataV2({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            machineKeys: [auth.accountMachineKey],
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
                transportStrategy: 'server_routed_stream',
            }),
        }));
        expect(patchedMetadata.claudeTranscriptPath).toBeUndefined();
        expect(patchedMetadata.externalHistoryImportV1).toBeUndefined();
        expect(
            (patchedMetadata.directSessionV1 as Readonly<{ remoteSessionId?: unknown }> | undefined)?.remoteSessionId,
        ).toBe(patchedMetadata.claudeSessionId);
        // Persist the reverse-direction workspace baseline on the source machine so a subsequent
        // “handoff back” can use `sync_changes` without forcing a full snapshot transfer.
        unwrapDataKeyRpcResult(
            await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT}`, {
                handoffId: started.handoffId,
                mode: 'source_cleanup',
                workspaceReplicationReverseSourceRootPath: preparedResume.directory,
                workspaceReplicationReverseTargetRootPath: originalSourceWorkspaceRootPath,
            }),
            'source server-routed handoff source cleanup',
        );

        await writeFile(resolve(join(preparedResume.directory, 'README.md')), 'server routed session handoff after second pass\n', 'utf8');
        await writeFile(resolve(join(preparedResume.directory, 'added-after-first-handoff.txt')), 'added after first handoff\n', 'utf8');
        await rm(resolve(join(preparedResume.directory, 'deleted-after-first-handoff.txt')));
        await waitFor(async () => (await listDaemonSessions(targetDaemon!)).includes(sessionId) === true, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'target daemon session active after server-routed handoff-back cutover',
        });

        const secondStarted = unwrapDataKeyRpcResult(
            await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
                sessionId,
                sourceMachineId: targetSeed.machineId,
                targetMachineId: sourceSeed.machineId,
                sessionStorageMode: 'direct',
                preferredTransportStrategies: ['server_routed_stream'],
                negotiatedTransportStrategy: 'server_routed_stream',
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            }),
            'target server-routed handoff-back start',
        ) as HandoffStartResult;
        expect(secondStarted.handoffId).not.toBe(started.handoffId);
        const secondHandoffMetadataV2 = requireHandoffMetadataV2(secondStarted, 'target server-routed handoff-back start');
        expectAgentBundleTransferPublicationMaybe(secondHandoffMetadataV2.agentBundleTransferPublication);
        const secondHandoffBackTargetRootPath = requireAbsoluteWorkspaceRoot(
            resolveSessionHandoffBackTargetRootPath({
                metadata: patchedMetadata,
                requestedTargetMachineId: sourceSeed.machineId,
            }),
            'target server-routed handoff-back start resolved workspaceReplicationHandoffBackTargetRootPath',
        );
        expect(secondHandoffBackTargetRootPath).toBe(originalSourceWorkspaceRootPath);
        expect(requireObject(secondHandoffMetadataV2.workspaceReplicationManifestTransferPublication, 'workspaceReplicationManifestTransferPublication')).toEqual(expect.objectContaining({
            transferId: expect.any(String),
        }));
        const secondPrepared = await waitForReadyHandoffPrepareResult({
            machineRpc: sourceMachineRpc,
            machineId: sourceSeed.machineId,
            handoffId: secondStarted.handoffId,
            initialResult: await waitForPrepareTargetAccepted({
                machineRpc: sourceMachineRpc,
                machineId: sourceSeed.machineId,
                context: 'source server-routed handoff-back prepare',
                payload: {
                    handoffId: secondStarted.handoffId,
                    sourceMachineId: targetSeed.machineId,
                    targetMachineId: sourceSeed.machineId,
                    negotiatedTransportStrategy: 'server_routed_stream',
                    sourceSessionStorageMode: 'direct',
                    targetPath: secondHandoffBackTargetRootPath,
                    handoffMetadataV2: secondHandoffMetadataV2,
                    workspaceTransfer: {
                        enabled: true,
                        strategy: 'sync_changes',
                        conflictPolicy: 'replace_existing',
                        includeIgnoredMode: 'exclude',
                        ignoredIncludeGlobs: [],
                    },
                },
            }),
            context: 'source server-routed handoff-back prepare',
        });
        const secondPreparedResume = requirePreparedResume(secondPrepared, 'source server-routed handoff-back prepare');
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
            timeoutMs: 90_000,
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
            'target server-routed handoff-back commit',
        ) as Readonly<{ status: Readonly<{ status: string; phase: string }> }>;
        expect(secondCommitted.status.status).toBe('completed');

        await waitFor(async () => (await listDaemonSessions(targetDaemon!)).includes(sessionId) === false, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'target daemon session removed after server-routed handoff-back cutover',
        });
        await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === true, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'source daemon session active after server-routed handoff-back resume',
        });
        await expect(readFile(resolve(join(secondPreparedResume.directory, 'README.md')), 'utf8')).resolves.toBe(
            'server routed session handoff after second pass\n',
        );
        await expect(readFile(resolve(join(secondPreparedResume.directory, 'added-after-first-handoff.txt')), 'utf8')).resolves.toBe(
            'added after first handoff\n',
        );
        await expect(readFile(resolve(join(secondPreparedResume.directory, 'bulk', 'fixture-11.txt')), 'utf8')).resolves.toContain(
            'bulk fixture 11',
        );
        await expect(readFile(resolve(join(secondPreparedResume.directory, 'deleted-after-first-handoff.txt')), 'utf8')).rejects.toThrow();
    }, 300_000);

    it('aborts a pending server-routed workspace prepare without mutating the final target tree', async () => {
        const testDir = run.testDir('session-handoff-server-routed-abort');
        const sourceDaemonDir = resolve(join(testDir, 'daemon-source'));
        const targetDaemonDir = resolve(join(testDir, 'daemon-target'));
        const sourceHomeDir = resolve(join(testDir, 'source-home'));
        const targetHomeDir = resolve(join(testDir, 'target-home'));
        const sourceWorkspaceDir = resolve(join(testDir, 'workspace-source'));
        const targetWorkspaceDir = resolve(join(testDir, 'workspace-target'));
        const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
        const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-server-routed-abort'));
        const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-server-routed-abort.jsonl'));
        const targetClaudeConfigDir = resolve(join(testDir, 'target-claude-config'));
        const sourceFakeClaudeLog = resolve(join(testDir, 'fake-claude-source.jsonl'));
        const fakeClaudePath = fakeClaudeFixturePath();

        await mkdir(sourceHomeDir, { recursive: true });
        await mkdir(targetHomeDir, { recursive: true });
        await mkdir(sourceWorkspaceDir, { recursive: true });
        await mkdir(targetWorkspaceDir, { recursive: true });
        await mkdir(resolve(join(sourceWorkspaceDir, 'bulk')), { recursive: true });
        await mkdir(sourceClaudeProjectDir, { recursive: true });
        await mkdir(targetClaudeConfigDir, { recursive: true });
        await mkdir(sourceDaemonDir, { recursive: true });
        await mkdir(targetDaemonDir, { recursive: true });

        await writeFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'server routed abort source\n', 'utf8');
        await writeFile(resolve(join(sourceWorkspaceDir, 'added-after-abort.txt')), 'should never land\n', 'utf8');
        await Promise.all(
            Array.from({ length: 24 }, async (_, index) => {
                const fileName = `fixture-${String(index).padStart(2, '0')}.txt`;
                await writeFile(
                    resolve(join(sourceWorkspaceDir, 'bulk', fileName)),
                    buildBulkFixturePayload(index),
                    'utf8',
                );
            }),
        );
        await writeFile(resolve(join(targetWorkspaceDir, 'README.md')), 'target stays old\n', 'utf8');
        await writeFile(resolve(join(targetWorkspaceDir, 'keep.txt')), 'keep me\n', 'utf8');
        await writeFile(
            sourceClaudeSessionFile,
            [
                JSON.stringify({
                    type: 'user',
                    uuid: 'handoff-server-routed-abort-u1',
                    cwd: sourceWorkspaceDir,
                    message: { content: 'hello from source server-routed abort session' },
                }),
                JSON.stringify({
                    type: 'assistant',
                    uuid: 'handoff-server-routed-abort-a1',
                    cwd: sourceWorkspaceDir,
                    message: {
                        model: 'claude-test',
                        content: [{ type: 'text', text: 'source server-routed abort reply' }],
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
                HAPPIER_E2E_FAKE_CLAUDE_LOG: sourceFakeClaudeLog,
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
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            },
        });

        ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
        ui.connect();
        await waitFor(() => ui?.isConnected() === true, {
            timeoutMs: 20_000,
            context: 'user-scoped socket connected for server-routed handoff abort e2e',
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
                remoteSessionId: 'sess-handoff-server-routed-abort',
                directoryHint: sourceWorkspaceDir,
                titleHint: 'handoff server-routed abort session',
                source: {
                    kind: 'claudeConfig',
                    configDir: sourceClaudeConfigDir,
                    projectId: 'proj-handoff-server-routed-abort',
                },
            }),
            'source direct session link for server-routed handoff abort',
        ) as Readonly<{ ok: true; sessionId: string }>;
        const sessionId = linked.sessionId;

        const started = unwrapDataKeyRpcResult(
            await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
                sessionId,
                sourceMachineId: sourceSeed.machineId,
                targetMachineId: targetSeed.machineId,
                sessionStorageMode: 'direct',
                preferredTransportStrategies: ['server_routed_stream'],
                negotiatedTransportStrategy: 'server_routed_stream',
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            }),
            'source server-routed abort handoff start',
        ) as HandoffStartResult;
        const abortHandoffMetadataV2 = requireHandoffMetadataV2(started, 'source server-routed abort handoff start');
        expectAgentBundleTransferPublicationMaybe(abortHandoffMetadataV2.agentBundleTransferPublication);
        expect(requireObject(abortHandoffMetadataV2.workspaceReplicationManifestTransferPublication, 'workspaceReplicationManifestTransferPublication')).toEqual(expect.objectContaining({
            transferId: expect.any(String),
        }));

        const initialPrepare = await waitForPrepareTargetAccepted({
            machineRpc: targetMachineRpc,
            machineId: targetSeed.machineId,
            context: 'target server-routed abort handoff prepare',
            payload: {
                handoffId: started.handoffId,
                sourceMachineId: sourceSeed.machineId,
                targetMachineId: targetSeed.machineId,
                negotiatedTransportStrategy: 'server_routed_stream',
                sourceSessionStorageMode: 'direct',
                targetPath: targetWorkspaceDir,
                handoffMetadataV2: abortHandoffMetadataV2,
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            },
        });

        expect(initialPrepare.status.status).toBe('pending');
        expect(initialPrepare.status.jobId).toEqual(expect.any(String));

        const aborted = unwrapDataKeyRpcResult(
            await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT}`, {
                handoffId: started.handoffId,
                reason: 'user_cancelled',
            }),
            'target server-routed abort handoff abort',
        ) as Readonly<{ status: Readonly<{ status: string; phase: string }> }>;

        expect(aborted.status.status).toBe('aborted');

        await waitFor(async () => {
            const status = unwrapDataKeyRpcResult(
                await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET}`, {
                    handoffId: started.handoffId,
                }),
                'target server-routed abort handoff status',
            ) as HandoffStatusResult;
            return status.status.status === 'aborted';
        }, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'target server-routed handoff abort status',
        });

        await waitFor(async () => {
            const result = unwrapDataKeyRpcResult(
                await targetMachineRpc.call(`${targetSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET}`, {
                    handoffId: started.handoffId,
                }),
                'target server-routed abort handoff result get',
            ) as Readonly<{ ok?: boolean; errorCode?: string }>;
            return result.ok === false && result.errorCode === 'aborted';
        }, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'target server-routed handoff abort result terminal error',
        });

        await expect(readFile(resolve(join(targetWorkspaceDir, 'README.md')), 'utf8')).resolves.toBe('target stays old\n');
        await expect(readFile(resolve(join(targetWorkspaceDir, 'keep.txt')), 'utf8')).resolves.toBe('keep me\n');
        await expect(readFile(resolve(join(targetWorkspaceDir, 'added-after-abort.txt')), 'utf8')).rejects.toThrow();
    }, 300_000);

    it('does not let a late plaintext UI message execute on the source once server-routed cutover has started', async () => {
        const testDir = run.testDir('session-handoff-server-routed-late-message-cutover');
        const sourceDaemonDir = resolve(join(testDir, 'daemon-source'));
        const targetDaemonDir = resolve(join(testDir, 'daemon-target'));
        const sourceHomeDir = resolve(join(testDir, 'source-home'));
        const targetHomeDir = resolve(join(testDir, 'target-home'));
        const sourceWorkspaceDir = resolve(join(testDir, 'workspace-source'));
        const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
        const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-server-routed-late'));
        const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-server-routed-late.jsonl'));
        const targetClaudeConfigDir = resolve(join(testDir, 'target-claude-config'));
        const sourceFakeClaudeLog = resolve(join(testDir, 'fake-claude-source.jsonl'));
        const targetFakeClaudeLog = resolve(join(testDir, 'fake-claude-target.jsonl'));
        const fakeClaudePath = fakeClaudeFixturePath();

        await mkdir(sourceHomeDir, { recursive: true });
        await mkdir(targetHomeDir, { recursive: true });
        await mkdir(sourceWorkspaceDir, { recursive: true });
        await mkdir(sourceClaudeProjectDir, { recursive: true });
        await mkdir(sourceClaudeConfigDir, { recursive: true });
        await mkdir(targetClaudeConfigDir, { recursive: true });
        await mkdir(sourceDaemonDir, { recursive: true });
        await mkdir(targetDaemonDir, { recursive: true });
        await writeFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'late server-routed cutover proof\n', 'utf8');
        await writeFile(
            sourceClaudeSessionFile,
            [
                JSON.stringify({
                    type: 'user',
                    uuid: 'handoff-server-routed-late-u1',
                    cwd: sourceWorkspaceDir,
                    message: { content: 'hello from source server-routed late session' },
                }),
                JSON.stringify({
                    type: 'assistant',
                    uuid: 'handoff-server-routed-late-a1',
                    cwd: sourceWorkspaceDir,
                    message: {
                        model: 'claude-test',
                        content: [{ type: 'text', text: 'source server-routed late reply' }],
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
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            },
        });

        ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
        ui.connect();
        await waitFor(() => ui?.isConnected() === true, {
            timeoutMs: 20_000,
            context: 'user-scoped socket connected for server-routed late cutover proof',
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

        const sourceDirectSessionSource = {
            kind: 'claudeConfig',
            configDir: sourceClaudeConfigDir,
            projectId: 'proj-handoff-server-routed-late',
        } as const;
        const linked = unwrapDataKeyRpcResult(
            await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
                machineId: sourceSeed.machineId,
                providerId: 'claude',
                remoteSessionId: 'sess-handoff-server-routed-late',
                directoryHint: sourceWorkspaceDir,
                titleHint: 'handoff server-routed late session',
                source: sourceDirectSessionSource,
            }),
            'source direct session link for late cutover server-routed handoff',
        ) as Readonly<{ ok: true; sessionId: string }>;
        const sessionId = linked.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('Missing linked session id from late cutover server-routed source');
        }
        await activateLinkedDirectSession({
            machineRpc: sourceMachineRpc,
            machineId: sourceSeed.machineId,
            sessionId,
            providerId: 'claude',
            remoteSessionId: 'sess-handoff-server-routed-late',
            source: sourceDirectSessionSource,
            context: 'late cutover server-routed source activation',
        });
        const initialPrompt = 'before-cutover-server-routed-proof';
        await postPlainUiTextMessage({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            text: initialPrompt,
            localId: 'late-cutover-before-start-server-routed',
        });
        await waitFor(() => fakeClaudeLogContainsUserText(sourceFakeClaudeLog, initialPrompt), {
            timeoutMs: 60_000,
            intervalMs: 200,
            context: 'source fake Claude receives the pre-cutover server-routed prompt',
        });

        const started = unwrapDataKeyRpcResult(
            await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START}`, {
                sessionId,
                sourceMachineId: sourceSeed.machineId,
                targetMachineId: targetSeed.machineId,
                sessionStorageMode: 'direct',
                preferredTransportStrategies: ['server_routed_stream'],
                negotiatedTransportStrategy: 'server_routed_stream',
            }),
            'source server-routed handoff start for late cutover proof',
        ) as HandoffStartResult;
        const lateCutoverMetadataV2 = requireHandoffMetadataV2(started, 'source server-routed handoff start for late cutover proof');
        expect(requireObject(lateCutoverMetadataV2.agentBundleTransferPublication, 'agentBundleTransferPublication')).toEqual(expect.objectContaining({
            transferId: expect.any(String),
            sizeBytes: expect.any(Number),
            manifestHash: expect.any(String),
        }));

        const latePrompt = 'after-cutover-start-server-routed-proof';
        await postPlainUiTextMessage({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            text: latePrompt,
            localId: 'late-cutover-after-start-server-routed',
        });

        await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'source daemon session removed after server-routed late prompt delivery started',
        });

        await waitFor(async () => {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
            return (await fakeClaudeLogContainsUserText(sourceFakeClaudeLog, latePrompt)) === false;
        }, {
            timeoutMs: 5_000,
            intervalMs: 200,
            context: 'late prompt never reaches the stopped source session after server-routed cutover start',
        });

        const prepared = await waitForReadyHandoffPrepareResult({
            machineRpc: targetMachineRpc,
            machineId: targetSeed.machineId,
            handoffId: started.handoffId,
            initialResult: await waitForPrepareTargetAccepted({
                machineRpc: targetMachineRpc,
                machineId: targetSeed.machineId,
                context: 'target server-routed handoff prepare for late cutover proof',
                payload: {
                    handoffId: started.handoffId,
                    sourceMachineId: sourceSeed.machineId,
                    targetMachineId: targetSeed.machineId,
                    negotiatedTransportStrategy: 'server_routed_stream',
                    sourceSessionStorageMode: 'direct',
                    targetPath: started.targetPath,
                    handoffMetadataV2: lateCutoverMetadataV2,
                },
            }),
            context: 'target server-routed handoff prepare for late cutover proof',
        });
        const lateCutoverPreparedResume = requirePreparedResume(prepared, 'target server-routed handoff prepare for late cutover proof');

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
            'source server-routed handoff commit for late cutover proof',
        ) as Readonly<{ status: Readonly<{ status: string; phase: string }> }>;
        expect(committed.status.status).toBe('completed');

        await waitFor(() => fakeClaudeLogContainsUserText(targetFakeClaudeLog, latePrompt), {
            timeoutMs: 60_000,
            intervalMs: 200,
            context: 'late prompt reaches the resumed target session after server-routed cutover',
        });
        expect(await fakeClaudeLogContainsUserText(sourceFakeClaudeLog, latePrompt)).toBe(false);
    }, 480_000);
});
