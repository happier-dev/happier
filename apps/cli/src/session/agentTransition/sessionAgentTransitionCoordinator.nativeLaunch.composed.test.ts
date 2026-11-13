import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { spawn as observedSpawn } from 'node:child_process';
import type { Socket as ServerSocket } from 'socket.io';
import { io } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { SessionTerminalMetadataSchema } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { encodeStoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { activateSessionsRoleForMachineClient } from '@/daemon/testkit/sessionsRole.testkit';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration, reloadConfiguration } from '@/configuration';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
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
    it.each(['owner', 'owner-admitted', 'owner-admitted-unconfirmed', 'member-use', 'member-manage'] as const)('activates a new configured target only for the exact owner (%s)', async actor => {
        const home = 'srv_transition_native';
        const custodian = 'requester';
        const admittedActor = actor === 'owner-admitted' || actor === 'owner-admitted-unconfirmed';
        const isOwner = actor === 'owner' || admittedActor;
        const diagnostics = vi.spyOn(logger, 'warnLocalFile');
        const requester = isOwner ? custodian : 'member';
        const role = actor === 'member-use' ? 'use' : 'manage';
        const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'custom-acp', true, undefined,
            pluginReloadController, { externalActionAccountId: custodian, homeServerIdentityId: home, ordinaryAccountSession: true,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
                agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) } });
        const ownerCredentials = h.installedCredentials;
        if (!ownerCredentials) throw new Error('Missing persisted Machine owner credentials');
        const credentials = isOwner ? ownerCredentials : { token: `e30.${Buffer.from(JSON.stringify({ sub: requester,
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
                ...(actor === 'owner-admitted' ? { terminal: SessionTerminalMetadataSchema.parse({ mode: 'tmux' }) } : {}),
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
        resetServerFeaturesClientForTests();
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
            if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('session.agent.transition')) {
                return { status: 200, data: { ok: true } };
            }
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
        const attachProviderBoundary = (socket: ServerSocket) => {
            socket.on(SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, (packet, acknowledge) => {
                const input = SessionPendingEnqueueByMachineRequestV1Schema.parse(packet);
                expect(input.sessionId).toBe(h.sessionId);
                expect(input.localId).toBe(`transition-${actor}`);
                pendingInputs++;
                acknowledge({ v: 1, result: { status: 'accepted', localId: input.localId } });
            });
            socket.on(SOCKET_RPC_EVENTS.CALL, (packet, acknowledge) => {
            if (!packet || typeof packet !== 'object' || packet.method !== `${h.sessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`) {
                acknowledge({ ok: false, error: 'Unexpected transition provider RPC' });
                return;
            }
            acknowledge({ ok: true, result: { status: packet.params?.action === 'enforce' ? 'enforced' : 'not_matched' } });
            });
        };
        h.f.channel.server.on('connection', attachProviderBoundary);
        for (const socket of h.f.channel.server.sockets.sockets.values()) attachProviderBoundary(socket);
        // The launch fixture has no Machine socket. Supply its actual network
        // channel so admitted input can reach the Home Pending boundary above.
        const machineSocket = io(h.f.channel.serverUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false });
        onTestFinished(() => { machineSocket.disconnect(); });
        await new Promise<void>((resolve, reject) => {
            machineSocket.once('connect', resolve);
            machineSocket.once('connect_error', reject);
            machineSocket.connect();
        });
        Reflect.set(h.machine, 'socket', machineSocket);
        let launched: SpawnSessionOptions | undefined;
        let output = '';
        const registration = h.machine.setRPCHandlers({ spawnSession: async options => {
            launched = options;
            h.tracked.spawnOptions = options;
            h.tracked.requesterWorkAttributionV1 = options.requesterWorkAttributionV1;
            h.trackedSessionsByKey.set(h.tracked.trackingKey, h.tracked);
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
        const roles = await activateSessionsRoleForMachineClient(h.machine, registration);
        onTestFinished(() => roles.stop());
        const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
        if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed target Machine receiver');
        let targetAdmission: unknown;
        let rawStops = 0;
        vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async input => {
            expect(input.credentials?.token).toBe(credentials.token);
            // This source is already inactive and has no remote native runner.
            // Its network stop answer is consumed by the real Stop owner,
            // which independently confirms the inactive Home row.
            if (input.method === RPC_METHODS.STOP_SESSION) {
                rawStops++;
                return admittedActor ? { ok: false, errorCode: 'RPC_FORBIDDEN', error: 'Invalid RPC caller input authorization' }
                    : { status: 'not_found' };
            }
            // Preserve the complete production request across the Machine
            // network boundary; the receiver owns all currentness and identity.
            targetAdmission = await manager.handleRequest({ method: `machine:${input.method}`, params: input.request,
                ...(input.externalAction?.context.externalActionExecutionAuthorization
                    ? { callerInputAuthorization: input.externalAction.context.externalActionExecutionAuthorization } : {}),
                callerAuthority: 'present_user', machineAdmission: { actorAccountId: requester, custodianAccountId: custodian,
                    machineId: 'machine', installationId: h.f.installation.installationId, role, encryptionMode: 'plain' } });
            return targetAdmission;
        });
        const before = vi.mocked(observedSpawn).mock.calls.length;
        const request = { v: 1 as const, sessionId: h.sessionId, expectedCurrentAgentId: 'acp:before', selection: { v: 1 as const, agentId: 'acp:after' },
            input: { text: 'Continue with the selected Agent', localId: `transition-${actor}`, meta: {} } };
        const result = await (async () => {
            if (!admittedActor) return await runSessionAgentTransition({ credentials, request });
            // The source is already inactive; native Stop confirms its absence.
            // A nested raw RPC refuses this root, while the installed admitted
            // Stop effect reaches the local owner without another admission.
            h.trackedSessionsByKey.delete(h.tracked.trackingKey);
            const target = { kind: 'machine' as const, machineId: 'machine' };
            const purpose = { kind: 'external_action' as const };
            const requestId = 'admitted-transition';
            const authorization = sealExternalActionRequesterAccountContextV1({
                authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'transition-root', binding: {
                    accountId: custodian, custodianAccountId: custodian, authentication: { kind: 'account', tokenEpoch: 1 },
                    accountEncryptionMode: 'plain', serverIdentityId: home, machineId: 'machine',
                    installationId: h.f.installation.installationId, actionId: 'session.agent.transition', requestId,
                    target, requestEnvelopeDigest: 'a'.repeat(43),
                } }), credentials: encodeStoredCredentials(credentials), purpose,
                invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
                installationPublicKey: decodeBase64(h.f.installation.publicKey, 'base64url'), randomBytes: tweetnacl.randomBytes,
            });
            const admitted = await h.daemon.externalActionIngressOwner?.prepareRequesterAccountContext?.({ authorization, purpose });
            expect(admitted, JSON.stringify(diagnostics.mock.calls.filter(([tag]) => tag === '[external-action-phase]'))).toBeTruthy();
            if (!admitted) throw new Error('Installed transition requester unavailable');
            try {
                const { v: _v, ...actionInput } = request;
                const action = await admitted.executor.execute('session.agent.transition', actionInput, { surface: 'ui', authority: 'present_user',
                    actionRequestId: requestId, externalActionExecutionAuthorization: admitted.authorization,
                    externalActionTarget: target, serverId: home, actionCaller: { kind: 'host' },
                    defaultSessionId: h.sessionId, defaultSessionMachineId: 'machine',
                    presentUserConfirmation: { actionId: 'session.agent.transition', requestId, accountId: custodian,
                        serverId: home, target, inputDigest: computeActionInputApprovalDigestV1('session.agent.transition', actionInput) } });
                expect(action, JSON.stringify(action)).toMatchObject({ ok: true });
                if (!action.ok) throw new Error('Transition Action refused');
                expect(action.result, JSON.stringify({ result: action.result, targetAdmission })).toMatchObject({
                    type: actor === 'owner-admitted-unconfirmed' ? 'outcome_unknown' : 'accepted' });
                expect(rawStops).toBe(0);
                return action.result;
            } finally { await admitted.dispose(); }
        })();
        const effects = vi.mocked(observedSpawn).mock.calls.slice(before)
            .filter(([, args]) => args?.includes('process.stdout.write("transition-target-native-ready")'));
        if (actor === 'owner-admitted-unconfirmed') {
            expect(cutovers).toBe(0);
            expect(pendingInputs).toBe(0);
            expect(effects).toHaveLength(0);
            return;
        }
        expect(cutovers).toBe(1);
        expect(pendingInputs).toBe(1);
        expect(identityChecks).toBeGreaterThan(0);
        if (isOwner) {
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
