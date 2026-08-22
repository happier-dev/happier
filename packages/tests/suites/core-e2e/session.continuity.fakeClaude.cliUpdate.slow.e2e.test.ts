import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import {
    readDaemonState,
    replaceTestDaemonWithoutStoppingSessions,
    startTestDaemon,
    stopDaemonFromHomeDir,
    type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
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
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

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

describe('core e2e: CLI update continuity reattaches the existing fake Claude session without provider restart', () => {
    let server: StartedServer | null = null;
    let daemon: StartedDaemon | null = null;
    let retiredDaemon: StartedDaemon | null = null;
    let daemonHomeDir: string | null = null;

    afterEach(async () => {
        const cleanupErrors: Error[] = [];
        await daemon?.stop().catch((error: unknown) => {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        });
        daemon = null;
        await retiredDaemon?.proc.stop().catch((error: unknown) => {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        });
        retiredDaemon = null;
        if (daemonHomeDir) {
            await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
            daemonHomeDir = null;
        }
        await server?.stop().catch(() => {});
        server = null;
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'CLI update continuity teardown failed');
    });

    afterAll(async () => {
        if (daemonHomeDir) {
            await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
        }
        await daemon?.stop().catch(() => {});
        await retiredDaemon?.proc.stop().catch(() => {});
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

        const secret = auth.accountSigningSeed;
        await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, auth, mode: 'legacy' });

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
        const toSnapshotDir = await prepareCliUpdateSourceSnapshot({
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
        retiredDaemon = daemon;
        daemon = updatedDaemonState;
        expect(updatedDaemonState.state.pid).not.toBe(originalDaemonPid);
        expect(await readDaemonState(daemonHomeDir)).toEqual(expect.objectContaining({
            pid: updatedDaemonState.state.pid,
            httpPort: updatedDaemonState.state.httpPort,
        }));

        await runCliServerTestFromSnapshot({
            testDir,
            snapshotDir: toSnapshotDir,
            happyHomeDir: daemonHomeDir,
            env: launchEnv,
        });

        await waitFor(async () => {
            const listed = await daemonControlPostJson({
                port: updatedDaemonState.state.httpPort,
                path: '/list',
                controlToken: updatedDaemonState.state.controlToken,
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
    }, 240_000);
});
