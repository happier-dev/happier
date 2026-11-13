import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSessionsRoleForMachineClient } from '@/daemon/testkit/sessionsRole.testkit';
import axios from 'axios';
import { spawn as observedSpawn } from 'node:child_process';

import { accountSettingsParse } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { V2SessionByIdResponseSchema, type V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';

import type { StoredCredentials } from '@/persistence';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { authorizeResolvedAgentNativeExecLaunchForHost, issueAgentNativeLaunchQualifierForHost, spawnAuthorizedHostExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createReplayMessagesPage } from '@/session/replay/replayMessagesFixture.testkit';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { configuration, reloadConfiguration } from '@/configuration';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The private HTTP listener and OS process observer are genuine boundaries;
// fork resolution, row creation, requester custody and native admission stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
} }));
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterAll(() => pluginReloadController.shutdown());

import { prepareExecuteSpawnSessionRequest } from '@/daemon/startup/prepareExecuteSpawnSessionRequest';
import { resolveSessionForkBackendTarget } from './backendTarget';

const RESUMABLE_BACKEND_ID = 'review-bot';
const NON_RESUMABLE_BACKEND_ID = 'draft-bot';
const PROVIDER_SESSION_ID = 'provider-session-42';

const credentials = { token: 'composed-fork-token', encryption: null } satisfies StoredCredentials;

function configuredBackendEntry(params: Readonly<{
    id: string;
    title: string;
    supportsLoadSession: boolean;
}>) {
    return {
        id: params.id,
        name: params.id,
        title: params.title,
        launch: { kind: 'command' as const, command: `${params.id}-acp`, args: ['--stdio'] },
        env: {},
        capabilities: {
            supportsLoadSession: params.supportsLoadSession,
            supportsModes: 'unknown',
            supportsModels: 'unknown',
            supportsConfigOptions: 'unknown',
            promptImageSupport: 'no',
        },
        createdAt: 1,
        updatedAt: 2,
    };
}

// One opened catalog feeds fork membership and daemon load-session admission.
// Preferences have no retained ACP root to fall back to.
const ACCOUNT_SETTINGS = accountSettingsParse({});
const ACP_CATALOG = AcpCatalogRecordV1Schema.parse({
        v: 1,
        definitions: [
            configuredBackendEntry({
                id: RESUMABLE_BACKEND_ID,
                title: 'Review Bot',
                supportsLoadSession: true,
            }),
            configuredBackendEntry({
                id: NON_RESUMABLE_BACKEND_ID,
                title: 'Draft Bot',
                supportsLoadSession: false,
            }),
        ],
});

async function forkThenAdmitSpawn(params: Readonly<{
    parentMetadata: Record<string, unknown>;
    resume: string | null;
}>) {
    const forkResolution = await resolveSessionForkBackendTarget({
        parentMetadata: params.parentMetadata,
        credentials,
    });
    if (!forkResolution.ok) {
        return { forkResolution, admission: null } as const;
    }

    const admission = await prepareExecuteSpawnSessionRequest({
        request: {
            options: {
                directory: '/tmp/configured-acp-fork',
                machineId: 'machine-1',
                // The exact ref the fork owner produced crosses into daemon
                // admission unmodified. No test-local target is synthesized.
                backendTarget: forkResolution.backendTargetV2,
                approvedNewDirectoryCreation: true,
                ...(params.resume ? { resume: params.resume } : {}),
            },
            accountSettings: ACCOUNT_SETTINGS,
            acpCatalogSnapshot: getActiveAccountSettingsSnapshot()?.acpCatalog,
            credentials,
        },
        validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
    });

    return { forkResolution, admission } as const;
}

describe('configured ACP fork composed with daemon spawn admission', () => {
    beforeEach(() => {
        setActiveAccountSettingsSnapshot({
            source: 'cache',
            settings: ACCOUNT_SETTINGS,
            settingsVersion: 7,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
            acpCatalog: { status: 'ready', revision: 2, record: ACP_CATALOG },
        });
    });

    afterEach(() => {
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('admits the fork-resolved configured backend target for native resume when the Account proves load-session support', async () => {
        const { forkResolution, admission } = await forkThenAdmitSpawn({
            parentMetadata: buildConfiguredAcpBackendSessionMetadata({
                backendId: RESUMABLE_BACKEND_ID,
                title: 'Review Bot',
            }) as Record<string, unknown>,
            resume: PROVIDER_SESSION_ID,
        });

        expect(forkResolution).toMatchObject({
            ok: true,
            catalogAgentId: null,
            backendTargetV2: {
                kind: 'backend',
                backendId: RESUMABLE_BACKEND_ID,
                configuredBackendId: RESUMABLE_BACKEND_ID,
                sourceKind: 'configured',
            },
        });
        expect(admission).toMatchObject({
            effectiveResume: PROVIDER_SESSION_ID,
            catalogAgentId: null,
            effectiveBackendTargetV2: {
                sourceKind: 'configured',
                backendId: RESUMABLE_BACKEND_ID,
                configuredBackendId: RESUMABLE_BACKEND_ID,
            },
        });
    });

    it('admits a flavor-only parent whose configured backend the Account still declares', async () => {
        const { forkResolution, admission } = await forkThenAdmitSpawn({
            parentMetadata: { flavor: `acp:${RESUMABLE_BACKEND_ID}` },
            resume: PROVIDER_SESSION_ID,
        });

        expect(forkResolution).toMatchObject({
            ok: true,
            agentHintAgentId: `acp:${RESUMABLE_BACKEND_ID}`,
        });
        expect(admission).toMatchObject({ effectiveResume: PROVIDER_SESSION_ID });
    });

    it('refuses native resume for a fork-resolved backend the Account does not declare resumable', async () => {
        const { admission } = await forkThenAdmitSpawn({
            parentMetadata: buildConfiguredAcpBackendSessionMetadata({
                backendId: NON_RESUMABLE_BACKEND_ID,
                title: 'Draft Bot',
            }) as Record<string, unknown>,
            resume: PROVIDER_SESSION_ID,
        });

        expect(admission).toEqual({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
            errorMessage: `Resume is not supported for configured ACP backend '${NON_RESUMABLE_BACKEND_ID}'.`,
        });
    });

    it('keeps the replay fork fallback admissible for a backend without load-session support', async () => {
        // Replay never carries a provider resume token, so the load-session
        // refusal above must not close the automatic fallback path.
        const { admission } = await forkThenAdmitSpawn({
            parentMetadata: buildConfiguredAcpBackendSessionMetadata({
                backendId: NON_RESUMABLE_BACKEND_ID,
                title: 'Draft Bot',
            }) as Record<string, unknown>,
            resume: null,
        });

        expect(admission).toMatchObject({
            effectiveResume: '',
            catalogAgentId: null,
            effectiveBackendTargetV2: {
                sourceKind: 'configured',
                backendId: NON_RESUMABLE_BACKEND_ID,
            },
        });
    });
});

describe('registered configured ACP replay fork to a native child', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });

    it.each(['owner', 'member-use', 'member-manage'] as const)('preserves configured fork identity and useful owner execution (%s)', async actor => {
        const home = 'srv_configured_fork_native';
        const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'custom-acp', true, undefined,
            pluginReloadController, { externalActionAccountId: 'requester', homeServerIdentityId: home, ordinaryAccountSession: true,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
                agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) } });
        const ownerCredentials = h.installedCredentials;
        if (!ownerCredentials) throw new Error('Missing real persisted owner credentials');
        const serverId = h.f.bootstrap.attribution.serverId;
        await writeDaemonSettingsFixture(h.f.directory, { activeServerId: serverId,
            servers: { [serverId]: { id: serverId, name: 'Fork Home', serverUrl: 'https://session-home.test',
                webappUrl: 'https://session-home.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0 } },
            machineIdByServerId: { [serverId]: 'machine' }, lastTokenSubByServerId: { [serverId]: 'requester' } });
        reloadConfiguration();
        expect(configuration.activeServerId).toBe(serverId);
        const previousFetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({ features: {}, capabilities: {
                serverIdentity: { serverIdentityId: home },
                encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' },
            } });
            return await previousFetch(url, init);
        });
        setActiveAccountSettingsSnapshot({ source: 'cache', settings: ACCOUNT_SETTINGS, settingsVersion: 7,
            loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(ownerCredentials),
            acpCatalog: { status: 'ready', revision: 2, record: ACP_CATALOG } });
        const parentId = 'cforkparent000000000000001';
        const parent = createSessionRecordFixture({ id: parentId, seq: 1, active: false, encryptionMode: 'plain',
            metadata: JSON.stringify({ machineId: 'machine', path: h.cwd,
                ...buildConfiguredAcpBackendSessionMetadata({ backendId: NON_RESUMABLE_BACKEND_ID, title: 'Draft Bot' }) }),
            dataEncryptionKey: null, share: null });
        const messages = createReplayMessagesPage({ hasMore: false, messages: [{ seq: 1, createdAt: 1,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Continue the configured fork task' } } } }] });
        const previousGet = vi.mocked(axios.get).getMockImplementation();
        const previousPost = vi.mocked(axios.post).getMockImplementation();
        if (!previousGet || !previousPost) throw new Error('Missing canonical Home boundary');
        let created: V2SessionByIdResponse['session'] | undefined;
        let launched: SpawnSessionOptions | undefined;
        let output = '';
        let admissionChecks = 0;
        vi.mocked(axios.get).mockImplementation(async (url, options) => {
            const path = new URL(String(url)).pathname;
            if (path === `/v2/sessions/${parentId}`) return { status: 200, data: { session: parent } };
            if (path === `/v1/sessions/${parentId}/messages`) return { status: 200, data: messages };
            if (path === `/v2/sessions/${h.sessionId}` && created) return { status: 200, data: { session: created } };
            if (path === `/v1/access-keys/${h.sessionId}/machine`) return { status: 200,
                data: { accessKey: { sessionId: h.sessionId, machineId: 'machine', data: 'session-machine-control:fork-fixture' } } };
            return await previousGet(url, options);
        });
        vi.mocked(axios.post).mockImplementation(async (url, body: unknown, options) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/machines/machine/admission/verify' && body && typeof body === 'object'
                && 'method' in body && body.method === `machine:${RPC_METHODS.SESSION_FORK}` && 'context' in body && 'proof' in body) {
                const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
                const proof = MachineInstallationProofV1Schema.parse(body.proof);
                const valid = verifyMachineInstallationProof({ publicKey: h.f.installation.publicKey, proof,
                    payload: { version: 1, accountId: 'requester', machineId: 'machine', installationId: h.f.installation.installationId,
                        rpcAdmission: { context, method: String(body.method) } } });
                admissionChecks++;
                return { status: valid ? 200 : 403, data: valid ? { v: 1, ok: true } : { error: 'access_denied' } };
            }
            if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: [] } };
            if (path === '/v1/sessions' && body && typeof body === 'object') {
                const shared = 'sharedMetadata' in body ? body.sharedMetadata : null;
                created = V2SessionByIdResponseSchema.parse({ session: { ...createSessionRecordFixture({ id: h.sessionId, seq: 0, active: false, encryptionMode: 'plain',
                    metadata: shared && typeof shared === 'object' && 'ciphertext' in shared && typeof shared.ciphertext === 'string'
                        ? shared.ciphertext : '{}',
                    dataEncryptionKey: null, share: null }),
                    ...('metadataLayoutVersion' in body ? { metadataLayoutVersion: body.metadataLayoutVersion } : {}),
                    ...('ownerMetadata' in body ? { ownerMetadata: body.ownerMetadata } : {}),
                } }).session;
                return { status: 200, data: { session: created, created: true, organizationPlacement: { folderId: null, tagIds: [] } } };
            }
            return await previousPost(url, body, options);
        });
        await activateSessionsRoleForMachineClient(h.machine, h.machine.setRPCHandlers({ spawnSession: async options => {
            // This is the existing process-creation/tracking boundary. Preserve
            // precisely the fork owner's output; no requester identity is added.
            launched = options;
            h.tracked.spawnOptions = options;
            h.tracked.requesterWorkAttributionV1 = options.requesterWorkAttributionV1;
            const services = await prepareRunnerDaemonPluginServices({ invocationId: 'configured-replay-fork', signal: h.signal,
                local: createUnavailablePluginServices(), dispatch: async operation => {
                    const response = await h.dispatch(operation);
                    if (!response.ok) throw Object.assign(new Error(response.error.code), { code: response.error.code });
                    if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing native fork services');
                    return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
                } });
            const launch = await authorizeResolvedAgentNativeExecLaunchForHost(services.exec,
                { command: process.execPath, args: ['-e', 'process.stdout.write("configured-fork-native-ready")'], cwd: options.directory, env: {} },
                h.signal, issueAgentNativeLaunchQualifierForHost(services.exec));
            const child = spawnAuthorizedHostExecLaunchForHost(launch, { signal: h.signal });
            try {
                const result = await child.handle.wait();
                expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                output = new TextDecoder().decode(result.stdout);
            } finally { await child.dispose(); await child.waitForSettlement(); }
            await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('configured-replay-fork') });
            return { type: 'success', sessionId: h.sessionId };
        }, stopSession: async () => true, requestShutdown() {} }, { currentMachineId: 'machine' }));
        const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
        if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed Machine receiver');
        const before = vi.mocked(observedSpawn).mock.calls.length;
        const result = await manager.handleRequest({ method: `machine:${RPC_METHODS.SESSION_FORK}`,
            params: { parentSessionId: parentId, forkPoint: { type: 'latest' }, strategy: 'replay', requestId: `configured-${actor}` },
            callerAuthority: 'present_user', machineAdmission: { actorAccountId: actor === 'owner' ? 'requester' : 'member',
                custodianAccountId: 'requester', machineId: 'machine', installationId: h.f.installation.installationId,
                role: actor === 'member-use' ? 'use' : 'manage', encryptionMode: 'plain' } });
        const childEffects = vi.mocked(observedSpawn).mock.calls.slice(before)
            .filter(([, args]) => args?.includes('process.stdout.write("configured-fork-native-ready")'));
        expect(admissionChecks).toBeGreaterThan(0);
        if (actor === 'owner') {
            expect(result).toMatchObject({ ok: true, childSessionId: h.sessionId });
            expect(launched).toMatchObject({ existingSessionId: h.sessionId,
                backendTarget: { kind: 'backend', sourceKind: 'configured', backendId: NON_RESUMABLE_BACKEND_ID,
                    configuredBackendId: NON_RESUMABLE_BACKEND_ID } });
            expect(output).toBe('configured-fork-native-ready');
            expect(childEffects).toHaveLength(1);
        } else {
            expect(result).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
            expect(created).toBeUndefined();
            expect(launched).toBeUndefined();
            expect(childEffects).toHaveLength(0);
        }
    }, 120_000);
});
