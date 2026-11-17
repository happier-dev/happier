import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import {
    readDaemonState,
    replaceTestDaemonWithoutStoppingSessions,
    startTestDaemon,
    stopDaemonFromHomeDir,
    type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { resolveDaemonSessionMarkerDirs } from '../../src/testkit/daemon/sessionMarkerDirs';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { enqueueSessionPromptForScenario, waitForAssistantMessageContaining } from '../../src/testkit/providers/scenarios/sessionRuntime';
import { assertPidAlive, readFakeClaudeSdkInvocationCount, readFakeClaudeSessionId } from '../../src/testkit/providers/fakeClaudeContinuity';
import {
    prepareCliUpdateSourceSnapshot,
    resolveCliUpdateSourcePairFromEnv,
    resolveCliUpdateValidationLaunchEnv,
} from '../../src/testkit/releaseValidation/cliUpdateSources';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const CLI_UPDATE_CONTINUITY_TEST_TIMEOUT_MS = 600_000;

type DaemonListSession = Readonly<{
    startedBy: string;
    happySessionId: string;
    pid: number;
}>;

type DaemonSessionMarkerSnapshot = Readonly<{
    pid: number;
    processCommandHash: string;
    processCommand: string | null;
}>;

type RestartSessionRunnerCommandJson = Readonly<{
    ok?: unknown;
    status?: unknown;
    sessionId?: unknown;
    previous?: unknown;
    next?: unknown;
}>;

const CLI_JSON_LOG_CONTEXT_LINES = 6;
const CLI_JSON_LOG_CONTEXT_LINE_CHARS = 1_200;

function formatCliJsonLogLine(line: string): string {
    if (line.length <= CLI_JSON_LOG_CONTEXT_LINE_CHARS) return line;
    return `${line.slice(0, CLI_JSON_LOG_CONTEXT_LINE_CHARS)}... <truncated ${line.length - CLI_JSON_LOG_CONTEXT_LINE_CHARS} chars>`;
}

function selectCliJsonLogContextLines(lines: string[]): string[] {
    if (lines.length <= CLI_JSON_LOG_CONTEXT_LINES) return lines;
    const edgeCount = Math.floor(CLI_JSON_LOG_CONTEXT_LINES / 2);
    return [
        ...lines.slice(0, edgeCount),
        `<omitted ${lines.length - (edgeCount * 2)} line(s)>`,
        ...lines.slice(-edgeCount),
    ];
}

async function readCliJsonLogLines(path: string): Promise<string[]> {
    const raw = await readFile(path, 'utf8').catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return `<failed to read log: ${message}>`;
    });
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

function summarizeCliJsonLog(label: 'stdout' | 'stderr', path: string, lines: string[]): string[] {
    if (lines.length === 0) return [`${label}Path=${path}`, `${label}=<empty>`];
    return [
        `${label}Path=${path}`,
        `${label}Lines=${lines.length}`,
        ...selectCliJsonLogContextLines(lines).map((line, index) => `${label}[${index}]=${formatCliJsonLogLine(line)}`),
    ];
}

async function buildCliJsonOutputContext(params: {
    stdoutPath: string;
    stderrPath: string;
}): Promise<{ stdoutLines: string[]; context: string[] }> {
    const [stdoutLines, stderrLines] = await Promise.all([
        readCliJsonLogLines(params.stdoutPath),
        readCliJsonLogLines(params.stderrPath),
    ]);
    return {
        stdoutLines,
        context: [
            ...summarizeCliJsonLog('stdout', params.stdoutPath, stdoutLines),
            ...summarizeCliJsonLog('stderr', params.stderrPath, stderrLines),
        ],
    };
}

function parseDaemonListSessions(data: unknown): DaemonListSession[] {
    if (!data || typeof data !== 'object') return [];
    const children = (data as { children?: unknown }).children;
    if (!Array.isArray(children)) return [];
    return children.flatMap((child): DaemonListSession[] => {
        if (!child || typeof child !== 'object') return [];
        const record = child as Record<string, unknown>;
        const startedBy = typeof record.startedBy === 'string' ? record.startedBy : '';
        const happySessionId = typeof record.happySessionId === 'string' ? record.happySessionId : '';
        const pid = typeof record.pid === 'number' ? record.pid : null;
        if (!startedBy || !happySessionId || !pid || pid <= 0) return [];
        return [{ startedBy, happySessionId, pid }];
    });
}

async function waitForListedDaemonSession(params: {
    port: number;
    controlToken?: string | null;
    sessionId: string;
    expectedPid?: number;
    rejectPid?: number;
    timeoutMs?: number;
}): Promise<DaemonListSession> {
    let found: DaemonListSession | null = null;
    await waitFor(async () => {
        const listed = await daemonControlPostJson({
            port: params.port,
            path: '/list',
            controlToken: params.controlToken,
        });
        expect(listed.status).toBe(200);
        const match = parseDaemonListSessions(listed.data).find((child) => child.happySessionId === params.sessionId) ?? null;
        if (!match) throw new Error(`session ${params.sessionId} not listed by daemon`);
        if (typeof params.expectedPid === 'number' && match.pid !== params.expectedPid) {
            throw new Error(`session ${params.sessionId} listed with pid ${match.pid}, expected ${params.expectedPid}`);
        }
        if (typeof params.rejectPid === 'number' && match.pid === params.rejectPid) {
            throw new Error(`session ${params.sessionId} is still on old pid ${params.rejectPid}`);
        }
        found = match;
        return true;
    }, {
        timeoutMs: params.timeoutMs ?? 30_000,
        context: `daemon /list session ${params.sessionId}`,
    });
    if (!found) throw new Error(`session ${params.sessionId} not listed`);
    return found;
}

async function waitForRestartableDaemonSession(params: {
    testDir: string;
    port: number;
    controlToken?: string | null;
    sessionId: string;
}): Promise<void> {
    await waitFor(async () => {
        const eligibility = await daemonControlPostJson<RestartSessionRunnerCommandJson>({
            port: params.port,
            controlToken: params.controlToken,
            path: '/session-runners/restart',
            body: {
                sessionId: params.sessionId,
                mode: 'force_current_cli',
                dryRun: true,
                reason: 'daemon_restart_session_runners_command',
            },
        });
        await writeFile(resolve(params.testDir, `cli-update.restart-eligibility-${params.port}.json`), JSON.stringify(eligibility, null, 2));
        expect(eligibility.status).toBe(200);
        expect(eligibility.data.status).toBe('dry_run_restartable');
        return true;
    }, { timeoutMs: 60_000, intervalMs: 150, context: 'daemon idle runner restart admission' });
}

async function readDaemonSessionMarkerSnapshot(params: {
    happyHomeDir: string;
    sessionId: string;
    expectedPid?: number;
}): Promise<DaemonSessionMarkerSnapshot | null> {
    const markerDirs = await resolveDaemonSessionMarkerDirs(params.happyHomeDir);
    for (const markerDir of markerDirs) {
        let entries: string[] = [];
        try {
            entries = await readdir(markerDir);
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.startsWith('pid-') || !entry.endsWith('.json')) continue;
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(await readFile(join(markerDir, entry), 'utf8')) as Record<string, unknown>;
            } catch {
                continue;
            }
            if (parsed.happySessionId !== params.sessionId) continue;
            const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
            if (!pid || pid <= 0) continue;
            if (typeof params.expectedPid === 'number' && pid !== params.expectedPid) continue;
            const processCommandHash = typeof parsed.processCommandHash === 'string' ? parsed.processCommandHash.trim() : '';
            if (!/^[a-f0-9]{64}$/.test(processCommandHash)) continue;
            return {
                pid,
                processCommandHash,
                processCommand: typeof parsed.processCommand === 'string' ? parsed.processCommand : null,
            };
        }
    }
    return null;
}

async function waitForDaemonSessionMarkerSnapshot(params: {
    happyHomeDir: string;
    sessionId: string;
    expectedPid?: number;
    timeoutMs?: number;
}): Promise<DaemonSessionMarkerSnapshot> {
    let snapshot: DaemonSessionMarkerSnapshot | null = null;
    await waitFor(async () => {
        snapshot = await readDaemonSessionMarkerSnapshot(params);
        if (!snapshot) throw new Error(`marker not found for session ${params.sessionId}`);
        return true;
    }, {
        timeoutMs: params.timeoutMs ?? 30_000,
        context: `daemon session marker ${params.sessionId}`,
    });
    if (!snapshot) throw new Error(`marker not found for session ${params.sessionId}`);
    return snapshot;
}

async function runCliServerTestFromSnapshot(params: {
    testDir: string;
    snapshotDir: string;
    happyHomeDir: string;
    env: NodeJS.ProcessEnv;
}): Promise<void> {
    const cliLaunchSpec = await resolveCliTestLaunchSpec(
        {
            testDir: params.testDir,
            env: params.env,
        },
        {
            snapshotDir: params.snapshotDir,
            preparedDistSnapshotOnly: true,
        },
    );

    await runLoggedCommand({
        command: cliLaunchSpec.command,
        args: [...cliLaunchSpec.args, 'server', 'test', '--json'],
        cwd: cliLaunchSpec.cwd ?? resolve(params.testDir, '..'),
        env: {
            ...params.env,
            ...(cliLaunchSpec.env ?? {}),
            CI: '1',
            HAPPIER_HOME_DIR: params.happyHomeDir,
        },
        stdoutPath: resolve(params.testDir, 'cli-update.server-test.stdout.log'),
        stderrPath: resolve(params.testDir, 'cli-update.server-test.stderr.log'),
        timeoutMs: 120_000,
    });
}

async function runCliJsonCommandFromSnapshot<T>(params: {
    testDir: string;
    snapshotDir: string;
    happyHomeDir: string;
    env: NodeJS.ProcessEnv;
    args: string[];
    stdoutName: string;
    stderrName: string;
    timeoutMs?: number;
}): Promise<T> {
    const cliLaunchSpec = await resolveCliTestLaunchSpec(
        {
            testDir: params.testDir,
            env: params.env,
        },
        {
            snapshotDir: params.snapshotDir,
            preparedDistSnapshotOnly: true,
        },
    );
    const stdoutPath = resolve(params.testDir, params.stdoutName);
    const stderrPath = resolve(params.testDir, params.stderrName);
    const commandLabel = params.args.join(' ');
    try {
        await runLoggedCommand({
            command: cliLaunchSpec.command,
            args: [...cliLaunchSpec.args, ...params.args],
            cwd: cliLaunchSpec.cwd ?? resolve(params.testDir, '..'),
            env: {
                ...params.env,
                ...(cliLaunchSpec.env ?? {}),
                CI: '1',
                HAPPIER_HOME_DIR: params.happyHomeDir,
            },
            stdoutPath,
            stderrPath,
            timeoutMs: params.timeoutMs ?? 120_000,
        });
    } catch (error) {
        const { context } = await buildCliJsonOutputContext({ stdoutPath, stderrPath });
        throw new Error(
            [
                `CLI JSON command failed: ${commandLabel}`,
                `error=${error instanceof Error ? error.message : String(error)}`,
                ...context,
            ].join(' | '),
        );
    }
    const { stdoutLines: lines, context } = await buildCliJsonOutputContext({ stdoutPath, stderrPath });
    const lastLine = lines.at(-1);
    if (!lastLine) {
        throw new Error(
            [
                `Expected JSON output from CLI command: ${commandLabel}`,
                ...context,
            ].join(' | '),
        );
    }
    try {
        return JSON.parse(lastLine) as T;
    } catch (error) {
        throw new Error(
            [
                `Expected JSON output from CLI command: ${commandLabel}`,
                `parseError=${error instanceof Error ? error.message : String(error)}`,
                ...context,
            ].join(' | '),
        );
    }
}

async function readLatestSessionMessageSeq(params: {
    baseUrl: string;
    token: string;
    sessionId: string;
}): Promise<number> {
    const rows = await fetchMessagesSince({
        baseUrl: params.baseUrl,
        token: params.token,
        sessionId: params.sessionId,
        afterSeq: 0,
    });
    return rows.reduce((max, row) => Math.max(max, row.seq), 0);
}

describe('core e2e: CLI update continuity reattaches the existing fake Claude session without provider restart', () => {
    let server: StartedServer | null = null;
    let daemon: StartedDaemon | null = null;
    let daemonHomeDir: string | null = null;

    afterEach(async () => {
        if (daemonHomeDir) {
            await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
            daemonHomeDir = null;
        }
        await daemon?.stop().catch(() => {});
        daemon = null;
        await server?.stop().catch(() => {});
        server = null;
    });

    afterAll(async () => {
        if (daemonHomeDir) {
            await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
        }
        await daemon?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    it('keeps the same fake Claude session id and provider process after replacing the daemon with the updated CLI', async () => {
        const testDir = run.testDir(`cli-update-continuity-${randomUUID()}`);
        server = await startServerLight({ testDir, dbProvider: 'sqlite' });
        const auth = await createTestAuth(server.baseUrl);

        daemonHomeDir = resolve(join(testDir, 'daemon-home'));
        const workspaceDir = resolve(join(testDir, 'workspace'));
        await mkdir(daemonHomeDir, { recursive: true });
        await mkdir(workspaceDir, { recursive: true });

        const secret = Uint8Array.from(randomBytes(32));
        await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

        const fakeClaudePath = fakeClaudeFixturePath();
        const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
        const daemonEnv = {
            ...process.env,
            CI: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_HOME_DIR: daemonHomeDir,
            HAPPIER_SERVER_URL: server.baseUrl,
            HAPPIER_WEBAPP_URL: server.baseUrl,
            HAPPIER_CLAUDE_PATH: fakeClaudePath,
            HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        };
        const updateSources = resolveCliUpdateSourcePairFromEnv(process.env);
        const fromSnapshotDir = await prepareCliUpdateSourceSnapshot({
            testDir,
            role: 'from',
            source: updateSources.from,
            env: daemonEnv,
        });
        const sameSourcePair =
            updateSources.from.kind === updateSources.to.kind
            && updateSources.from.ref === updateSources.to.ref;
        const toSnapshotDir = sameSourcePair
            ? fromSnapshotDir
            : await prepareCliUpdateSourceSnapshot({
                testDir,
                role: 'to',
                source: updateSources.to,
                env: daemonEnv,
            });
        const launchEnv = resolveCliUpdateValidationLaunchEnv(daemonEnv);

        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: launchEnv,
            snapshotDir: fromSnapshotDir,
            cleanupDescendantsOnExit: false,
        });
        const originalDaemonPid = daemon.state.pid;

        const spawnRes = await daemonControlPostJson({
            port: daemon.state.httpPort,
            path: '/spawn-session',
            controlToken: daemon.state.controlToken,
            body: {
                directory: workspaceDir,
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                terminal: { mode: 'plain' },
                environmentVariables: launchEnv,
            },
        });
        expect(spawnRes.status).toBe(200);
        expect(spawnRes.data.success).toBe(true);
        const sessionId = spawnRes.data.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('Missing sessionId from daemon spawn-session');
        }

        const firstPrompt = `CLI_UPDATE_CONTINUITY_FIRST_${randomUUID()}`;
        await enqueueSessionPromptForScenario({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            text: firstPrompt,
        });

        const firstSdkInvocation = await waitForFakeClaudeInvocation(fakeLogPath, (invocation) => invocation.mode === 'sdk', { timeoutMs: 60_000 });
        await waitForAssistantMessageContaining({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            requiredSubstring: 'FAKE_CLAUDE_OK_1',
            timeoutMs: 120_000,
        });

        const claudeSessionIdBefore = await readFakeClaudeSessionId({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
        });
        expect(typeof claudeSessionIdBefore).toBe('string');
        expect(claudeSessionIdBefore).toBeTruthy();
        expect(await readFakeClaudeSdkInvocationCount(fakeLogPath)).toBe(1);

        const firstSdkPid = firstSdkInvocation.pid;
        if (typeof firstSdkPid !== 'number') {
            throw new Error('Expected fake Claude SDK invocation to record a numeric PID');
        }
        assertPidAlive(firstSdkPid);

        const listedBeforeUpdate = await daemonControlPostJson({
            port: daemon.state.httpPort,
            path: '/list',
            controlToken: daemon.state.controlToken,
        });
        expect(listedBeforeUpdate.status).toBe(200);
        const originalDaemonSession = listedBeforeUpdate.data.children.find((child: { happySessionId?: string }) => child.happySessionId === sessionId);
        const originalRunnerPid = originalDaemonSession?.pid;
        if (typeof originalRunnerPid !== 'number') {
            throw new Error('Expected daemon /list to expose the original runner PID');
        }

        const updatedDaemonState = await replaceTestDaemonWithoutStoppingSessions({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: launchEnv,
            originalDaemon: daemon,
            snapshotDir: toSnapshotDir,
            stdoutPath: resolve(testDir, 'daemon.cli-update.stdout.log'),
            stderrPath: resolve(testDir, 'daemon.cli-update.stderr.log'),
        });
        expect(updatedDaemonState.pid).not.toBe(originalDaemonPid);
        expect(await readDaemonState(daemonHomeDir)).toEqual(expect.objectContaining({
            pid: updatedDaemonState.pid,
            httpPort: updatedDaemonState.httpPort,
        }));

        await runCliServerTestFromSnapshot({
            testDir,
            snapshotDir: toSnapshotDir,
            happyHomeDir: daemonHomeDir,
            env: launchEnv,
        });

        await waitFor(async () => {
            const listed = await daemonControlPostJson({
                port: updatedDaemonState.httpPort,
                path: '/list',
                controlToken: updatedDaemonState.controlToken,
            });
            expect(listed.status).toBe(200);
            expect(Array.isArray(listed.data.children)).toBe(true);
            expect(listed.data.children).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        happySessionId: sessionId,
                        startedBy: 'daemon',
                        pid: originalRunnerPid,
                    }),
                ]),
            );
            return true;
        }, { timeoutMs: 30_000 });
        assertPidAlive(firstSdkPid);

        const secondPrompt = `CLI_UPDATE_CONTINUITY_SECOND_${randomUUID()}`;
        await enqueueSessionPromptForScenario({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            text: secondPrompt,
        });

        await waitForAssistantMessageContaining({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            requiredSubstring: 'FAKE_CLAUDE_OK_2',
            timeoutMs: 120_000,
        });

        await waitFor(async () => {
            expect(await readFakeClaudeSdkInvocationCount(fakeLogPath)).toBe(1);
            const activeServer = server;
            if (!activeServer) {
                throw new Error('Expected server to be running for final CLI-update continuity assertion');
            }
            expect(
                await readFakeClaudeSessionId({
                    baseUrl: activeServer.baseUrl,
                    token: auth.token,
                    sessionId,
                    secret,
                }),
            ).toBe(claudeSessionIdBefore);
            return true;
        }, { timeoutMs: 30_000 });
    }, CLI_UPDATE_CONTINUITY_TEST_TIMEOUT_MS);

    it('explicitly restarts the session runner on the updated CLI while preserving the Happier session', async () => {
        const testDir = run.testDir(`cli-update-planned-runner-restart-${randomUUID()}`);
        server = await startServerLight({ testDir, dbProvider: 'sqlite' });
        const auth = await createTestAuth(server.baseUrl);

        daemonHomeDir = resolve(join(testDir, 'daemon-home'));
        const workspaceDir = resolve(join(testDir, 'workspace'));
        await mkdir(daemonHomeDir, { recursive: true });
        await mkdir(workspaceDir, { recursive: true });

        const secret = Uint8Array.from(randomBytes(32));
        await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

        const fakeClaudePath = fakeClaudeFixturePath();
        const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
        const daemonEnv = {
            ...process.env,
            CI: '1',
            HAPPIER_LOG_LEVEL: 'debug',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_HOME_DIR: daemonHomeDir,
            HAPPIER_SERVER_URL: server.baseUrl,
            HAPPIER_WEBAPP_URL: server.baseUrl,
            HAPPIER_CLAUDE_PATH: fakeClaudePath,
            HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        };
        const updateSources = resolveCliUpdateSourcePairFromEnv(process.env);
        const fromSnapshotDir = await prepareCliUpdateSourceSnapshot({
            testDir,
            role: 'from',
            source: updateSources.from,
            env: daemonEnv,
        });
        const sameSourcePair =
            updateSources.from.kind === updateSources.to.kind
            && updateSources.from.ref === updateSources.to.ref;
        const toSnapshotDir = sameSourcePair
            ? fromSnapshotDir
            : await prepareCliUpdateSourceSnapshot({
                testDir,
                role: 'to',
                source: updateSources.to,
                env: daemonEnv,
            });
        const launchEnv = resolveCliUpdateValidationLaunchEnv(daemonEnv);

        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: launchEnv,
            snapshotDir: fromSnapshotDir,
            cleanupDescendantsOnExit: false,
        });
        const originalDaemonPid = daemon.state.pid;

        const spawnRes = await daemonControlPostJson({
            port: daemon.state.httpPort,
            path: '/spawn-session',
            controlToken: daemon.state.controlToken,
            body: {
                directory: workspaceDir,
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                terminal: { mode: 'plain' },
                environmentVariables: launchEnv,
            },
        });
        expect(spawnRes.status).toBe(200);
        expect(spawnRes.data.success).toBe(true);
        const sessionId = spawnRes.data.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('Missing sessionId from daemon spawn-session');
        }

        const firstPrompt = `CLI_UPDATE_PLANNED_RESTART_FIRST_${randomUUID()}`;
        await enqueueSessionPromptForScenario({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            text: firstPrompt,
        });

        await waitForFakeClaudeInvocation(fakeLogPath, (invocation) => invocation.mode === 'sdk', { timeoutMs: 60_000 });
        await waitForAssistantMessageContaining({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            requiredSubstring: 'FAKE_CLAUDE_OK_1',
            timeoutMs: 120_000,
        });

        const claudeSessionIdBefore = await readFakeClaudeSessionId({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
        });
        expect(typeof claudeSessionIdBefore).toBe('string');
        expect(claudeSessionIdBefore).toBeTruthy();

        const originalDaemonSession = await waitForListedDaemonSession({
            port: daemon.state.httpPort,
            controlToken: daemon.state.controlToken,
            sessionId,
        });
        expect(originalDaemonSession.startedBy).toBe('daemon');
        const originalRunnerPid = originalDaemonSession.pid;
        const originalRunnerMarker = await waitForDaemonSessionMarkerSnapshot({
            happyHomeDir: daemonHomeDir,
            sessionId,
            expectedPid: originalRunnerPid,
        });

        // Settle the first turn before replacing its daemon, then observe the
        // replacement daemon's admission after reattachment before restarting.
        await waitForRestartableDaemonSession({
            testDir,
            port: daemon.state.httpPort,
            controlToken: daemon.state.controlToken,
            sessionId,
        });

        const updatedDaemonState = await replaceTestDaemonWithoutStoppingSessions({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: launchEnv,
            originalDaemon: daemon,
            snapshotDir: toSnapshotDir,
            stdoutPath: resolve(testDir, 'daemon.cli-update-planned-restart.stdout.log'),
            stderrPath: resolve(testDir, 'daemon.cli-update-planned-restart.stderr.log'),
        });
        expect(updatedDaemonState.pid).not.toBe(originalDaemonPid);

        await waitForListedDaemonSession({
            port: updatedDaemonState.httpPort,
            controlToken: updatedDaemonState.controlToken,
            sessionId,
            expectedPid: originalRunnerPid,
        });

        await waitForRestartableDaemonSession({
            testDir,
            port: updatedDaemonState.httpPort,
            controlToken: updatedDaemonState.controlToken,
            sessionId,
        });

        const restartSummary = await runCliJsonCommandFromSnapshot<RestartSessionRunnerCommandJson>({
            testDir,
            snapshotDir: toSnapshotDir,
            happyHomeDir: daemonHomeDir,
            env: launchEnv,
            args: [
                'daemon',
                'restart-session-runners',
                '--session-id',
                sessionId,
                '--force-current-cli',
                '--json',
            ],
            stdoutName: 'cli-update.restart-session-runners.stdout.log',
            stderrName: 'cli-update.restart-session-runners.stderr.log',
            timeoutMs: 180_000,
        });
        expect(restartSummary).toEqual(expect.objectContaining({
            ok: true,
            status: 'restarted',
            sessionId,
        }));

        const restartedDaemonSession = await waitForListedDaemonSession({
            port: updatedDaemonState.httpPort,
            controlToken: updatedDaemonState.controlToken,
            sessionId,
            rejectPid: originalRunnerPid,
            timeoutMs: 60_000,
        });
        expect(restartedDaemonSession.startedBy).toBe('daemon');
        expect(restartedDaemonSession.pid).not.toBe(originalRunnerPid);

        const restartedRunnerMarker = await waitForDaemonSessionMarkerSnapshot({
            happyHomeDir: daemonHomeDir,
            sessionId,
            expectedPid: restartedDaemonSession.pid,
            timeoutMs: 60_000,
        });
        if (!sameSourcePair) {
            expect(restartedRunnerMarker.processCommandHash).not.toBe(originalRunnerMarker.processCommandHash);
        } else {
            expect(restartedRunnerMarker.processCommandHash).toBeTruthy();
        }

        const afterRestartSeq = await readLatestSessionMessageSeq({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
        });
        const secondPrompt = `CLI_UPDATE_PLANNED_RESTART_SECOND_${randomUUID()}`;
        await enqueueSessionPromptForScenario({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
            text: secondPrompt,
        });

        try {
            await waitForFakeClaudeUserText(fakeLogPath, (text) => text.includes(secondPrompt), { timeoutMs: 90_000, pollMs: 150 });
            await waitForAssistantMessageContaining({
                baseUrl: server.baseUrl,
                token: auth.token,
                sessionId,
                secret,
                requiredSubstring: 'FAKE_CLAUDE_OK_',
                afterSeqStart: afterRestartSeq,
                timeoutMs: 120_000,
            });
        } finally {
            // Snapshot while the server and restarted runner are still alive. Keep
            // each read's failure as evidence without hiding the original timeout.
            const snapshots = await Promise.allSettled([
                listPendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, includeDiscarded: true }),
                fetchSessionV2(server.baseUrl, auth.token, sessionId),
            ]);
            await writeFile(resolve(testDir, 'cli-update.post-restart-delivery.json'), JSON.stringify({
                sessionId,
                runnerPid: restartedDaemonSession.pid,
                observedAt: new Date().toISOString(),
                pending: snapshots[0].status === 'fulfilled' ? snapshots[0].value : { error: String(snapshots[0].reason) },
                session: snapshots[1].status === 'fulfilled' ? snapshots[1].value : { error: String(snapshots[1].reason) },
            }, null, 2));
        }

        const activeServer = server;
        if (!activeServer) {
            throw new Error('Expected server to be running for final planned-restart continuity assertion');
        }
        expect(
            await readFakeClaudeSessionId({
                baseUrl: activeServer.baseUrl,
                token: auth.token,
                sessionId,
                secret,
            }),
        ).toBe(claudeSessionIdBefore);
        expect(await readFakeClaudeSdkInvocationCount(fakeLogPath)).toBeGreaterThanOrEqual(1);
    }, CLI_UPDATE_CONTINUITY_TEST_TIMEOUT_MS);
});
