import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { fetchSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';

const run = createRunDirs({ runLabel: 'core' });

function jsonlLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
    return jsonlLine({ type: 'response_item', timestamp: params.timestamp, payload: params.payload });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('core e2e: direct Codex session detach watcher release', () => {
    let server: StartedServer | null = null;
    let daemon: StartedDaemon | null = null;

    afterEach(async () => {
        await daemon?.stop().catch(() => {});
        daemon = null;
        await server?.stop().catch(() => {});
        server = null;
    });

    afterAll(async () => {
        await daemon?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    it('does not keep detached attached-only Codex sessions hot after the view lease releases', async () => {
        const testDir = run.testDir('direct-sessions-codex-detach-release');
        const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
        const codexHomeDir = resolve(join(testDir, '.codex'));
        const rolloutFile = resolve(
            join(codexHomeDir, 'sessions', '2026', '03', '06', 'rollout-2026-03-06T00-00-00-33333333-3333-3333-3333-333333333333.jsonl'),
        );
        const remoteSessionId = '33333333-3333-3333-3333-333333333333';

        await mkdir(daemonHomeDir, { recursive: true });
        await mkdir(resolve(join(codexHomeDir, 'sessions', '2026', '03', '06')), { recursive: true });
        await writeFile(
            rolloutFile,
            [
                jsonlLine({
                    type: 'session_meta',
                    payload: {
                        id: remoteSessionId,
                        timestamp: '2026-03-06T00:00:00.000Z',
                        cwd: '/tmp/direct-codex-detach-project',
                    },
                }),
                responseItemLine({
                    timestamp: '2026-03-06T00:00:01.000Z',
                    payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'detach seed reply' }] },
                }),
            ].join(''),
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

        const seeded = await seedCliAuthForTestAccount({
            cliHome: daemonHomeDir,
            serverUrl: server.baseUrl,
            auth,
            mode: 'dataKey',
        });

        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: {
                ...process.env,
                CI: '1',
                HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE: 'testdir',
                HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPIER_HOME_DIR: daemonHomeDir,
                HAPPIER_SERVER_URL: server.baseUrl,
                CODEX_HOME: codexHomeDir,
                HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
            },
        });

        const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
        ui.connect();

        try {
            await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'socket connected for direct Codex detach release e2e' });

            const machineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);

            const link = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
                machineId: seeded.machineId,
                providerId: 'codex',
                remoteSessionId,
                titleHint: 'Detached Codex view lease release fixture',
                directoryHint: '/tmp/direct-codex-detach-project',
                source: { kind: 'codexHome', home: 'user' },
            });
            const linkResult = unwrapDataKeyRpcResult(link, 'direct Codex detach release link');
            expect(linkResult).toEqual(expect.objectContaining({
                ok: true,
                created: true,
            }));
            const sessionId = (linkResult as { sessionId: string }).sessionId;

            const attach = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH}`, {
                machineId: seeded.machineId,
                sessionId,
                providerId: 'codex',
                remoteSessionId,
                source: { kind: 'codexHome', home: 'user' },
                ttlMs: 30_000,
            });
            const attachResult = unwrapDataKeyRpcResult(attach, 'direct Codex attach before detach release');
            expect(attachResult).toEqual(expect.objectContaining({
                ok: true,
                renewed: false,
            }));

            const detach = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH}`, {
                machineId: seeded.machineId,
                sessionId,
                leaseId: (attachResult as { leaseId: string }).leaseId,
            });
            const detachResult = unwrapDataKeyRpcResult(detach, 'direct Codex detach before watcher release assertion');
            expect(detachResult).toEqual(expect.objectContaining({
                ok: true,
                detached: true,
            }));

            await appendFile(
                rolloutFile,
                responseItemLine({
                    timestamp: '2026-03-06T00:00:02.000Z',
                    payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'detached attached-only codex delta' }] },
                }),
                'utf8',
            );

            await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));

            const metadataAfterDetach = await fetchSessionMetadataV2({
                baseUrl: server.baseUrl,
                token: auth.token,
                sessionId,
                machineKeys: [auth.accountMachineKey],
            });
            const externalSession = isRecord(metadataAfterDetach.externalSessionV1) ? metadataAfterDetach.externalSessionV1 : null;
            expect(externalSession).toEqual(expect.objectContaining({
                v: 1,
                providerId: 'codex',
                remoteSessionId,
            }));
            expect(externalSession).not.toHaveProperty('lastKnownActivityAtMs');
            expect(metadataAfterDetach).not.toHaveProperty('externalSessionAttentionV1');
        } finally {
            ui.close();
        }
    }, 240_000);
});
