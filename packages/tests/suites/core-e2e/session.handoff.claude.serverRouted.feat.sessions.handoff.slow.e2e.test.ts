import { afterAll, afterEach, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    computeWorkspaceSyncPolicyDigest,
    SessionHandoffActionResultV1Schema,
    type SessionHandoffActionResultV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth, createTestAuthMtls } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount, seedCliTokenOnlyAuthForServer } from '../../src/testkit/cliAuth';
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
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';

const run = createRunDirs({ runLabel: 'core' });
const currentContentHeaders = buildAccountStoredContentCompatibilityHttpHeadersV1(
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
);
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
            ...currentContentHeaders,
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
            ...currentContentHeaders,
        },
        timeoutMs: 5_000,
    });
    if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
        throw new Error(`Failed to fetch session snapshot ${params.sessionId}`);
    }
    return response.data;
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

    it.each(['e2ee', 'keyless plain'] as const)('hands off a linked Claude direct session to a second online daemon over forced server-routed transfer (%s)', async (machineMode) => {
        const testDir = run.testDir(`session-handoff-claude-server-routed-${machineMode}`);
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
                ...(machineMode === 'keyless plain' ? {
                    HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
                    AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
                    AUTH_SIGNUP_PROVIDERS: '',
                    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                    HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
                    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
                    HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
                    HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
                    HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
                    HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
                    HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: 'CN=Example Root CA',
                } : {}),
            },
        });
        const identity = { email: 'handoff@example.com', issuer: 'CN=Example Root CA' };
        const e2eeAuth = machineMode === 'e2ee' ? await createTestAuth(server.baseUrl) : null;
        const auth = e2eeAuth ?? await createTestAuthMtls(server.baseUrl, identity);
        const targetAuth = e2eeAuth ?? await createTestAuthMtls(server.baseUrl, identity);

        const sourceSeed = e2eeAuth
            ? await seedCliAuthForTestAccount({ cliHome: sourceHomeDir, serverUrl: server.baseUrl, auth: e2eeAuth, mode: 'dataKey' })
            : await seedCliTokenOnlyAuthForServer({ cliHome: sourceHomeDir, serverUrl: server.baseUrl, token: auth.token });
        const targetSeed = e2eeAuth
            ? await seedCliAuthForTestAccount({ cliHome: targetHomeDir, serverUrl: server.baseUrl, auth: e2eeAuth, mode: 'dataKey' })
            : await seedCliTokenOnlyAuthForServer({ cliHome: targetHomeDir, serverUrl: server.baseUrl, token: targetAuth.token });

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

        ui = createUserScopedSocketCollector(server.baseUrl, auth.token, { declareCurrentAccountStoredContentCompatibility: true });
        ui.connect();
        await waitFor(() => ui?.isConnected() === true, {
            timeoutMs: 20_000,
            context: 'user-scoped socket connected for server-routed handoff e2e',
        });

        const sourceMachineRpc = createMachineRpcClient(ui, e2eeAuth
            ? { mode: 'dataKey', dataKey: e2eeAuth.accountMachineKey }
            : { mode: 'plain' });
        const targetMachineRpc = createMachineRpcClient(ui, e2eeAuth
            ? { mode: 'dataKey', dataKey: e2eeAuth.accountMachineKey }
            : { mode: 'plain' });

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

        const started = await executeSessionHandoffAction({
            machineRpc: sourceMachineRpc,
            sourceMachineId: sourceSeed.machineId,
            input: {
                sessionId,
                sourceMachineId: sourceSeed.machineId,
                targetMachineId: targetSeed.machineId,
                sessionStorageMode: 'direct',
                targetPath: targetWorkspaceDir,
                preferredTransportStrategies: ['server_routed_stream'],
                negotiatedTransportStrategy: 'server_routed_stream',
                workspaceAction: twoWayWorkspaceAction,
                accountServerId: sourceSeed.serverId,
            },
            context: 'source server-routed session handoff Action',
        });
        expect(started.status).toEqual(expect.objectContaining({
            status: 'completed',
            transportStrategy: 'server_routed_stream',
        }));
        expect(started.workspace).toEqual(expect.objectContaining({
            kind: 'relationship',
            relationshipId: expect.any(String),
            created: true,
        }));
        if (started.workspace.kind !== 'relationship') {
            throw new Error('Expected server-routed handoff to create a workspace relationship');
        }

        const targetMetadata = await fetchSessionMetadataV2({
            baseUrl: server.baseUrl,
            token: targetAuth.token,
            sessionId,
            ...(e2eeAuth
                ? { machineKeys: [e2eeAuth.accountMachineKey] }
                : { accountEncryptionMode: 'plain' as const }),
        });
        const targetWorkspaceRootPath = requireAbsoluteWorkspaceRoot(targetMetadata.path, 'target Session metadata path');
        expect(targetWorkspaceRootPath).toBe(targetWorkspaceDir);
        const targetProjectId = resolveClaudeProjectId(targetWorkspaceRootPath);
        const targetImportedTranscriptPath = resolve(
            join(targetClaudeConfigDir, 'projects', targetProjectId, 'sess-handoff-server-routed.jsonl'),
        );
        await expect(readFile(targetImportedTranscriptPath, 'utf8')).resolves.toContain('source server-routed reply');
        await expect(readFile(resolve(join(targetWorkspaceRootPath, 'README.md')), 'utf8')).resolves.toBe('server routed session handoff test\n');
        await expect(readFile(resolve(join(targetWorkspaceRootPath, 'deleted-after-first-handoff.txt')), 'utf8')).resolves.toBe(
            'delete me after first handoff\n',
        );
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
        await writeFile(resolve(join(targetWorkspaceRootPath, 'README.md')), 'server routed session handoff after second pass\n', 'utf8');
        await writeFile(resolve(join(targetWorkspaceRootPath, 'added-after-first-handoff.txt')), 'added after first handoff\n', 'utf8');
        await rm(resolve(join(targetWorkspaceRootPath, 'deleted-after-first-handoff.txt')));
        await waitFor(async () => (await listDaemonSessions(targetDaemon!)).includes(sessionId) === true, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'target daemon session active after server-routed handoff-back cutover',
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
                preferredTransportStrategies: ['server_routed_stream'],
                negotiatedTransportStrategy: 'server_routed_stream',
                workspaceAction: {
                    kind: 'relationship',
                    relationshipId: started.workspace.relationshipId,
                    flushBeforeCommit: true,
                },
                accountServerId: targetSeed.serverId,
            },
            context: 'target server-routed session handoff-back Action',
        });
        expect(secondStarted.handoffId).not.toBe(started.handoffId);
        expect(secondStarted.status).toEqual(expect.objectContaining({
            status: 'completed',
            transportStrategy: 'server_routed_stream',
        }));
        expect(secondStarted.workspace).toEqual(expect.objectContaining({
            kind: 'relationship',
            relationshipId: started.workspace.relationshipId,
            created: false,
        }));

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
        await expect(readFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'utf8')).resolves.toBe(
            'server routed session handoff after second pass\n',
        );
        await expect(readFile(resolve(join(sourceWorkspaceDir, 'added-after-first-handoff.txt')), 'utf8')).resolves.toBe(
            'added after first handoff\n',
        );
        await expect(readFile(resolve(join(sourceWorkspaceDir, 'bulk', 'fixture-11.txt')), 'utf8')).resolves.toContain(
            'bulk fixture 11',
        );
        await expect(readFile(resolve(join(sourceWorkspaceDir, 'deleted-after-first-handoff.txt')), 'utf8')).rejects.toThrow();
    }, 300_000);

    it('uses the persisted Action approval receipt before replacing a non-empty server-routed target', async () => {
        const testDir = run.testDir('session-handoff-server-routed-approval');
        const sourceDaemonDir = resolve(join(testDir, 'daemon-source'));
        const targetDaemonDir = resolve(join(testDir, 'daemon-target'));
        const sourceHomeDir = resolve(join(testDir, 'source-home'));
        const targetHomeDir = resolve(join(testDir, 'target-home'));
        const sourceWorkspaceDir = resolve(join(testDir, 'workspace-source'));
        const targetWorkspaceDir = resolve(join(testDir, 'workspace-target'));
        const sourceClaudeConfigDir = resolve(join(testDir, 'source-claude-config'));
        const sourceClaudeProjectDir = resolve(join(sourceClaudeConfigDir, 'projects', 'proj-handoff-server-routed-approval'));
        const sourceClaudeSessionFile = resolve(join(sourceClaudeProjectDir, 'sess-handoff-server-routed-approval.jsonl'));
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

        await writeFile(resolve(join(sourceWorkspaceDir, 'README.md')), 'server routed approved source\n', 'utf8');
        await writeFile(resolve(join(sourceWorkspaceDir, 'added-after-approval.txt')), 'approved transfer\n', 'utf8');
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
                    uuid: 'handoff-server-routed-approval-u1',
                    cwd: sourceWorkspaceDir,
                    message: { content: 'hello from source server-routed approval session' },
                }),
                JSON.stringify({
                    type: 'assistant',
                    uuid: 'handoff-server-routed-approval-a1',
                    cwd: sourceWorkspaceDir,
                    message: {
                        model: 'claude-test',
                        content: [{ type: 'text', text: 'source server-routed approval reply' }],
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
            context: 'user-scoped socket connected for server-routed handoff approval e2e',
        });

        const sourceMachineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);
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
                remoteSessionId: 'sess-handoff-server-routed-approval',
                directoryHint: sourceWorkspaceDir,
                titleHint: 'handoff server-routed approval session',
                source: {
                    kind: 'claudeConfig',
                    configDir: sourceClaudeConfigDir,
                    projectId: 'proj-handoff-server-routed-approval',
                },
            }),
            'source direct session link for server-routed handoff approval',
        ) as Readonly<{ ok: true; sessionId: string }>;
        const sessionId = linked.sessionId;

        const actionExecutor = createCliActionExecutorFromCredentials({
            credentials: {
                token: auth.token,
                encryption: {
                    type: 'dataKey',
                    machineKey: auth.accountMachineKey,
                    publicKey: Uint8Array.from(
                        tweetnacl.box.keyPair.fromSecretKey(auth.accountMachineKey).publicKey,
                    ),
                },
                credentialProvenance: 'stored_session',
            },
            machineId: sourceSeed.machineId,
            serverId: sourceSeed.serverId,
            serverApiUrl: server.baseUrl,
        });
        const approvalAdmission = await actionExecutor.execute(
            'session.handoff',
            {
                sessionId,
                targetMachineId: targetSeed.machineId,
                targetPath: targetWorkspaceDir,
                workspaceAction: twoWayWorkspaceAction,
            },
            {
                surface: 'ui',
                authority: 'present_user',
                actionCaller: { kind: 'host' },
                serverId: sourceSeed.serverId,
                actionRequestId: 'server-routed-target-replacement-approval',
            },
        );
        if (!approvalAdmission.ok) {
            throw new Error(`Expected canonical session.handoff Action admission (${approvalAdmission.errorCode})`);
        }
        const approvalRequest = approvalAdmission.result as Readonly<{
            kind?: unknown;
            artifactId?: unknown;
            actionId?: unknown;
        }>;
        expect(approvalRequest).toEqual({
            kind: 'approval_request_created',
            artifactId: expect.any(String),
            actionId: 'session.handoff',
        });
        if (typeof approvalRequest.artifactId !== 'string') {
            throw new Error('Expected persisted target-replacement approval artifact');
        }

        const approved = unwrapDataKeyRpcResult(
            await sourceMachineRpc.call(`${sourceSeed.machineId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`, {
                artifactId: approvalRequest.artifactId,
                decision: 'approve',
            }),
            'approve server-routed target-replacement approval',
        ) as Readonly<{
            ok?: unknown;
            status?: unknown;
            execution?: Readonly<{ ok?: unknown; result?: unknown }>;
        }>;
        expect(approved).toEqual(expect.objectContaining({
            ok: true,
            status: 'executed',
            execution: expect.objectContaining({ ok: true }),
        }));
        const completed = SessionHandoffActionResultV1Schema.safeParse(approved.execution?.result);
        expect(completed.success).toBe(true);
        if (!completed.success) {
            throw new Error('Expected approved target-replacement execution to return the terminal handoff result');
        }
        expect(completed.data).toEqual(expect.objectContaining({
            status: expect.objectContaining({
                status: 'completed',
                transportStrategy: 'server_routed_stream',
            }),
            workspace: expect.objectContaining({ kind: 'relationship', created: true }),
        }));

        await expect(readFile(resolve(join(targetWorkspaceDir, 'README.md')), 'utf8')).resolves.toBe('server routed approved source\n');
        await expect(readFile(resolve(join(targetWorkspaceDir, 'added-after-approval.txt')), 'utf8')).resolves.toBe('approved transfer\n');
        await expect(readFile(resolve(join(targetWorkspaceDir, 'keep.txt')), 'utf8')).rejects.toThrow();
        await waitFor(async () => (await listDaemonSessions(sourceDaemon!)).includes(sessionId) === false, {
            timeoutMs: 30_000,
            intervalMs: 100,
            context: 'source stopped after approved target-replacement handoff',
        });
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

        const handoffResultPromise = executeSessionHandoffAction({
            machineRpc: sourceMachineRpc,
            sourceMachineId: sourceSeed.machineId,
            input: {
                sessionId,
                sourceMachineId: sourceSeed.machineId,
                targetMachineId: targetSeed.machineId,
                sessionStorageMode: 'direct',
                preferredTransportStrategies: ['server_routed_stream'],
                negotiatedTransportStrategy: 'server_routed_stream',
                accountServerId: sourceSeed.serverId,
            },
            context: 'source server-routed handoff Action for late cutover proof',
        });

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

        const completed = await handoffResultPromise;
        expect(completed.status).toEqual(expect.objectContaining({ status: 'completed' }));

        await waitFor(() => fakeClaudeLogContainsUserText(targetFakeClaudeLog, latePrompt), {
            timeoutMs: 60_000,
            intervalMs: 200,
            context: 'late prompt reaches the resumed target session after server-routed cutover',
        });
        expect(await fakeClaudeLogContainsUserText(sourceFakeClaudeLog, latePrompt)).toBe(false);
    }, 480_000);
});
