import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ActionsSettingsV1Schema, createActionExecutor } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { SignedRootActionExecuteRequestSchema } from '@/daemon/externalActions/signedRootActionControl';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
    { actionId: 'machines.capabilities.detect', extra: {}, result: { ok: true, result: { status: 'completed' } } },
    { actionId: 'machines.reboot', extra: { expectedInstallationId: 'reviewed-installation' }, result: { ok: true, result: { kind: 'unavailable', reason: 'needs_attendance' } } },
] as const)('delivers the Home alias offered by machines.list as a portable $actionId operand to another daemon profile', async ({ actionId, extra, result }) => {
    const serverId = 'stack_agent-qa-servers-deploy__id_qa-fixtures-1103-a';
    const serverIdentityId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const machineId = 'qa-tools-machine';
    await withConfiguredDaemonTestHome({ prefix: 'happier-machine-home-',
        env: { HAPPIER_ACTIVE_SERVER_ID: serverId, HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined } }, async () => {
        expect(configuration.activeServerId).toBe(serverId);
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const delivered: unknown[] = [];
        // Substitute the daemon HTTP receiver and process/native execution
        // adapters. Both executors and the receiver's Home guard remain real;
        // no native detection, network change or reboot runs in this test.
        const receiver = createActionExecutor({
            machinePageAction: async request => { delivered.push(request.input); return { status: 'completed' }; },
            machineReboot: async request => {
                delivered.push(request.input);
                return { kind: 'unavailable', reason: 'needs_attendance' };
            },
        });
        const http = createServer(async (request, response) => {
            try {
                expect(request.url).toBe('/actions/root/execute');
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const body = SignedRootActionExecuteRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
                const execution = await receiver.execute(body.actionId, body.input, { surface: 'cli',
                    authority: 'present_user', serverId: 'different-daemon-profile', serverIdentityId,
                    bypassApprovals: true });
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify(execution));
            } catch (error) {
                response.writeHead(500);
                response.end(JSON.stringify({ error: String(error) }));
            }
        });
        http.listen(0, '127.0.0.1');
        await once(http, 'listening');
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing daemon HTTP address');
        writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test',
            controlToken: 'fixture-control-token', machineId, accountId: 'owner' });
        try {
            const executor = createCliActionExecutorFromCredentials({
                credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
                serverId: configuration.activeServerId, serverIdentityId, serverApiUrl: 'https://home.test', machineId,
                externalActionClient: true,
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
            });
            for (const selectedHome of [configuration.activeServerId, serverIdentityId]) {
                await expect(executor.execute(actionId, { serverId: selectedHome, machineId, ...extra }, { surface: 'cli' }))
                    .resolves.toEqual(result);
            }
            await expect(executor.execute(actionId, { serverId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', machineId, ...extra }, { surface: 'cli' }))
                .resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
            expect(delivered).toEqual([{ serverId: serverIdentityId, machineId, ...extra }, { serverId: serverIdentityId, machineId, ...extra }]);
        } finally {
            http.closeAllConnections();
            await new Promise<void>(resolve => http.close(() => resolve()));
        }
    });
});
