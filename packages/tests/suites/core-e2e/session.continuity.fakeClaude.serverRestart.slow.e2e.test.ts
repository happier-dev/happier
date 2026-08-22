import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon, stopDaemonFromHomeDir, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { waitFor } from '../../src/testkit/timing';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { enqueueSessionPromptForScenario, waitForAssistantMessageContaining, waitForSessionActive } from '../../src/testkit/providers/scenarios/sessionRuntime';

const run = createRunDirs({ runLabel: 'core' });

type FakeClaudeLogEntry = {
    type?: unknown;
    mode?: unknown;
};

type ReadClaudeSessionIdParams = {
    baseUrl: string;
    token: string;
    sessionId: string;
    secret: Uint8Array;
};

function parseJsonl(raw: string): FakeClaudeLogEntry[] {
    return raw
        .split('\n')
        .map((line: string) => line.trim())
        .filter(Boolean)
        .flatMap((line: string) => {
            try {
                return [JSON.parse(line) as FakeClaudeLogEntry];
            } catch {
                return [];
            }
        });
}

async function readSdkInvocationCount(logPath: string): Promise<number> {
    const raw = await readFile(logPath, 'utf8').catch(() => '');
    return parseJsonl(raw).filter((entry: FakeClaudeLogEntry) => entry.type === 'invocation' && entry.mode === 'sdk').length;
}

async function readClaudeSessionId(params: ReadClaudeSessionIdParams): Promise<string | null> {
    const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    const metadata = decryptLegacyBase64(snap.metadata, params.secret) as { claudeSessionId?: unknown } | null;
    return typeof metadata?.claudeSessionId === 'string' ? metadata.claudeSessionId : null;
}

describe('core e2e: session continuity survives server restart without restarting the fake Claude provider session', () => {
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

    it('keeps the same fake Claude session id and provider process across server restart', async () => {
        const testDir = run.testDir(`session-continuity-${randomUUID()}`);
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
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        };

        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: daemonEnv,
        });

        const spawnRes = await daemonControlPostJson({
            port: daemon.state.httpPort,
            path: '/spawn-session',
            controlToken: daemon.state.controlToken,
            body: {
                directory: workspaceDir,
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                terminal: { mode: 'plain' },
                environmentVariables: daemonEnv,
            },
        });
        expect(spawnRes.status).toBe(200);
        expect(spawnRes.data.success).toBe(true);
        const sessionId = spawnRes.data.sessionId;
        expect(typeof sessionId).toBe('string');
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('Missing sessionId from daemon spawn-session');
        }

        const firstPrompt = `SERVER_CONTINUITY_FIRST_${randomUUID()}`;
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

        const claudeSessionIdBefore = await readClaudeSessionId({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            secret,
        });
        expect(typeof claudeSessionIdBefore).toBe('string');
        expect(claudeSessionIdBefore).toBeTruthy();
        expect(await readSdkInvocationCount(fakeLogPath)).toBe(1);

        const port = server.port;
        await server.stop();
        server = await startServerLight({
            testDir,
            dbProvider: 'sqlite',
            dataDirMode: 'reuse-existing',
            __portAllocator: async () => port,
        });

        await waitForSessionActive({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId,
            timeoutMs: 60_000,
        });

        const secondPrompt = `SERVER_CONTINUITY_SECOND_${randomUUID()}`;
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
            expect(await readSdkInvocationCount(fakeLogPath)).toBe(1);
            const activeServer = server;
            if (!activeServer) {
                throw new Error('Expected server to be running for final server continuity assertion');
            }
            expect(
                await readClaudeSessionId({
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
