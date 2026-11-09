import axios from 'axios';
import { spawn as observedSpawn } from 'node:child_process';
import type { Socket as ServerSocket } from 'socket.io';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration, reloadConfiguration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createReplayMessagesPage } from '@/session/replay/replayMessagesFixture.testkit';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { authorizeResolvedAgentNativeExecLaunchForHost, issueAgentNativeLaunchQualifierForHost, spawnAuthorizedHostExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { runSessionAgentTransition } from './sessionAgentTransitionCoordinator';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
} }));
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
afterAll(() => pluginReloadController.shutdown());

describe('Agent transition requester identity through target native activation', () => {
    it.each(['owner', 'member-use', 'member-manage'] as const)('activates a new configured target only for the exact owner (%s)', async actor => {
        const home = 'srv_transition_native';
        const custodian = 'requester';
        const requester = actor === 'owner' ? custodian : 'member';
        const role = actor === 'member-use' ? 'use' : 'manage';
        const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'custom-acp', true, undefined,
            pluginReloadController, { externalActionAccountId: custodian, homeServerIdentityId: home, ordinaryAccountSession: true,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
                agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) } });
        const ownerCredentials = h.installedCredentials;
        if (!ownerCredentials) throw new Error('Missing persisted Machine owner credentials');
        const credentials = actor === 'owner' ? ownerCredentials : { token: `e30.${Buffer.from(JSON.stringify({ sub: requester,
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
        const serverId = h.f.bootstrap.attribution.serverId;
        await writeDaemonSettingsFixture(h.f.directory, { activeServerId: serverId,
            servers: { [serverId]: { id: serverId, name: 'Transition Home', serverUrl: 'https://session-home.test',
                webappUrl: 'https://session-home.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0 } },
            machineIdByServerId: { [serverId]: 'machine' }, lastTokenSubByServerId: { [serverId]: 'requester' } });
        reloadConfiguration();
        expect(configuration.activeServerId).toBe(serverId);
        const settings = accountSettingsParse({});
        const catalog = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['before', 'after'].map(id => ({
            id, name: id, title: id, launch: { kind: 'command', command: `${id}-acp`, args: ['--stdio'] }, env: {},
            capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown',
                supportsConfigOptions: 'unknown', promptImageSupport: 'no' }, createdAt: 1, updatedAt: 2,
        })) });
        setActiveAccountSettingsSnapshot({ source: 'cache', settings, settingsVersion: 1, loadedAtMs: Date.now(),
            settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
            acpCatalog: { status: 'ready', revision: 1, record: catalog } });
        let row = createSessionRecordFixture({ id: h.sessionId, seq: 0, active: false, encryptionMode: 'plain', dataEncryptionKey: null,
            share: null, metadata: JSON.stringify({ machineId: 'machine', path: h.cwd,
                ...buildConfiguredAcpBackendSessionMetadata({ backendId: 'before', title: 'before' }) }) });
        const previousFetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/profile') return Response.json({ id: requester });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({
                features: { sessions: { enabled: true, agentSwitching: { enabled: true } } }, capabilities: {
                    serverIdentity: { serverIdentityId: home },
                    encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' },
                } });
            return await previousFetch(url, init);
        });
        const previousGet = vi.mocked(axios.get).getMockImplementation();
        const previousPost = vi.mocked(axios.post).getMockImplementation();
        if (!previousGet || !previousPost) throw new Error('Missing canonical Home boundary');
        vi.mocked(axios.get).mockImplementation(async (url, options) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: requester } };
            if (path === `/v2/sessions/${h.sessionId}`) return { status: 200, data: { session: row } };
            if (path === `/v1/sessions/${h.sessionId}/messages`) return { status: 200,
                data: createReplayMessagesPage({ hasMore: false, messages: [] }) };
            return await previousGet(url, options);
        });
        let cutovers = 0;
        let pendingInputs = 0;
        let identityChecks = 0;
        vi.mocked(axios.post).mockImplementation(async (url, body: unknown, options) => {
            const path = new URL(String(url)).pathname;
            if (path === `/v2/sessions/${h.sessionId}/agent-transition/cutover` && body && typeof body === 'object' && 'currentView' in body) {
                const view = body.currentView;
                if (!view || typeof view !== 'object' || !('kind' in view) || view.kind !== 'legacy_v0'
                    || !('metadataCiphertext' in view) || typeof view.metadataCiphertext !== 'string') throw new Error('Missing real legacy target projection');
                row = { ...row, metadata: view.metadataCiphertext, metadataVersion: row.metadataVersion + 1 };
                cutovers++;
                return { status: 200, data: { success: true, dividerSeq: 1 } };
            }
            if (path === `/v2/sessions/${h.sessionId}/pending`) {
                pendingInputs++;
                return { status: 200, data: { didWrite: true } };
            }
            if (path === '/v1/machines/machine/admission/verify' && body && typeof body === 'object'
                && 'method' in body && 'context' in body && 'proof' in body) {
                const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
                const proof = MachineInstallationProofV1Schema.parse(body.proof);
                const valid = verifyMachineInstallationProof({ publicKey: h.f.installation.publicKey, proof,
                    payload: { version: 1, accountId: custodian, machineId: 'machine', installationId: h.f.installation.installationId,
                        rpcAdmission: { context, method: String(body.method) } } });
                identityChecks++;
                return { status: valid ? 200 : 403, data: valid ? { v: 1, ok: true } : { error: 'access_denied' } };
            }
            return await previousPost(url, body, options);
        });
        // The previous native provider is a remote network boundary. Its real
        // socket transport acknowledges only the canonical input-fence packet.
        const attachProviderBoundary = (socket: ServerSocket) => socket.on(SOCKET_RPC_EVENTS.CALL, (packet, acknowledge) => {
            if (!packet || typeof packet !== 'object' || packet.method !== `${h.sessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`) {
                acknowledge({ ok: false, error: 'Unexpected transition provider RPC' });
                return;
            }
            acknowledge({ ok: true, result: { status: packet.params?.action === 'enforce' ? 'enforced' : 'not_matched' } });
        });
        h.f.channel.server.on('connection', attachProviderBoundary);
        for (const socket of h.f.channel.server.sockets.sockets.values()) attachProviderBoundary(socket);
        let launched: SpawnSessionOptions | undefined;
        let output = '';
        h.machine.setRPCHandlers({ spawnSession: async options => {
            launched = options;
            h.tracked.spawnOptions = options;
            h.tracked.requesterWorkAttributionV1 = options.requesterWorkAttributionV1;
            const invocationId = 'transition-native-target';
            const services = await prepareRunnerDaemonPluginServices({ invocationId, signal: h.signal,
                local: createUnavailablePluginServices(), dispatch: async operation => {
                    const response = await h.dispatch(operation);
                    if (!response.ok) throw Object.assign(new Error(response.error.code), { code: response.error.code });
                    if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing target native services');
                    return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
                } });
            const launch = await authorizeResolvedAgentNativeExecLaunchForHost(services.exec,
                { command: process.execPath, args: ['-e', 'process.stdout.write("transition-target-native-ready")'], cwd: options.directory, env: {} },
                h.signal, issueAgentNativeLaunchQualifierForHost(services.exec));
            const child = spawnAuthorizedHostExecLaunchForHost(launch, { signal: h.signal });
            try {
                const result = await child.handle.wait();
                expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                output = new TextDecoder().decode(result.stdout);
            } finally { await child.dispose(); await child.waitForSettlement(); }
            await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(invocationId) });
            return { type: 'success', sessionId: h.sessionId };
        }, stopSession: async () => false, requestShutdown() {} }, { currentMachineId: 'machine' });
        const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
        if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed target Machine receiver');
        let targetAdmission: unknown;
        vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async input => {
            expect(input.credentials?.token).toBe(credentials.token);
            // This source is already inactive and has no remote native runner.
            // Its network stop answer is consumed by the real Stop owner,
            // which independently confirms the inactive Home row.
            if (input.method === RPC_METHODS.STOP_SESSION) return { status: 'not_found' };
            // Preserve the complete production request across the Machine
            // network boundary; the receiver owns all currentness and identity.
            targetAdmission = await manager.handleRequest({ method: `machine:${input.method}`, params: input.request,
                callerAuthority: 'present_user', machineAdmission: { actorAccountId: requester, custodianAccountId: custodian,
                    machineId: 'machine', installationId: h.f.installation.installationId, role, encryptionMode: 'plain' } });
            return targetAdmission;
        });
        const before = vi.mocked(observedSpawn).mock.calls.length;
        const result = await runSessionAgentTransition({ credentials,
            request: { v: 1, sessionId: h.sessionId, expectedCurrentAgentId: 'acp:before', selection: { v: 1, agentId: 'acp:after' },
                input: { text: 'Continue with the selected Agent', localId: `transition-${actor}`, meta: {} } } });
        const effects = vi.mocked(observedSpawn).mock.calls.slice(before)
            .filter(([, args]) => args?.includes('process.stdout.write("transition-target-native-ready")'));
        expect(cutovers).toBe(1);
        expect(pendingInputs).toBe(1);
        expect(identityChecks).toBeGreaterThan(0);
        if (actor === 'owner') {
            expect(result).toMatchObject({ type: 'accepted' });
            expect(launched).toMatchObject({ existingSessionId: h.sessionId,
                backendTarget: { sourceKind: 'configured', configuredBackendId: 'after' } });
            expect(output).toBe('transition-target-native-ready');
            expect(effects).toHaveLength(1);
        } else {
            expect(targetAdmission).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
            expect(result).toMatchObject({ type: 'current_view_committed', code: 'target_start_failed' });
            expect(launched).toBeUndefined();
            expect(effects).toHaveLength(0);
        }
    }, 120_000);
});
