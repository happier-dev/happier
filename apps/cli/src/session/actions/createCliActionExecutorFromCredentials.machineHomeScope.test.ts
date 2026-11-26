import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import axios from 'axios';
import nacl from 'tweetnacl';
import { ActionsSettingsV1Schema, createActionExecutor } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ExternalActionExecutionAuthorizationRequestV1Schema, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
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
        const homeRequests: unknown[] = [];
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
        if (actionId === 'machines.reboot') {
            const keys = nacl.sign.keyPair();
            const machine = { id: machineId, kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
                installationId: extra.expectedInstallationId, installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
                dataEncryptionKey: null, runnerContentKeyBinding: null,
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
            // Reboot's original-Account admission uses Home before the daemon receives it.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (url.endsWith(`/v1/machines/${machineId}`)) return { status: 200, data: { machine } };
                throw new Error(`Unexpected Home read ${url}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                homeRequests.push({ url, body });
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'reboot-home-proof', binding: {
                    accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 4 },
                    accountEncryptionMode: 'plain', serverIdentityId, machineId, installationId: machine.installationId,
                    actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                    deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope: request.envelope }),
                    ...(request.envelope.idempotencyKey ? { idempotencyKey: request.envelope.idempotencyKey } : {}),
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } };
                expect(url).toBe(`https://home.test/v1/actions/${actionId}`);
                expect(request.envelope.v).toBe(1);
                if (request.envelope.v !== 1) throw new Error('Plain Home fixture requires the plain envelope');
                const execution = await receiver.execute(actionId, request.envelope.input, { surface: 'cli', authority: 'present_user',
                    serverId: 'different-daemon-profile', serverIdentityId, bypassApprovals: true });
                return { status: 200, data: { v: 1, actionId, requestId: request.envelope.requestId, execution } };
            });
        }
        const http = createServer(async (request, response) => {
            if (request.method === 'POST' && request.url === '/ping') {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ status: 'ok' }));
                return;
            }
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
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }),
                    getAccountSettings: () => accountSettingsParse({}) },
            });
            for (const selectedHome of [configuration.activeServerId, serverIdentityId]) {
                const execution = await executor.execute(actionId, { serverId: selectedHome, machineId, ...extra }, { surface: 'cli' });
                expect(execution, JSON.stringify(homeRequests)).toEqual(result);
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
