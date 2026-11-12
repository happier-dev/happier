import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { SessionSpawnNewInputV2Schema, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeV2Schema, openExternalActionRequestV2,
    prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { ExternalActionExecutionAuthorizationRequestV1Schema, projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { configuration } from '@/configuration';
import { updateSettings, writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { reconcileExternalActionTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SessionSpawnNewInputV2Schema as BeforeCommitObservationInputSchema } from '../../../../../packages/protocol/src/sessions/creation/testFixtures/sessionSpawnInputBeforeCommitObservation';

// The daemon uses bundled Undici; keep the file's HTTP fixtures at that same
// network boundary while retaining its real control transport and parsers.
vi.mock('undici', async importOriginal => {
    const actual = await importOriginal<typeof import('undici')>();
    return { ...actual, fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
        default: { ...actual.default, fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) } };
});

describe('paired terminal Action admission', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it.each(['execute', 'prepare'] as const)('consumes a forwarded approval at the real signed-root %s ingress', async method => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-deferred-approval-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const actionId = 'mcp.servers.signIn.start';
            const input = { serverId: 'fixture' };
            const receipt = { attemptId: 'attempt', machineId: 'own-machine', authorizationUrl: 'https://issuer.fixture.test/authorize', expiresAtMs: 5000 };
            const onApprovalRequested = vi.fn(async () => ({ ok: true as const,
                result: { ok: true, status: 'executed', liveExecution: { ok: true, result: receipt } } }));
            // Only the authenticated local daemon HTTP transport is substituted.
            const ingress = vi.fn(async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(JSON.parse(String(options.body))).toMatchObject({ actionId, input });
                return Response.json({ ok: true, result: { kind: 'approval_request_created', actionId, artifactId: 'signed-root-approval' } });
            });
            vi.stubGlobal('fetch', ingress);
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                machineId: 'own-machine', onApprovalRequested,
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = method === 'execute' ? await executor.execute(actionId, input, { surface: 'cli' })
                : await (async () => {
                    const prepared = await executor.prepare(actionId, input, { surface: 'cli' });
                    return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
                })();
            expect(result).toEqual({ ok: true, result: receipt });
            expect(onApprovalRequested).toHaveBeenCalledOnce();
            expect(ingress).toHaveBeenCalledOnce();
        });
    });

    it('retains the canonical selector refusal when an explicit terminal Machine conflicts with the envelope', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-terminal-selection-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const executor = createCliActionExecutorFromCredentials({
                credentials: { token, encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
            });
            const result = await executor.execute('machines.terminal.list', {
                serverId: configuration.activeServerId, machineId: 'selected-machine',
            }, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'envelope-machine' } });
            expect(result).toEqual({ ok: false, errorCode: 'target_not_local', error: 'target_not_local',
                details: { phase: 'target_machine_selection' } });
        });
    });

    it.each(['execute', 'prepare'] as const)('admits template %s locally before reading its source without requiring any daemon', async method => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-template-requester-admission-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const input = { source: { kind: 'artifact' as const, serverId: 'srv_home', artifactId: '84a6bc9c-0418-44f6-a593-8a751bde13e0' },
                expectedVersion: '1.0.0', creation: { creationKey: 'private-template-creation-key', environmentVariables: { PRIVATE_TOKEN: 'private-template-env-secret' },
                    executionTarget: { serverId: 'srv_home', machineId: 'asleep-machine' }, directory: { kind: 'managed' as const },
                    agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } };
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                expect(String(url)).toBe('https://home.test/v1/account/encryption');
                return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            });
            let admittedRequest: unknown;
            const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                expect(String(url)).toBe('https://home.test/v1/actions/template.instantiate/execution-authorization');
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                admittedRequest = request;
                expect(request).toMatchObject({ machineId: 'asleep-machine', envelope: { input: { source: input.source,
                    expectedVersion: input.expectedVersion, creation: { executionTarget: input.creation.executionTarget } },
                    target: { kind: 'machine', machineId: 'asleep-machine' } } });
                expect(request.installationProof).toBeUndefined();
                const refusal = projectExternalActionHttpError('credential_scope_denied', request.envelope.requestId);
                return { status: refusal.statusCode, data: refusal.payload };
            });
            vi.stubGlobal('fetch', async () => { throw new Error('Requester-local creation must not contact a daemon'); });
            const executor = createCliActionExecutorFromCredentials({
                credentials: { token, encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
            });
            const context = { surface: 'cli' as const, authority: 'present_user' as const };
            const result = method === 'execute' ? await executor.execute('template.instantiate', input, context)
                : await (async () => {
                    const prepared = await executor.prepare('template.instantiate', input, context);
                    return prepared.kind === 'ready' ? prepared.invocation.run() : prepared.result;
                })();
            expect(JSON.stringify(admittedRequest)).not.toContain('private-template-creation-key');
            expect(JSON.stringify(admittedRequest)).not.toContain('private-template-env-secret');
            expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
            expect(post).toHaveBeenCalledTimes(1);
        });
    });

    it('keeps the Account-scoped configured Machine ahead of the global default', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-session-create-configured-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            await updateSettings(settings => ({ ...settings, machineId: 'another-account-machine',
                machineIdByServerIdByAccountId: { [configuration.activeServerId]: { owner: 'account-scoped-machine' } },
                lastTokenSubByServerId: { [configuration.activeServerId]: 'owner' },
            }));
            const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('A configured target needs no inventory read'));
            const executor = createCliActionExecutorFromCredentials({
                credentials: { token, encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
            });
            expect(await executor.resolveMachineTarget()).toEqual({ ok: true, machineId: 'account-scoped-machine' });
            expect(get).not.toHaveBeenCalled();
        });
    });

    it.each([false, true])('returns a typed Session-create refusal before dispatch when its Machine is unavailable (missing: %s)', async missing => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-session-create-offline-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const machineId = 'offline-machine';
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const input = { creationKey: 'offline-create', executionTarget: { serverId: configuration.activeServerId, machineId },
                directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } };
            const machine = { id: machineId, kind: 'persistent', active: false, revokedAt: null, replacedByMachineId: null,
                access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'owner', displayName: 'Owner' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' }) };
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (String(url).endsWith('/v1/machines')) return { status: 200, data: missing ? [] : [machine] };
                if (String(url).endsWith(`/v1/machines/${machineId}`)) return { status: missing ? 404 : 200, data: { machine } };
                if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                throw new Error('Unexpected Home read');
            });
            const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No create may be dispatched'));
            const localRequests: unknown[] = [];
            vi.stubGlobal('fetch', async () => { localRequests.push(true); throw new Error('No daemon request expected'); });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                resolveServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            expect(await executor.execute('session.spawn_new', input, { surface: 'cli' })).toMatchObject({
                ok: false, errorCode: 'machine_offline', details: { machineId },
            });
            expect(post).not.toHaveBeenCalled();
            expect(localRequests).toEqual([]);
        });
    });

    it.each(['execute', 'prepare'] as const)('rejects raw terminal CLI observer authoring before %s transport', async method => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-observer-admission-', }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const input = { creationKey: 'terminal-observer-admission',
                executionTarget: { serverId: configuration.activeServerId, machineId: 'own-machine' },
                directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } };
            const transported: unknown[] = [];
            vi.spyOn(axios, 'get').mockRejectedValue(new Error('Requester Machine probe unavailable'));
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('No Home Action dispatch expected'));
            vi.stubGlobal('fetch', async (_url: unknown, options: RequestInit) => {
                const request: unknown = JSON.parse(String(options.body));
                transported.push(request && typeof request === 'object' ? Reflect.get(request, 'input') : null);
                return Response.json({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: false } });
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                resolveServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const invoke = async (value: unknown) => {
                if (method === 'execute') return await executor.execute('session.spawn_new', value, { surface: 'cli' });
                const prepared = await executor.prepare('session.spawn_new', value, { surface: 'cli' });
                return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
            };
            expect(await invoke(input)).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: false } });
            expect(transported).toHaveLength(1);
            expect(BeforeCommitObservationInputSchema.safeParse(transported[0]).success).toBe(true);
            const observed = await invoke({ ...input, observeSessionCommit: true });
            expect(transported.every(value => BeforeCommitObservationInputSchema.safeParse(value).success)).toBe(true);
            expect(observed).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            expect(transported).toHaveLength(1);
        });
    });

    it.each(['execute', 'prepare'] as const)('keeps scoped service-log %s admission at the owning daemon without ingress opt-in', async method => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-service-log-scope-', }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const actionId = 'machines.services.logs.read';
            const input = { serverId: 'srv_home', machineId: 'own-machine', serviceId: 'instance/db' };
            const settings = setScopedActionApprovalPreference({ actionId, scope: { kind: 'environment', environmentId: 'environment-a' },
                surface: 'cli', mode: 'waived', settings: ActionsSettingsV1Schema.parse({ v: 1,
                    actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }) });
            const expected = { ok: true, result: { kind: 'page', page: {
                sourceRevision: 'container-a', text: 'db output', nextCursor: null, truncated: false } } };
            vi.spyOn(axios, 'get').mockRejectedValue(new Error('Service scope belongs to the target daemon'));
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('No outer approval may precede service scope'));
            const requests: unknown[] = [];
            // Only the daemon HTTP boundary is substituted; original admission/credential selection stay real.
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                const request: unknown = JSON.parse(String(options.body));
                requests.push(request);
                expect(request).toMatchObject({ actionId, input, target: { kind: 'machine', machineId: input.machineId } });
                return Response.json(expected);
            });
            const executor = createCliActionExecutorFromCredentials({ credentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => settings } });
            const result = method === 'execute' ? await executor.execute(actionId, input, { surface: 'cli' })
                : await (async () => {
                    const prepared = await executor.prepare(actionId, input, { surface: 'cli' });
                    return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
                })();
            expect(result).toEqual(expected);
            expect(requests).toHaveLength(1);
        });
    });

    it.each(['execute', 'prepare'] as const)('delegates Compose adoption %s to its daemon owner before local policy or native observation', async method => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-service-adopt-ingress-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const actionId = 'machines.services.adopt';
            const input = { serverId: 'srv_home', machineId: 'own-machine', serviceId: 'watched-compose',
                expectedGeneration: 'generation', requestKey: 'adopt', profiles: [], mode: 'review' };
            const expected = { ok: true, result: { kind: 'review', reviewedDigest: `sha256:${'a'.repeat(64)}`,
                originalProfiles: 'unknown', document: 'services: {}', variables: [], services: [], profiles: [], availableProfiles: [] } };
            vi.spyOn(axios, 'get').mockRejectedValue(new Error('Adoption belongs to the receiving daemon'));
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('No outer approval may precede adoption preparation'));
            const requests: unknown[] = [];
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                const request: unknown = JSON.parse(String(options.body));
                requests.push(request);
                expect(request).toMatchObject({ actionId, input, target: { kind: 'machine', machineId: input.machineId } });
                return Response.json(expected);
            });
            const executor = createCliActionExecutorFromCredentials({ credentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = method === 'execute' ? await executor.execute(actionId, input, { surface: 'cli' })
                : await (async () => {
                    const prepared = await executor.prepare(actionId, input, { surface: 'cli' });
                    return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
                })();
            expect(result).toEqual(expected);
            expect(requests).toHaveLength(1);
        });
    });

    it.each([false, true])('routes protected CLI input through its existing Session custody before the native runtime is ready (other local daemon: %s)', async otherLocalDaemon => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-starting-session-input-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const secret = new Uint8Array(32).fill(17);
            const credentials = { token, encryption: { type: 'legacy' as const, secret }, credentialProvenance: 'stored_session' as const };
            const sessionId = 'c123456789012345678901234';
            const input = { sessionId: otherLocalDaemon ? 'startup' : sessionId,
                message: 'queue while starting', localId: 'startup-cli-input', wait: false };
            const target = { kind: 'session' as const, sessionId };
            const machineId = 'session-machine';
            const session = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'e2ee', share: null,
                metadata: encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' },
                    payload: { machineId, path: '/workspace', flavor: 'claude' } }) });
            if (otherLocalDaemon) writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'other-machine', accountId: 'requester' });
            const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
            const requests: unknown[] = [];
            // HTTP is substituted; credential provenance, Session decryption,
            // target selection, encrypted dispatch and output parsing stay real.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'e2ee', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                throw new Error(`Unexpected HTTP read: ${url}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                if (url.endsWith('/v2/sessions/lookup-by-tags')) {
                    expect(body).toEqual({ tags: ['startup'] });
                    return { status: 200, data: { sessions: [session] } };
                }
                expect(url).toBe('https://home.test/v1/actions/session.message.send');
                const envelope = ExternalActionRequestEnvelopeV2Schema.parse(body);
                const binding = { serverIdentityId: 'srv_home', accountId: 'requester',
                    authentication: { kind: 'account' as const, tokenEpoch: 4 }, actionId: 'session.message.send',
                    requestId: envelope.requestId, target };
                expect(envelope.target).toEqual(target);
                const decodedInput = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })?.input;
                const reconciliation = reconcileExternalActionTarget({ actionId: 'session.message.send', rawInput: decodedInput,
                    target: envelope.target, currentMachineId: machineId });
                if (reconciliation.kind === 'ready') expect(decodedInput).toEqual({ ...input, sessionId });
                requests.push(body);
                return { status: 200, data: prepareExternalActionResponseV2({ request: envelope, binding, material,
                    executedMachineId: machineId, randomBytes: length => new Uint8Array(length).fill(6),
                    execution: reconciliation.kind === 'rejected' ? reconciliation.execution
                        : { ok: true, result: { status: 'accepted', localId: input.localId } } }).response };
            });
            const executor = createCliActionExecutorFromCredentials({ credentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            expect(await executor.execute('session.message.send', input, { surface: 'cli' }))
                .toEqual({ ok: true, result: { status: 'accepted', localId: input.localId } });
            expect(await executor.execute('session.message.send', input,
                { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'wrong-machine' } }))
                .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            const mismatched = createCliActionExecutorFromCredentials({ credentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test', machineId: 'wrong-machine',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            expect(await mismatched.execute('session.message.send', input, { surface: 'cli' }))
                .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(requests).toHaveLength(1);
        });
    });

    it.each([
        { explicitMachine: false, daemonAccountId: 'owner' },
        { explicitMachine: true, daemonAccountId: 'owner' },
        { explicitMachine: false, daemonAccountId: null },
        { explicitMachine: false, daemonAccountId: 'another-account' },
    ])('retains a blocking private result on the same-Account daemon invocation without ingress opt-in (%j)', async ({ explicitMachine, daemonAccountId }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-live-result-admission-', }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            if (daemonAccountId) writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: daemonAccountId });
            const outputSchema = getActionSpec('mcp.servers.signIn.start').outputSchema;
            if (!outputSchema) throw new Error('Sign-in requires a schema-backed result');
            const result = { ok: true, result: outputSchema.parse({
                attemptId: 'attempt', machineId: 'own-machine', authorizationUrl: 'https://issuer.fixture.test/authorize', expiresAtMs: 5000 }) };
            // Only the daemon HTTP transport is substituted. The credentialed
            // factory, Machine publication, authority and response parser stay real.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (daemonAccountId !== 'owner' && url.endsWith('/v1/machines')) return { status: 200, data: [] };
                throw new Error('Unexpected Home request');
            });
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected Home mutation'));
            const requests: unknown[] = [];
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                // Human approval follows this caller's lifetime, without the
                // generic daemon-control timeout creating a competing signal.
                expect(options.signal).toBeUndefined();
                requests.push(JSON.parse(String(options.body)));
                return Response.json(result);
            });
            const executor = createCliActionExecutorFromCredentials({ credentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                ...(explicitMachine ? { machineId: 'own-machine' } : {}),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            expect(await executor.execute('mcp.servers.signIn.start', { serverId: 'fixture' }, { surface: 'cli' }))
                .toEqual(daemonAccountId === 'owner' ? result : { ok: false, errorCode: 'daemon_unavailable', error: 'daemon_unavailable' });
            expect(requests).toEqual(daemonAccountId === 'owner'
                ? [{ actionId: 'mcp.servers.signIn.start', input: { serverId: 'fixture' },
                    ...(explicitMachine ? { target: { kind: 'machine', machineId: 'own-machine' } } : {}) }]
                : []);
        });
    });

    it('keeps default private-result administration reachable through Home when no local daemon is installed', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-live-result-remote-' }, async () => {
            const currentness = await createRequesterCurrentnessSocketHarness();
            onTestFinished(() => currentness.close());
            onTestFinished(() => resetActiveAccountSettingsSnapshotForTests());
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
                settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                    settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
                if (url.endsWith('/v1/account/entity-rows/mcp')) return { status: 200, data: McpServerCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'fixture', name: 'fixture', transport: 'http',
                        remote: { url: 'https://issuer.fixture.test/mcp', headers: {}, auth: { kind: 'oauth' } },
                        env: {}, createdAt: 1, updatedAt: 1 }] } } }) };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
                if (url.endsWith('/v1/machines/remote-machine')) return { status: 200, data: { machine: {
                    id: 'remote-machine', kind: 'persistent', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    revokedAt: null, replacedByMachineId: null,
                } } };
                if (url.endsWith('/v1/machines')) return { status: 200, data: [{ id: 'remote-machine', active: true,
                    activeAt: Date.now(), kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage',
                        resourceMode: 'plain', accessState: 'ready' } }] };
                throw new Error(`Unexpected Home request: ${url}`);
            });
            const result = { ok: true, result: { attemptId: 'attempt', machineId: 'remote-machine',
                authorizationUrl: 'https://issuer.fixture.test/authorize', expiresAtMs: 5000 } };
            const requests: unknown[] = [];
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('MCP sign-in must use its current catalog and Machine transport'));
            // Home HTTP and the real Socket.IO peer are the only substituted
            // boundaries; MCP and Connected Account composition remain real.
            currentness.server.on('connection', socket => socket.on('rpc-call', (packet, acknowledge) => {
                requests.push(packet);
                expect(packet.method).toMatch(/^remote-machine:/);
                if (packet.method === `remote-machine:${CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD}`) {
                    expect(packet.params.command).toMatchObject({ operation: 'describeService', service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 });
                    acknowledge({ ok: true, result: { status: 'described', service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1,
                        descriptor: { id: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1.localId, title: 'MCP sign-in',
                            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
                                callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', pkce: 'required', outcomeReconciliation: 'none' }] } },
                        accounts: [], operationTransport: { kind: 'v4' }, occurrenceId: 'host-occurrence', sourceCustody: { kind: 'host' } } });
                } else {
                    expect(packet.method).toBe(`remote-machine:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`);
                    expect(packet.params.command).toMatchObject({ operation: 'beginConnect', service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, modeId: 'oauth' });
                    acknowledge({ ok: true, result: { status: 'awaitingOAuth', attemptId: 'attempt',
                        authorizationUrl: 'https://issuer.fixture.test/authorize', expiresAtMs: 5000,
                        callbackUrl: 'https://app.happier.dev/oauth/mcp/callback' } });
                }
            }));
            const admittedCatalog = await runWithServerHttpBaseUrl('https://home.test', () =>
                createCliMcpServerStore({ credentials, serverId: configuration.activeServerId }).readCatalogForOperation());
            expect(admittedCatalog, JSON.stringify(admittedCatalog)).toMatchObject({ status: 'ready', authority: 'active' });
            const executor = createCliActionExecutorFromCredentials({ credentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1,
                    approvalWaivedSurfaces: { 'mcp.servers.signIn.start': ['cli'] } }) } });
            const remoteResult = await executor.execute('mcp.servers.signIn.start', { serverId: 'fixture' }, { surface: 'cli' });
            expect(remoteResult, JSON.stringify(remoteResult)).toEqual(result);
            expect(requests).toHaveLength(2);
        });
    });

    it.each([
        { method: 'execute', placement: 'machine' },
        { method: 'prepare', placement: 'machine' },
        { method: 'execute', placement: 'account' },
    ] as const)('uses selected-Machine plugin discovery without borrowing Account custody ($method/$placement)', async ({ method, placement }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-plugin-selected-machine-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const id = 'acme.source/actions/discover';
            const descriptor = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse({ actionSpec: {
                id, title: 'Discover', description: null, safety: 'safe', executionPlacement: placement,
                placements: [], slash: null, bindings: null, examples: null, surfaces: { cli: true }, inputHints: null,
                inputSchema: { type: 'object' } } });
            // Only Home/daemon HTTP is substituted. Account placement, credential
            // provenance, target selection and both Action factories stay real.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (url.endsWith('/v1/machines')) return { status: 200, data: [{ id: 'selected-machine', active: true,
                    activeAt: Date.now(), kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage',
                        resourceMode: 'plain', accessState: 'ready' } }] };
                throw new Error(`Unexpected Home read: ${url}`);
            });
            const routed: string[] = [];
            vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
                if (url.endsWith(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'])) return { status: 200,
                    data: { availabilityCursor: 1, pluginIds: [], intentReads: [], failedPluginIds: [] } };
                if (url.endsWith(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'])) return { status: 200,
                    data: { availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 16777216, maxAccountBytes: 268435456 },
                        intent: null, release: null, uiArtifacts: [], packageAssets: [] } };
                const actionId = url.endsWith('/v1/actions/action.spec.get') ? 'action.spec.get' : 'action.invoke';
                expect(url).toBe(`https://home.test/v1/actions/${actionId}`);
                expect(options?.headers).toMatchObject({ [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' });
                const envelope = body as { requestId: string; target: unknown; input: unknown };
                expect(envelope.target).toEqual({ kind: 'machine', machineId: 'selected-machine' });
                expect(envelope.input).toEqual(actionId === 'action.spec.get' ? { id }
                    : { action: { pluginId: 'acme.source', localId: 'discover' }, input: { limit: 100 } });
                routed.push(actionId);
                return { status: 200, data: { v: 1, actionId, requestId: envelope.requestId,
                    execution: { ok: true, result: actionId === 'action.spec.get' ? descriptor : { candidates: ['retained'] } } } };
            });
            vi.stubGlobal('fetch', async () => { throw new Error('A separate CLI identity has no local daemon'); });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test', machineId: 'selected-machine',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const run = async (actionId: 'action.spec.get' | 'action.invoke', input: unknown) => {
                const context = { surface: 'cli' as const, authority: 'account_automation' as const };
                if (method === 'execute') return await executor.execute(actionId, input, context);
                const before = [...routed];
                const prepared = await executor.prepare(actionId, input, context);
                expect(routed).toEqual(before);
                if (prepared.kind !== 'ready') return prepared.result;
                const result = await prepared.invocation.run();
                expect(await prepared.invocation.run()).toEqual(result);
                return result;
            };
            const discovered = await run('action.spec.get', { id });
            if (placement === 'account') {
                expect(discovered).toMatchObject({ ok: false, errorCode: 'plugin_action_execution_placement_unavailable' });
                expect(routed).toEqual(['action.spec.get']);
                return;
            }
            expect(discovered).toEqual({ ok: true, result: descriptor });
            expect(await run('action.invoke', { action: { pluginId: 'acme.source', localId: 'discover' }, input: { limit: 100 } }))
                .toEqual({ ok: true, result: { candidates: ['retained'] } });
            // One exact descriptor per invocation, then the effect: no inventory
            // fan-out or fallback to a different daemon on refusal.
            expect(routed).toEqual(['action.spec.get', 'action.spec.get', 'action.invoke']);
        });
    });

    it.each([
        { actionId: 'session.role.set', input: { sessionId: 'session-one', roleId: 'builder' }, method: 'execute', output: { updated: true } },
        { actionId: 'session.read_state.set', input: { sessionId: 'session-one', state: 'read' }, method: 'execute',
            output: { state: 'read', lastViewedSessionSeq: 7, didChange: true } },
        { actionId: 'action.spec.search', input: { query: 'sessioncreaterefusal_ingress_fixture' }, method: 'execute', output: { actionSpecs: [] } },
        { actionId: 'action.invoke', input: { action: { pluginId: 'acme.source', localId: 'discover' }, input: { v: 1 } },
            method: 'execute', output: { candidates: [] } },
        { actionId: 'session.role.set', input: { sessionId: 'session-one', roleId: 'builder' }, method: 'prepare', output: { updated: true } },
    ] as const)('keeps an own-Machine terminal $actionId $method on its authenticated daemon ingress', async ({ actionId, input, method, output }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-action-admission-', }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const serverId = configuration.activeServerId;
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const outputSchema = getActionSpec(actionId).outputSchema;
            if (!outputSchema) throw new Error('Fixture requires a schema-backed Action');
            const expected = { ok: true, result: outputSchema.parse(output) };
            // HTTP is the boundary; credential, exact daemon discovery and Action composition stay real.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (actionId === 'session.role.set' && url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
                    data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                throw new Error('Unexpected Home request');
            });
            // The Account's plugin availability census is the only Home read a plugin Action needs
            // before it proves Machine placement; this Account has no plugin intents.
            const availability = (url: string) => url.endsWith(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'])
                ? { availabilityCursor: 1, pluginIds: [], intentReads: [], failedPluginIds: [] }
                : url.endsWith(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'])
                    ? { availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 16 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024 },
                        intent: null, release: null, uiArtifacts: [], packageAssets: [] }
                    : null;
            vi.spyOn(axios, 'post').mockImplementation(async url => actionId === 'session.role.set' && url.endsWith('/v2/sessions/lookup-by-tags')
                ? { status: 200, data: { sessions: [createSessionRecordFixture({ id: 'session-one', encryptionMode: 'plain', share: null,
                    metadata: JSON.stringify({ machineId: 'own-machine', path: '/workspace', flavor: 'claude' }) })] } }
                : availability(url) ? { status: 200, data: availability(url) } : { status: 401, data: { error: 'invalid_token' } });
            // An explicit Machine uses the original CLI's signed root owner,
            // including the placement-aware plugin discovery/invocation path.
            let ingressRequests = 0;
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                ingressRequests++;
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                const body = JSON.parse(String(options.body));
                // A contributed Action's typed Machine placement is read before its effect reaches the daemon.
                if (actionId === 'action.invoke' && body.actionId === 'action.spec.get') return Response.json({
                    ok: true, result: PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse({ actionSpec: {
                        id: body.input.id, title: 'Discover', description: null, safety: 'safe', executionPlacement: 'machine',
                        placements: [], slash: null, bindings: null, examples: null, surfaces: { cli: true }, inputHints: null,
                        inputSchema: { type: 'object' } } }) });
                expect(body).toMatchObject({ actionId, input });
                return Response.json(expected);
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test', machineId: 'own-machine',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = method === 'execute' ? await executor.execute(actionId, input, { surface: 'cli' })
                : await (async () => {
                    const prepared = await executor.prepare(actionId, input, { surface: 'cli' });
                    return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
                })();
            expect(result).toEqual(expected);
            expect(ingressRequests).toBeGreaterThan(0);
        });
    });

    it.each([
        { explicitMachine: false, daemonAccountId: 'owner', own: true },
        { explicitMachine: true, daemonAccountId: 'owner', own: true },
        { explicitMachine: false, daemonAccountId: 'different-account', own: false },
    ])('routes a declared client Action only through its own Account daemon ($explicitMachine/$daemonAccountId)', async ({ explicitMachine, daemonAccountId, own }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-client-admission-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const serverId = configuration.activeServerId;
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: daemonAccountId });
            const surface = { serverId: 'srv_home', accountId: 'owner',
                owner: { kind: 'project' as const, projectId: 'project', layoutId: 'notes' } };
            // Mock only HTTP: both Action factories, stored provenance and daemon discovery remain real.
            vi.spyOn(axios, 'get').mockRejectedValue(new Error('Own client placement must not need Home Machine admission'));
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('A terminal is not a PAT'));
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                expect(JSON.parse(String(options.body))).toMatchObject({ actionId: 'widgets.area.layout.select', input: { surface } });
                expect(new Headers(options.headers).get(AUTHORITY_CEILING_HEADER_V1)).toBe('account_automation');
                return Response.json({ ok: true, result: { surface } });
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                ...(explicitMachine ? { machineId: 'own-machine' } : {}),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            expect(await executor.execute('widgets.area.layout.select', { surface }, { surface: 'cli', authority: 'account_automation' }))
                .toEqual(own ? { ok: true, result: { surface } }
                    : { ok: false, errorCode: 'unavailable', error: 'noClient' });
        });
    });

    it.each([
        { outerTarget: false, daemonAccountId: 'owner', authority: undefined, errorCode: null },
        { outerTarget: false, daemonAccountId: 'owner', authority: undefined, errorCode: null, requesterProbeUnavailable: true },
        { outerTarget: false, daemonAccountId: 'owner', authority: undefined, errorCode: null, discoverIdentity: true },
        { outerTarget: false, daemonAccountId: 'owner', authority: undefined, errorCode: null, discoverIdentity: true, prepare: true },
        { outerTarget: true, daemonAccountId: 'owner', authority: undefined, errorCode: null },
        { outerTarget: false, daemonAccountId: 'different-account', authority: undefined, errorCode: 'target_unavailable' },
        { outerTarget: false, daemonAccountId: 'owner', authority: 'account_automation', errorCode: 'invalid_parameters' },
    ] as const)('preserves exact Home/Account and terminal authority (%j)', async scenario => {
        const { outerTarget, daemonAccountId, authority, errorCode } = scenario;
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-create-admission-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const serverId = configuration.activeServerId;
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: daemonAccountId });
            const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'terminal-create',
                executionTarget: { serverId, machineId: 'own-machine' }, directory: { kind: 'managed' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } });
            // HTTP and persisted daemon publication are the system boundaries;
            // credential provenance, target resolution and both Action factories are real.
            vi.spyOn(axios, 'get').mockImplementation(async (url) => {
                if ('requesterProbeUnavailable' in scenario) throw new Error('Requester Machine probe is unavailable');
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (url.endsWith('/v1/machines/own-machine')) return { status: 200, data: { machine: {
                    id: 'own-machine', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
                    dataEncryptionKey: null, runnerContentKeyBinding: null } } };
                throw new Error(`Unexpected HTTP read: ${url}`);
            });
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('Session creation is not a terminal Home finite Action'));
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                expect(JSON.parse(String(options.body))).toMatchObject({ actionId: 'session.spawn_new', input });
                // Mirror the existing receiver: an automation ceiling has no
                // bare terminal creation namespace and must not become human.
                if (new Headers(options.headers).get(AUTHORITY_CEILING_HEADER_V1) === 'account_automation') {
                    return Response.json({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
                }
                return Response.json({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } });
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId, serverIdentityId: 'discoverIdentity' in scenario ? undefined : 'srv_home', serverApiUrl: 'https://home.test',
                resolveServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
                ...(outerTarget ? { machineId: 'own-machine' } : {}),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const context = { surface: 'cli' as const, ...(authority ? { authority } : {}) };
            const result = 'prepare' in scenario
                ? await (async () => {
                    const prepared = await executor.prepare('session.spawn_new', input, context);
                    return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
                })()
                : await executor.execute('session.spawn_new', input, context);
            expect(result).toEqual(errorCode === null
                ? { ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } }
                : { ok: false, errorCode, error: errorCode });
        });
    });
});
