import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
    EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1,
    ExecutionRunStartResponseSchema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { callLegacyEncryptedSessionRpc as callSessionRpc } from '../../src/testkit/sessionRpc';
import {
    createLocalExtensionPackageManifest,
    writeEnabledLocalPathPluginState,
    writeLocalPathPluginFixture,
} from '../../src/testkit/plugins/localPathPluginFixture';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: bridge lifecycle hook dispatch', () => {
    let server: StartedServer | null = null;
    let daemon: StartedDaemon | null = null;

    afterAll(async () => {
        await daemon?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    }, 60_000);

    it('executes plugin hook logic after a real execution-run bridge start event', async () => {
        const testDir = run.testDir(`bridge-lifecycle-hook-dispatch-${randomUUID()}`);
        const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
        const workspaceDir = resolve(join(testDir, 'workspace'));
        const pluginRoot = resolve(join(testDir, 'plugin-root'));
        const markerPath = resolve(join(testDir, 'bridge-lifecycle-hook-fired.json'));

        await Promise.all([
            mkdir(daemonHomeDir, { recursive: true }),
            mkdir(workspaceDir, { recursive: true }),
            mkdir(pluginRoot, { recursive: true }),
        ]);

        server = await startServerLight({ testDir });
        const serverBaseUrl = server.baseUrl;
        const auth = await createTestAuth(serverBaseUrl);

        const secret = Uint8Array.from(randomBytes(32));
        await seedCliAuthForServer({
            cliHome: daemonHomeDir,
            serverUrl: serverBaseUrl,
            token: auth.token,
            secret,
        });

        await writeLocalPathPluginFixture({
            pluginRoot,
            daemonModuleContents: [
                'import { writeFile } from "node:fs/promises";',
                '',
                'export async function recordBridgeLifecycleInvocation(event = {}) {',
                '  const markerPath = process.env.HAPPIER_E2E_HOOK_MARKER_PATH;',
                '  if (typeof markerPath !== "string" || markerPath.length === 0) {',
                '    throw new Error("Missing HAPPIER_E2E_HOOK_MARKER_PATH");',
                '  }',
                '',
                '  await writeFile(markerPath, JSON.stringify(event, null, 2), "utf8");',
                '  return "bridge-lifecycle-hook-fired";',
                '}',
                '',
            ].join('\n'),
            manifest: createLocalExtensionPackageManifest({
                pluginId: 'acme.bridge.lifecycle.fixture',
                displayName: 'Bridge Lifecycle Fixture',
                description: 'Exercises bridge-owned lifecycle hook execution through a real execution-run host event',
                contributes: {
                    hooks: [
                        {
                            hookApiVersion: 1,
                            id: EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1[0],
                            category: 'lifecycle',
                            scope: 'session',
                            executionKind: 'observe',
                            handler: {
                                target: 'plugin',
                                exportName: 'recordBridgeLifecycleInvocation',
                            },
                        },
                    ],
                },
            }),
        });

        await writeEnabledLocalPathPluginState({
            happyHomeDir: daemonHomeDir,
            pluginRoot,
            pluginId: 'acme.bridge.lifecycle.fixture',
        });

        const fakeClaudePath = fakeClaudeFixturePath();
        const fakeClaudeLog = resolve(join(testDir, 'fake-claude.jsonl'));
        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: {
                ...process.env,
                CI: '1',
                HAPPIER_VARIANT: 'dev',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_HOME_DIR: daemonHomeDir,
                HAPPIER_SERVER_URL: serverBaseUrl,
                HAPPIER_WEBAPP_URL: serverBaseUrl,
                HAPPIER_CLAUDE_PATH: fakeClaudePath,
                HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
                HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'plan-json',
                HAPPIER_E2E_HOOK_MARKER_PATH: markerPath,
            },
        });
        const controlToken = (
            daemon.state as Readonly<{
                controlToken?: string | null;
            }>
        ).controlToken ?? undefined;

        const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
            port: daemon.state.httpPort,
            path: '/spawn-session',
            controlToken,
            body: {
                directory: workspaceDir,
                terminal: { mode: 'plain' },
                environmentVariables: {
                    HAPPIER_HOME_DIR: daemonHomeDir,
                    HAPPIER_SERVER_URL: serverBaseUrl,
                    HAPPIER_WEBAPP_URL: serverBaseUrl,
                    HAPPIER_VARIANT: 'dev',
                    HAPPIER_DISABLE_CAFFEINATE: '1',
                    HAPPIER_CLAUDE_PATH: fakeClaudePath,
                    HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
                    HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'plan-json',
                },
            },
            timeoutMs: 90_000,
        });

        expect(spawnRes.status, JSON.stringify(spawnRes.data, null, 2)).toBe(200);
        expect(spawnRes.data.success).toBe(true);
        const sessionId = spawnRes.data.sessionId;
        expect(typeof sessionId).toBe('string');
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('Missing sessionId from daemon spawn-session');
        }

        const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
        ui.connect();
        await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

        try {
            const started = await callSessionRpc({
                ui,
                sessionId,
                method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
                req: {
                    intent: 'plan',
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    instructions: 'Generate a plan for bridge lifecycle hook proof validation.',
                    permissionMode: 'read_only',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                },
                secret,
                schema: ExecutionRunStartResponseSchema,
                timeoutMs: 40_000,
            });

            let markerJson = '';
            await waitFor(async () => {
                markerJson = await readFile(markerPath, 'utf8').catch(() => '');
                return markerJson.includes(`"eventId": "${EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1[0]}"`);
            }, {
                timeoutMs: 60_000,
                intervalMs: 250,
                context: `bridge lifecycle hook marker for ${EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1[0]}`,
            });

            const marker = JSON.parse(markerJson) as Readonly<Record<string, unknown>>;
            const markerPayload = (
                typeof marker.payload === 'object' && marker.payload !== null
                    ? marker.payload
                    : {}
            ) as Readonly<Record<string, unknown>>;
            expect(marker.eventId).toBe(EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1[0]);
            expect(marker.happySessionId).toBe(sessionId);
            expect(markerPayload.runId).toBe(started.runId);
            expect(markerPayload.intent).toBe('plan');
        } finally {
            ui.disconnect();
        }
    }, 240_000);
});
