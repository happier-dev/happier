import { constants as bufferConstants } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { resolveClaudeProjectId } from '../../src/testkit/claudeProjectId.cjs';
import { sanitizeDaemonEnvForSpawn, startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { enqueueSessionPromptForScenario, waitForAssistantMessageContaining } from '../../src/testkit/providers/scenarios/sessionRuntime';
import { readFakeClaudeSessionId } from '../../src/testkit/providers/fakeClaudeContinuity';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const processes: SpawnedProcess[] = [];
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let daemon: StartedDaemon | undefined;

afterEach(async () => {
    for (const child of processes.reverse()) await child.stop();
    processes.length = 0;
    await daemon?.stop();
    daemon = undefined;
    await server?.stop();
    server = undefined;
});

it('preserves a terminal-selected Claude account and refuses a second entry for its live conversation', async () => {
    const testDir = run.testDir(`resume-account-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);
    const home = resolve(testDir, 'home');
    const workspace = resolve(testDir, 'workspace');
    const accountA = resolve(testDir, 'account-a');
    const accountB = resolve(testDir, 'account-b');
    for (const dir of [home, workspace, accountA, accountB]) await mkdir(dir, { recursive: true });
    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: home, serverUrl: server.baseUrl, token: auth.token, secret });
    const log = resolve(testDir, 'fake-claude.jsonl');
    const env = sanitizeDaemonEnvForSpawn({
        ...process.env,
        CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), HAPPIER_E2E_FAKE_CLAUDE_LOG: log,
        CLAUDE_CONFIG_DIR: accountA,
    });
    delete env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
    const snapshotDir = resolve(testDir, 'cli-dist');
    const cliLaunchSpec = await resolveCliTestLaunchSpec({ testDir, env }, { snapshotDir });
    daemon = await startTestDaemon({ testDir, happyHomeDir: home, env, snapshotDir });
    const launch = (label: string, args: string[], childEnv = env) => {
        const child = spawnLoggedProcess({
            command: cliLaunchSpec.command, args: [...cliLaunchSpec.args, ...args],
            cwd: workspace, env: { ...childEnv, ...cliLaunchSpec.env },
            stdoutPath: resolve(testDir, `${label}.stdout.log`), stderrPath: resolve(testDir, `${label}.stderr.log`),
        });
        processes.push(child);
        return child;
    };
    const state = daemon.state;
    const control = <T>(path: string, body?: Record<string, unknown>) => daemonControlPostJson<T>({
        port: state.httpPort, controlToken: state.controlToken, path, body,
    });
    const terminal = launch('terminal', ['claude', '--happy-starting-mode', 'remote'], {
        ...env, CLAUDE_CONFIG_DIR: accountB,
    });
    let sessionId = '';
    await waitFor(async () => {
        const list = await control<{ children: { happySessionId?: string; pid?: number }[] }>('/list');
        const session = list.data.children.find((child) => child.pid === terminal.child.pid && child.happySessionId);
        if (!session?.happySessionId) throw new Error(`Waiting for terminal registration; logs: ${testDir}`);
        sessionId = session.happySessionId;
        return true;
    }, { timeoutMs: 60_000 });
    await enqueueSessionPromptForScenario({ baseUrl: server.baseUrl, token: auth.token, sessionId, secret, text: 'FIRST' });
    const first = await waitForFakeClaudeInvocation(log, (entry) => entry.mode === 'sdk', { timeoutMs: 60_000 });
    expect(first.claudeConfigDir).toBe(accountB);
    await waitForAssistantMessageContaining({ baseUrl: server.baseUrl, token: auth.token, sessionId, secret,
        requiredSubstring: 'FAKE_CLAUDE_OK_1', timeoutMs: 60_000 });
    const baseUrl = server.baseUrl;
    let vendorId = '';
    await waitFor(async () => {
        const publishedSessionId = await readFakeClaudeSessionId({ baseUrl, token: auth.token, sessionId, secret });
        if (!publishedSessionId) throw new Error('Fake Claude did not publish the session ID required for resume');
        vendorId = publishedSessionId;
        return true;
    }, { timeoutMs: 60_000 });
    await terminal.stop();
    const transcriptPath = resolve(accountB, 'projects', resolveClaudeProjectId(workspace), `${vendorId}.jsonl`);
    const transcript = await open(transcriptPath, 'r+');
    try {
        const { size } = await transcript.stat();
        // Pad with newline-delimited sparse rows so no record approaches the string limit.
        const newline = Buffer.from('\n');
        for (let offset = size; offset <= bufferConstants.MAX_STRING_LENGTH; offset += 64 * 1024) {
            await transcript.write(newline, 0, newline.length, offset + 64 * 1024 - 1);
        }
    } finally {
        await transcript.close();
    }
    const resumed = await control<{ success: boolean; sessionId?: string }>('/spawn-session', {
        directory: workspace, agent: 'claude', resume: vendorId, existingSessionId: sessionId,
        terminal: { mode: 'plain' },
    });
    expect(resumed.data.success).toBe(true);
    await enqueueSessionPromptForScenario({ baseUrl: server.baseUrl, token: auth.token, sessionId, secret, text: 'SECOND' });
    const second = await waitForFakeClaudeInvocation(log, (entry) => entry.mode === 'sdk' && entry.pid !== first.pid, { timeoutMs: 60_000 });
    expect(second.claudeConfigDir).toBe(accountB);
    expect(second.argv[second.argv.indexOf('--resume') + 1]).toBe(vendorId);
    const stopped = await control<{ status: string }>('/stop-session', { sessionId });
    expect(stopped.data.status).toBe('stopped');
    const replacement = launch('replacement', ['claude', '--happy-starting-mode', 'remote', '--resume', vendorId], {
        ...env, CLAUDE_CONFIG_DIR: accountB,
    });
    let replacementSessionId = '';
    await waitFor(async () => {
        const list = await control<{ children: { happySessionId?: string; pid?: number }[] }>('/list');
        const session = list.data.children.find((child) => child.pid === replacement.child.pid && child.happySessionId);
        if (!session?.happySessionId) return false;
        replacementSessionId = session.happySessionId;
        return true;
    }, { timeoutMs: 60_000 });
    expect(replacementSessionId).not.toBe(sessionId);
    await enqueueSessionPromptForScenario({ baseUrl: server.baseUrl, token: auth.token,
        sessionId: replacementSessionId, secret, text: 'REPLACEMENT' });
    const third = await waitForFakeClaudeInvocation(log,
        (entry) => entry.mode === 'sdk' && entry.pid !== first.pid && entry.pid !== second.pid, { timeoutMs: 60_000 });
    expect(third.claudeConfigDir).toBe(accountB);
    const duplicate = await control<{ success: boolean; sessionId?: string }>('/spawn-session', {
        directory: workspace, agent: 'claude', resume: vendorId, existingSessionId: sessionId,
        terminal: { mode: 'plain' },
    });
    expect(duplicate.data.success).toBe(false);
}, 240_000);
