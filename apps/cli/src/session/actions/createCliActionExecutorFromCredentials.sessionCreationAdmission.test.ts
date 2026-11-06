import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { PLUGIN_ACTION_EXECUTE_PATH } from '@/plugins/daemon/controlRoutes';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { SessionSpawnNewInputV2Schema, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeV2Schema, openExternalActionRequestV2,
    prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { reconcileExternalActionTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

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
        await withConfiguredDaemonTestHome({ prefix: 'happier-live-result-admission-',
            env: { HAPPIER_CLI_PRESENT_USER: 'allowed' } }, async () => {
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
        { actionId: 'session.role.set', input: { sessionId: 'session-one', roleId: 'builder' }, method: 'execute', output: { updated: true } },
        { actionId: 'session.read_state.set', input: { sessionId: 'session-one', state: 'read' }, method: 'execute',
            output: { state: 'read', lastViewedSessionSeq: 7, didChange: true } },
        { actionId: 'action.spec.search', input: { query: 'triage' }, method: 'execute', output: { actionSpecs: [] } },
        { actionId: 'action.invoke', input: { action: { pluginId: 'acme.source', localId: 'discover' }, input: { v: 1 } },
            method: 'execute', output: { candidates: [] } },
        { actionId: 'session.role.set', input: { sessionId: 'session-one', roleId: 'builder' }, method: 'prepare', output: { updated: true } },
    ] as const)('keeps an own-Machine terminal $actionId $method on its authenticated daemon ingress', async ({ actionId, input, method, output }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-action-admission-',
            env: { HAPPIER_CLI_PRESENT_USER: 'allowed' } }, async () => {
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
            // Plugin discovery and contributed-Action invocation enter the daemon's placement-aware plugin ingress;
            // every other Action enters the signed root ingress. Both authenticate with the daemon control token.
            const pluginIngress = actionId === 'action.spec.search' || actionId === 'action.invoke';
            let ingressRequests = 0;
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                ingressRequests++;
                expect(String(url)).toBe(`http://127.0.0.1:43123${pluginIngress ? PLUGIN_ACTION_EXECUTE_PATH : '/actions/root/execute'}`);
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                const body = JSON.parse(String(options.body));
                // A contributed Action's typed Machine placement is read before its effect reaches the daemon.
                if (actionId === 'action.invoke' && body.actionId === 'action.spec.get') return Response.json({ matched: true,
                    result: { ok: true, result: PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse({ actionSpec: {
                        id: body.input.id, title: 'Discover', description: null, safety: 'safe', executionPlacement: 'machine',
                        placements: [], slash: null, bindings: null, examples: null, surfaces: { cli: true }, inputHints: null,
                        inputSchema: { type: 'object' } } }) } });
                expect(body).toMatchObject({ actionId, input });
                return Response.json(pluginIngress ? { matched: true, result: expected } : expected);
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
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null, requesterProbeUnavailable: true },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null, discoverIdentity: true },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null, discoverIdentity: true, prepare: true },
        { outerTarget: true, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null },
        { outerTarget: false, daemonAccountId: 'different-account', terminalPolicy: 'allowed', authority: undefined, errorCode: 'target_unavailable' },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: 'account_automation', errorCode: 'invalid_parameters' },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'disallowed', authority: undefined, errorCode: 'invalid_parameters' },
    ] as const)('preserves exact Home/Account and terminal policy (%j)', async scenario => {
        const { outerTarget, daemonAccountId, terminalPolicy, authority, errorCode } = scenario;
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-create-admission-',
            env: { HAPPIER_CLI_PRESENT_USER: terminalPolicy } }, async () => {
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
