import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { AccountSettingsSchema, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { ClientToServerEvents } from '@/api/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

afterEach(() => vi.restoreAllMocks());

it.each(['machines.managed.delete', 'machines.managed.power.set', 'machines.managed.inspect', 'machines.managed.acquire'] as const)('delivers public CLI %s approval to its retained controller instead of the Account effect endpoint', async actionId => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-delete-replay-' }, async () => {
        const accountId = 'delete-owner';
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        // Captured #48 shape: the explicit controller target survives a public
        // approval read even when private execution authorization is absent.
        const actionArgs = actionId === 'machines.managed.inspect' ? { homeId: 'srv_home', managedId: 'lima-leaf' }
            : actionId === 'machines.managed.acquire' ? { enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
                selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                    launch: { provider: { pluginId: 'compute.example', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }
            : { homeId: 'srv_home', managedId: 'lima-leaf', when: 'now', expectedRevision: 0,
                ...(actionId === 'machines.managed.delete' ? { intent: 'delete', reviewedDependencies: true } : { intent: 'stop' }) };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId,
            actionArgs, summary: 'Control managed machine.',
            approval: { flow: 'deferred', result: 'required' },
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', accountId,
                machineId: 'controller', target: { kind: 'machine', machineId: 'controller' },
                actionId, requestId: 'original-delete' } });
        const app = Fastify();
        const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_home' });
        const artifacts = registerPlainArtifactRoutes(app, accountId);
        artifacts.seed('delete-approval', encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
            encodePlainArtifactStoredContent({ body: JSON.stringify(request) }));
        const paths: string[] = [];
        app.addHook('onRequest', async request => { paths.push(request.url); });
        app.get('/v1/machines/controller', async () => ({ machine: { id: 'controller', kind: 'persistent', active: true,
            revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } }));
        const origin = 'https://delete-home.test';
        const restore = installAxiosFastifyAdapter({ app, origin });
        const sockets = await createRequesterCurrentnessSocketHarness();
        type Call = Parameters<ClientToServerEvents[typeof SOCKET_RPC_EVENTS.CALL]>[0];
        const calls: Call[] = [];
        const accountSettings = AccountSettingsSchema.parse({});
        const deleted = { kind: 'accepted', managedId: 'lima-leaf', intentRevision: 1,
            operation: { operationId: 'native-delete-operation' } };
        const outcome = { ok: true, status: 'executed', execution: { executedAtMs: 2,
            ok: true, effectAttempted: true, result: deleted } };
        // Home HTTP and the remote controller's Socket.IO acknowledgement are
        // boundaries; the CLI, Artifact reader, decision and replay owner are real.
        sockets.server.on('connection', socket => {
            socket.on(SOCKET_RPC_EVENTS.CALL, (call: Call, acknowledge: (result: unknown) => void) => {
                calls.push(call);
                acknowledge({ ok: true, result: { ok: true, result: outcome } });
            });
        });
        try {
            const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverApiUrl: origin, serverIdentityId: 'srv_home',
                resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }),
                actionsSettingsProvider: { getActionsSettings: () => accountSettings.actionsSettingsV1,
                    getAccountSettings: () => accountSettings } });
            const result = await executor.execute('approval.request.decide', { artifactId: 'delete-approval', decision: 'approve' },
                { surface: 'cli', authority: 'present_user', actionRequestId: 'approve-delete' });
            expect(result, JSON.stringify({ result, paths, calls })).toMatchObject({ ok: true, result: { ok: true, status: 'executed',
                execution: { ok: true, effectAttempted: true, result: deleted } } });
            expect(calls).toMatchObject([{ method: `controller:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}` }]);
            expect(paths).not.toContain(managedMachineActionEndpointPathV1(actionId));
        } finally {
            restore();
            await sockets.close();
            await app.close();
        }
    });
});
