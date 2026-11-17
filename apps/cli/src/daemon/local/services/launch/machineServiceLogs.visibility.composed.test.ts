import axios from 'axios';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { MACHINE_SERVICE_LOGS_READ_ACTION_ID } from '@happier-dev/protocol/local/services/actionIdsV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';

describe('workspace service log visibility', () => {
    it('allows the starter but refuses another Machine-Use Account at approval and page read', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        const owner = fixture.registry.projectManagedServices;
        const target = { serverId: 'home', machineId: 'machine' };
        const workspace = { ...target, id: 'alice-workspace', rootPath: fixture.happyHomeDir, createdAtMs: 1 };
        let nativeLogReads = 0;
        try {
            const service = await owner.superviseProject({ kind: 'workspace', workspace,
                declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'web' } },
                cwd: workspace.rootPath, serviceId: 'project-service:alice-web', specIdentity: 'alice-web',
                requester: { ...target, accountId: 'alice', installationId: 'installation' }, isCurrent: () => true,
                // Only native process IO is substituted; registry, supervision,
                // Action dispatch, requester selection and disclosure stay real.
                processSpec: { mode: { kind: 'native', instance: {
                    adapter: { pluginId: 'fixture.native', localId: 'web' }, nativeResourceId: 'alice-web' },
                    lifecycle: {
                        async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                        async stop() { return { status: 'stopped' }; },
                        async logs() { nativeLogReads++; return { kind: 'page', page: {
                            sourceRevision: 'alice-web-output', text: 'alice service output', nextCursor: null, truncated: false,
                        } }; },
                    } } },
                authorizeLaunch: async () => ({ command: process.execPath, args: [], env: {}, release: async () => {} }),
            });
            const reader = (accountId: string) => {
                const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
                return createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
                    mode: 'plain', ctx: null, sessionId: 'cli-global', serverId: target.serverId,
                    serverHttpBaseUrl: 'https://home.example.test', isCredentialCurrent: async () => true,
                    machineActionDirectTargetTransport: { machineId: target.machineId,
                        invoke: async () => { throw new Error('Local logs must not re-enter RPC'); } },
                });
            };
            const input = { ...target, serviceId: service.serviceId };
            const context = (accountId: string) => ({ surface: 'cli' as const, authority: 'present_user' as const,
                serverId: target.serverId, runtimeAccountId: accountId,
                machineAdmission: { actorAccountId: accountId, custodianAccountId: 'custodian',
                    machineId: target.machineId, installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
                verifyMachineAdmissionCurrent: async () => true });
            const alice = reader('alice');
            const bob = reader('bob');
            // Positive control first through the same Action and native page owner.
            expect(await alice.executor.execute(MACHINE_SERVICE_LOGS_READ_ACTION_ID, input, context('alice')))
                .toMatchObject({ ok: true, result: { kind: 'page', page: { text: 'alice service output' } } });
            expect(nativeLogReads).toBe(1);
            expect.soft(await bob.executor.prepare(MACHINE_SERVICE_LOGS_READ_ACTION_ID, input, context('bob')))
                .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'service_unavailable' } });
            // An already selected approval scope cannot bypass page admission.
            expect(await bob.deps.machineServiceLogsRead!({ input, context: context('bob'),
                approvalScope: { kind: 'machine', machineId: target.machineId } }))
                .toMatchObject({ ok: false, errorCode: 'service_unavailable' });
            expect(nativeLogReads).toBe(1);

            // The Machine custodian retains the same native-log visibility as
            // the list/feed paths. Admit real host-private Account custody;
            // only Home HTTP and its socket endpoint are substituted.
            const channel = await createRequesterCurrentnessSocketHarness();
            const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/profile') return { status: 200, data: { id: 'custodian' } };
                if (path === '/v1/account/encryption/currentness')
                    return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
                if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 0 } };
                throw new Error(`Unexpected Home request: ${path}`);
            });
            let admitted: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
            try {
                const token = `header.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
                admitted = await admitRequesterAccountActionContext({
                    authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'logs-root', binding: {
                        accountId: 'custodian', custodianAccountId: 'custodian', authentication: { kind: 'terminal', tokenEpoch: 1 },
                        accountEncryptionMode: 'plain', serverIdentityId: target.serverId, machineId: target.machineId,
                        installationId: 'installation', actionId: MACHINE_SERVICE_LOGS_READ_ACTION_ID,
                        requestId: 'custodian-logs', requestEnvelopeDigest: 'a'.repeat(43),
                        target: { kind: 'machine', machineId: target.machineId },
                    } }),
                    credentials: { token, encryption: null }, serverId: target.serverId, serverIdentityId: target.serverId,
                    serverHttpBaseUrl: 'https://home.example.test', isCurrent: async () => true, isCustodyCurrent: async () => true,
                });
                if (!admitted) throw new Error('Custodian Account custody was not admitted');
                const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
                    serverId: target.serverId, serverIdentityId: target.serverId, serverHttpBaseUrl: 'https://home.example.test',
                    target: admitted.authorization.binding.target, installationId: 'installation',
                    privateKey: nacl.sign.keyPair().secretKey, rootAdmitted: true });
                if (!carrier) throw new Error('Custodian HTTP custody was not projected');
                const custodian = reader('custodian');
                const custodyContext = { ...context('custodian'), externalActionExecutionAuthorization: carrier };
                const approvalScope = { kind: 'machine' as const, machineId: target.machineId };
                expect(await custodian.deps.machineServiceScope!({ actionId: MACHINE_SERVICE_LOGS_READ_ACTION_ID,
                    input, context: custodyContext })).toEqual(approvalScope);
                expect(await custodian.deps.machineServiceLogsRead!({ input, context: custodyContext, approvalScope }))
                    .toMatchObject({ kind: 'page', page: { text: 'alice service output' } });
                expect(nativeLogReads).toBe(2);
            } finally { await admitted?.dispose(); http.mockRestore(); await channel.close(); }
        } finally { await fixture.dispose(); }
    });
});
