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
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { createPythonPtyRelayProvider } from '@/terminal/pty/pythonRelay';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/verifiedExternalActionRequester';

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

    // Live cut 48: a signed Logs read carries a verified original root and no raw
    // RPC admission. The receiver's held Home, installation and Machine reconcile
    // that root; the retained terminal custody then decides whose Service is read.
    it.skipIf(process.platform === 'win32')('reads a terminal Service for its starter only through the signed Logs Action without raw admission', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        const owner = fixture.registry.projectManagedServices;
        const target = { serverId: 'home', machineId: 'machine' };
        const ptyProvider = createPythonPtyRelayProvider({ env: process.env, platform: process.platform, pythonExecutable: 'python3' });
        if (!ptyProvider) throw new Error('Terminal Service fixture requires the existing Python PTY relay');
        const terminals = createTerminalPtySessionManager({ ptyProvider, env: {}, platform: 'linux',
            config: { bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000, urlParseBufferLimit: 32_768,
                maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24 } });
        // Every byte a Service read discloses comes through its terminal's log port.
        const terminalLogReads: string[] = [];
        const start = async (accountId: string) => {
            const workspace = { ...target, id: `${accountId}-workspace`, rootPath: fixture.happyHomeDir, createdAtMs: 1 };
            const serviceId = `project-service:${accountId}-web`;
            return owner.superviseProject({ kind: 'workspace', workspace,
                declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'web' } },
                cwd: workspace.rootPath, serviceId, specIdentity: `${accountId}-web`, execution: 'primary', interactive: true,
                requester: { ...target, accountId, installationId: 'installation' }, isCurrent: () => true,
                // The declared launcher's terminal custody for its admitted starter; the
                // process, PTY, supervisor, registry and Action dispatch stay real.
                processSpec: { mode: { kind: 'managedSpawn', endpointNone: true,
                    endpointDetection: { kind: 'detectAfterLaunch', minimumConfidence: 'high' } },
                interactiveTerminal: { terminalKey: serviceId, sessions: { async spawnManagedService(input) {
                    const terminal = await terminals.spawnManagedService(input);
                    return { ...terminal, logs: request => { terminalLogReads.push(accountId); return terminal.logs(request); } };
                } }, custody: { serverId: target.serverId, machineId: target.machineId, requesterAccountId: accountId,
                    installationId: 'installation', workspaceRefId: workspace.id, rootPath: workspace.rootPath,
                    projectKey: projectWorkspaceRefV1(workspace).projectKey } } },
                authorizeLaunch: async () => ({ command: process.execPath,
                    args: ['-e', `process.stdout.write(${JSON.stringify(`${accountId} terminal output\n`)}); setInterval(() => {}, 1000)`],
                    env: {}, release: async () => {} }),
            });
        };
        const tokenFor = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const channel = await createRequesterCurrentnessSocketHarness();
        // Home HTTP is the boundary: each requester's own profile answers for its own token.
        const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            const path = new URL(String(url)).pathname;
            const bearer = String((config?.headers as Record<string, unknown> | undefined)?.Authorization ?? '');
            if (path === '/v1/account/profile')
                return { status: 200, data: { id: JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString()).sub } };
            if (path === '/v1/account/encryption/currentness')
                return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 0 } };
            throw new Error(`Unexpected Home request: ${path}`);
        });
        const admissions: NonNullable<Awaited<ReturnType<typeof admitRequesterAccountActionContext>>>[] = [];
        // The receiver's real admission of a Home-signed original root for one requester.
        const admit = async (accountId: string, role: 'use' | undefined, isCurrent: () => Promise<boolean> = async () => true) => {
            const admitted = await admitRequesterAccountActionContext({
                authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `logs-root-${accountId}`, binding: {
                    accountId, custodianAccountId: 'custodian', authentication: { kind: 'terminal', tokenEpoch: 1 },
                    accountEncryptionMode: 'plain', serverIdentityId: target.serverId, machineId: target.machineId,
                    installationId: 'installation', actionId: MACHINE_SERVICE_LOGS_READ_ACTION_ID,
                    requestId: `${accountId}-logs-${admissions.length}`, requestEnvelopeDigest: 'a'.repeat(43),
                    target: { kind: 'machine', machineId: target.machineId }, ...(role ? { admittedMachineRole: role } : {}),
                } }),
                credentials: { token: tokenFor(accountId), encryption: null }, serverId: target.serverId, serverIdentityId: target.serverId,
                serverHttpBaseUrl: 'https://home.example.test', isCurrent, isCustodyCurrent: isCurrent,
            });
            if (!admitted) return null;
            admissions.push(admitted);
            const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
                serverId: target.serverId, serverIdentityId: target.serverId, serverHttpBaseUrl: 'https://home.example.test',
                target: admitted.authorization.binding.target, installationId: 'installation',
                privateKey: nacl.sign.keyPair().secretKey, rootAdmitted: true });
            if (!carrier) throw new Error(`${accountId} HTTP custody was not projected`);
            // As the receiver hands it to the Action executor: its verified original
            // root with Home currentness, and no raw RPC admission.
            const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: target.serverId,
                runtimeAccountId: accountId,
                externalActionExecutionAuthorization: retainVerifiedExternalActionRequester({ authorization: carrier, isCurrent }) };
            const { executor } = createCliActionExecutorHarness({ token: tokenFor(accountId),
                credentials: { token: tokenFor(accountId), encryption: null }, mode: 'plain', ctx: null, sessionId: 'cli-global',
                serverId: target.serverId, serverIdentityId: target.serverId, externalActionMachineInstallationId: 'installation',
                serverHttpBaseUrl: 'https://home.example.test', isCredentialCurrent: async () => true,
                machineActionDirectTargetTransport: { machineId: target.machineId,
                    invoke: async () => { throw new Error('Local logs must not re-enter RPC'); } } });
            return (serviceId: string) => executor.execute(MACHINE_SERVICE_LOGS_READ_ACTION_ID, { ...target, serviceId }, context);
        };
        try {
            const custodianService = await start('custodian');
            const bobService = await start('bob');
            const carolService = await start('carol');
            await vi.waitFor(() => expect(terminals.read({ terminalId: custodianService.terminalView!.terminalId, cursor: 0,
                maxBytes: 4096, maxEvents: 100 })).toMatchObject({ ok: true, events: expect.arrayContaining([
                expect.objectContaining({ data: expect.stringContaining('custodian terminal output') })]) }), { timeout: 10_000 });
            const page = (accountId: string) => ({ ok: true, result: { kind: 'page', page: { text: expect.stringContaining(`${accountId} terminal output`) } } });
            const refused = { ok: false, errorCode: 'terminal_forbidden' };

            // Owner positive: the Machine custodian reads the Service it started on its own Machine.
            const custodian = (await admit('custodian', undefined))!;
            const own = await custodian(custodianService.serviceId);
            expect(own, JSON.stringify(own)).toMatchObject(page('custodian'));
            expect(terminalLogReads).toEqual(['custodian']);
            // Custody, not Machine ownership, decides: the owner cannot read a guest's Service.
            expect(await custodian(bobService.serviceId)).toMatchObject(refused);

            // A Use guest reads their own Service on this shared Machine, and nobody else's.
            let bobGrant = true;
            const bob = (await admit('bob', 'use', async () => bobGrant))!;
            expect(await bob(bobService.serviceId)).toMatchObject(page('bob'));
            expect(await bob(custodianService.serviceId)).toMatchObject(refused);
            expect(await bob(carolService.serviceId)).toMatchObject(refused);
            expect(terminalLogReads).toEqual(['custodian', 'bob']);

            // Another Account with no grant on this Machine reads no Service.
            const mallory = (await admit('mallory', undefined))!;
            for (const service of [custodianService, bobService, carolService])
                expect(await mallory(service.serviceId)).toMatchObject({ ok: false });

            // Withdrawal takes effect at the next request: Home no longer admits the root,
            // and the already-admitted carrier settles refused instead of reading.
            bobGrant = false;
            expect(await admit('bob', 'use', async () => bobGrant)).toBeNull();
            await expect(bob(bobService.serviceId)).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
            // No refused read disclosed a byte before its refusal.
            expect(terminalLogReads).toEqual(['custodian', 'bob']);
        } finally {
            try { await Promise.all(owner.listProjectServices().map(service => service.stop())); }
            finally {
                await Promise.all(admissions.map(admitted => admitted.dispose()));
                http.mockRestore(); await channel.close(); terminals.dispose(); await fixture.dispose();
            }
        }
    });
});
