import '../../../../ui/sources/dev/vitestSetup';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as socketBoundary } from 'socket.io-client';
import * as React from 'react';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { listPendingPermissionRequests } from '@happier-dev/session-core/pending';
import { SessionPermissionRespondRpcParamsV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { accountSettingsParse, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState } from '@/api/types';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { ProviderEnforcedPermissionHandler } from './providerEnforced/handler';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { registerSocketRpcHandlers } from '../../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
import { evaluateAccountStoredContentSocketCompatibility } from '../../../../server/sources/app/clientCompatibility/accountStoredContentCompatibility';
import { createSessionMachineAccessKeyInTx } from '../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { resolveSessionScopedSocketBinding } from '../../../../server/sources/app/api/socket/sessionScopedBinding';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource, standardCleanup } from '../../../../ui/sources/dev/testkit';
import { installPermissionShellCommonModuleMocks } from '../../../../ui/sources/components/tools/shell/permissions/permissionShellTestHelpers';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import { createClaudeNativePermissionEngine } from '../../../../../packages/plugins/claude/src/agent/permissions/nativePermissionEngine';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionFixture } from '../../../../ui/sources/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { McpServerCatalogV1Schema, McpServerCatalogRowMutationV1Schema, McpServerCatalogRowReadResponseV1Schema,
    McpServerCatalogRowMutationResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { mutateMcpServerCatalogRowInTx, readMcpServerCatalogRowInTx } from '../../../../server/sources/app/account/mcp/serverRows';
import { answerSessionPermission } from '../../../../ui/sources/sync/ops/sessionPermissionAnswers';
import { renderHook, createDeferred } from '../../../../ui/sources/dev/testkit';
import { act } from 'react-test-renderer';
import { createPlainAccountEncryptionCurrentnessFixture } from '../../../../ui/sources/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Keep actual sockets for the relay; the app's SDK boundary forwards its real
// emitted carrier to those sockets without rebuilding its Action or RPC payload.
void socketBoundary;
const { io } = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

// Only platform boundaries use the canonical UI mocks; keep the real store.
installPermissionShellCommonModuleMocks({ storage: async importOriginal => await importOriginal() });
await loadSyncSingletonForTests();
const { PermissionPromptCard } = await import('../../../../ui/sources/components/tools/shell/permissions/PermissionPromptCard');
const { createAppSessionTranscriptActions } = await import('../../../../ui/sources/components/sessions/transcript/source/appSessionTranscriptActions');
const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
const { Platform } = await import('react-native');
const { createBoundPluginSurfaceController } = await import('../../../../ui/sources/components/plugins/surfaces/boundPluginSurfaceController');
const { createCanonicalPluginReactNativeHostApiAdapter } = await import('../../../../ui/sources/components/plugins/reactNative/hostApi');
const { createPluginSurfaceContextFixture } = await import('../../../../ui/sources/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { captureActiveServerAccountScopeLifetime } = await import('../../../../ui/sources/sync/domains/scope/activeServerAccountScope');
const { useMcpAlwaysAllow } = await import('../../../../ui/sources/components/tools/shell/permissions/useMcpAlwaysAllow');
const { createDefaultActionExecutor } = await import('../../../../ui/sources/sync/ops/actions/defaultActionExecutor');

describe('Session permission responses through production UI Actions and the authenticated relay', () => {
    let database: LightSqliteHarness;
    // Canonical migration preparation is outside the interactive response
    // cases. Let its actual completion/error settle instead of imposing a
    // shorter phase cutoff on the containing composed validation command.
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-permission-response-', initAuth: false });
    }, 0);
    afterAll(async () => { if (database) await database.close(); });
    beforeEach(async () => {
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        setActiveAccountSettingsSnapshot({ scopeKey: 'edit-seam', source: 'network', settingsVersion: 1,
        settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
        promptLibraryCatalog: { status: 'ready', rows: [
            { record: { key: 'role-overrides', value: { v: 1, overrides: {} } }, revision: 0 },
        ], tombstones: [], diagnostics: [] } });
    });
    afterEach(() => resetActiveAccountSettingsSnapshotForTests());
    afterEach(standardCleanup);

    it.each(['allowOnce', 'acceptEdits', 'nativeAllowOnce', 'nativeReusableGrantRefusal', 'nativeBashPlugin', 'misboundAction', 'mcpAlwaysAllow'] as const)('delivers %s through the production Action and relay', async button => {
        const isNative = button === 'nativeAllowOnce' || button === 'nativeReusableGrantRefusal' || button === 'nativeBashPlugin';
        const isMcp = button === 'mcpAlwaysAllow';
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const row = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, {
            accountId: account.id, sessionId: row.id, machineId: machine.id, data: 'fixture-access-key',
        }))).resolves.toMatchObject({ ok: true });
        const binding = await resolveSessionScopedSocketBinding({ userId: account.id, sessionId: row.id, machineId: machine.id });
        if (!binding.ok) throw new Error('Missing admitted Session publisher binding');
        const manager = new RpcHandlerManager({ scopePrefix: row.id, encryptionMode: 'plain', logger: () => {} });
        let state: AgentState = { requests: {}, completedRequests: {} };
        const agentStateLock = new AsyncLock();
        const permissionPublished = createDeferred<void>();
        // Session persistence is the boundary fixture; the request coordinator,
        // projection, UI codecs, Socket.IO relay and permission handler are real.
        const session = {
            sessionId: row.id,
            rpcHandlerManager: manager,
            getAgentStateSnapshot: () => state,
            getMetadataSnapshot: () => null,
            // ApiSessionClient serializes this boundary with its metadataLock.
            updateAgentState: (update: (previous: AgentState) => AgentState) => agentStateLock.inLock(async () => {
                const next = update(state);
                await db.session.update({ where: { id: row.id }, data: { agentState: JSON.stringify(next) } });
                state = next;
                if (Object.keys(next.requests ?? {}).length > 0) permissionPublished.resolve();
            }),
        };
        let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'github-catalog', name: 'github', title: 'GitHub', transport: 'stdio',
            stdio: { command: 'fixture-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
            tools: { default: 'allow_read_only', overrides: {} }, toolsSnapshot: { checkedAt: 1, machineId: machine.id,
                tools: [{ name: 'delete_file', title: 'Delete file', annotations: { destructiveHint: true }, tokens: 10 }] } }], bindings: [] });
        if (isMcp) await expect(inTx(tx => mutateMcpServerCatalogRowInTx(tx, { accountId: account.id,
            expectedRevision: 'absent', sourceSettingsVersion: account.settingsVersion, content: { t: 'plain', v: catalog }, referencedSavedSecretIds: [] })))
            .resolves.toMatchObject({ status: 'updated', revision: 0 });
        const handler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, { logPrefix: '[Permission seam]',
            ...(isMcp ? { getMcpToolContext: () => ({ catalog: { status: 'ready' as const, authority: 'active' as const,
                revision: 1, diagnostics: [], catalog }, mcpServerIdentities: { github: { serverId: 'github-catalog', serverTitle: 'GitHub' } } }) } : {}) });
        let requestId: string = randomUUID();
        const turnId = `native-turn-${randomUUID()}-1`;
        const toolName = isMcp ? 'mcp__github__delete_file' : button === 'nativeBashPlugin' ? 'Bash' : 'Edit';
        const input = toolName === 'Bash' ? { command: 'pwd' }
            : { file_path: '/fixture/alpha.txt', old_string: 'before', new_string: 'after' };
        const permissionContext = { turnId,
            causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const } };
        const nativeUi = createNativeAgentCurrentSessionUiServices({ permissionHandler: handler,
            pluginId: 'happier.agent.claude', contributionId: 'claude', runtimeId: 'claude/runtime', sessionId: row.id,
            occurrenceId: randomUUID(), isCurrent: () => true, signal: new AbortController().signal });
        const interactions = createPluginInteractionsService({ currentSession: nativeUi,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            readActiveTurnAdmissionWitness: () => ({ inputId: randomUUID(), userMessageSeq: null,
                userMessageSeqs: [], ...permissionContext }) });
        // The runtime context is a boundary fixture; its exercised interaction
        // service, native Claude producer and host presentation owner are real.
        const nativeContext = { services: { interactions } } as unknown as AgentRuntimeContext;
        const nativeApplications: unknown[] = [];
        const pending = isNative
            ? createClaudeNativePermissionEngine(nativeContext).canCallTool(toolName, input)
            : handler.handleToolCall(requestId, toolName, input, permissionContext);
        // Claude's SDK consumes this hook return as its native application boundary.
        if (isNative) void pending.then(result => { nativeApplications.push(result); }, () => {});
        void pending.catch(() => {});
        let failCatalogSave = isMcp;
        const catalogSaveStarted = createDeferred<void>();
        const releaseCatalogSave = createDeferred<void>();
        const http = createServer((request, response) => {
            if (request.url !== '/v1/account/entity-rows/mcp') { response.writeHead(404); response.end(); return; }
            void (async () => {
                response.setHeader('Content-Type', 'application/json');
                if (request.method !== 'POST') {
                    response.end(JSON.stringify(McpServerCatalogRowReadResponseV1Schema.parse(await readMcpServerCatalogRowInTx(db, { accountId: account.id }))));
                    return;
                }
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const mutation = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
                catalogSaveStarted.resolve();
                await releaseCatalogSave.promise;
                if (failCatalogSave) { response.writeHead(503); response.end('{}'); return; }
                const result = await inTx(tx => mutateMcpServerCatalogRowInTx(tx, { accountId: account.id, ...mutation }));
                if (result.status === 'updated' && mutation.content?.t === 'plain') catalog = mutation.content.v;
                response.end(JSON.stringify(McpServerCatalogRowMutationResponseV1Schema.parse(result)));
            })().catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); });
        });
        const sockets = new Server(http);
        const compatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        ).evaluation;
        sockets.on('connection', socket => {
            socket.data = {
                clientType: socket.handshake.query.publisher === '1' ? 'session-scoped' : 'user-scoped',
                sessionId: row.id,
                ...(socket.handshake.query.publisher === '1' ? { sessionScopedBinding: binding.binding } : {}),
                authAuthority: 'present_user',
                authTokenAuthenticationEvidence: [],
                accountStoredContentCompatibility: compatibility,
            };
            registerSocketRpcHandlers({ userId: account.id, socket, io: sockets });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
        const url = `http://127.0.0.1:${address.port}`;
        const publisher = io(url, { autoConnect: false, reconnection: false, query: { publisher: '1' } });
        const caller = io(url, { autoConnect: false, reconnection: false });
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        publisher.on(SOCKET_RPC_EVENTS.REQUEST, (request: RpcRequest, acknowledge: (result: unknown) => void) => {
            void manager.handleRequest(request).then(acknowledge);
        });
        async function connect(socket: ReturnType<typeof io>) {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
                socket.connect();
            });
        }
        try {
            if (isNative) {
                await Promise.race([permissionPublished.promise, pending.then(result => {
                    throw new Error(`Native permission settled before publication: ${JSON.stringify(result)}`);
                })]);
                expect(Object.keys(state.requests ?? {})).toHaveLength(1);
                requestId = Object.keys(state.requests!)[0]!;
                expect(state.requests![requestId]).toMatchObject({ source: 'native_tool_approval_once', turnId });
            }
            await vi.waitFor(() => expect(state.requests?.[requestId]?.turnId).toBe(turnId));
            const persisted = await db.session.findUniqueOrThrow({ where: { id: row.id }, select: { agentState: true } });
            const projection = createReducer();
            const persistedState = AgentStateSchema.parse(JSON.parse(persisted.agentState!));
            expect(persistedState.requests?.[requestId]).toMatchObject({ tool: toolName, turnId });
            const { messages } = reducer(projection, [], persistedState);
            expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({
                kind: 'tool-call', tool: expect.objectContaining({ id: requestId,
                    permission: expect.objectContaining({ status: 'pending', turnId }),
                }),
            })]));
            const projectedMessage = messages.find(message => message.kind === 'tool-call');
            const permission = projectedMessage?.kind === 'tool-call' ? projectedMessage.tool.permission : null;
            if (!permission) throw new Error('Pending permission was not projected');
            // The list/summary can omit AgentState while the transcript keeps
            // its permission. Do not invent custody from the Session latest turn.
            expect(permission.turnId).toBe(turnId);
            await connect(publisher);
            manager.onSocketConnect(publisher);
            await expect(manager.waitForRegisteredHandlers(['session.permission.respond'], { timeoutMs: 5_000 })).resolves.toEqual({ status: 'ready' });
            await connect(caller);
            const serverId = await homes.addHome({ name: 'Permission approval Home', serverUrl: url, accountId: account.id });
            homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
            const token = homes.findByServerUrl(url)?.token;
            if (!token) throw new Error('Missing synthetic Home Account credential');
            const rpcReplies: unknown[] = [];
            const rpcCompletions: Promise<unknown>[] = [];
            const emittedMethods: string[] = [];
            const emittedCarriers: ReturnType<typeof SessionPermissionRespondRpcParamsV1Schema.parse>[] = [];
            connection = await restoreServerAccountForTest({ serverUrl: url, credentials: { token }, request: homes.request,
                configureSocket: socket => {
                    vi.mocked(socket.connect).mockImplementation(() => {
                        socket.connected = true;
                        for (const listener of socket.listeners('connect')) listener();
                        return socket;
                    });
                    socket.timeout = () => socket;
                    socket.emitWithAck = async (event, ...args) => {
                        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                        const wire: unknown = args[0];
                        if (!wire || typeof wire !== 'object' || !('params' in wire) || !('method' in wire)
                            || typeof wire.method !== 'string') throw new Error('Missing production RPC carrier');
                        const carrier = SessionPermissionRespondRpcParamsV1Schema.parse(wire.params);
                        emittedCarriers.push(carrier);
                        emittedMethods.push(wire.method);
                        const completion = caller.timeout(5_000).emitWithAck(event, ...args).then(response => {
                            rpcReplies.push(response);
                            return response;
                        });
                        rpcCompletions.push(completion);
                        return await completion;
                    };
                },
            });
            installHomeGovernanceBoundaries(homes);
            const requestsBeforeArrival = homes.requests.length;
            const uiSession = installSessionActionFixture({ homes, storage, serverId, session: { id: row.id,
                agentState: button === 'nativeBashPlugin' ? AgentStateSchema.parse(JSON.parse(persisted.agentState!)) : null,
                encryptionMode: 'plain', metadata: { path: '/fixture', host: 'fixture', machineId: machine.id, flavor: 'claude' } } });
            if (button === 'nativeBashPlugin') {
                storage.getState().applyMessages(row.id, []);
                storage.getState().applySessions([{ ...uiSession, agentState: null }]);
            }
            let actionSessionId = row.id;
            if (button === 'misboundAction') {
                const other = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
                actionSessionId = other.id;
                installSessionActionFixture({ homes, storage, serverId, session: { id: other.id, encryptionMode: 'plain' } });
            }
            const actions = createAppSessionTranscriptActions(actionSessionId, serverId);
            if (isMcp) {
                for (const method of ['GET', 'POST']) homes.answer(serverId, `${method} /v1/account/entity-rows/mcp`, {
                    select: async input => {
                        const response = await fetch(`${url}/v1/account/entity-rows/mcp`, { method,
                            headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
                        return { status: response.status, body: await response.json() };
                    },
                });
                const identity = permission.mcpTool;
                if (!identity) throw new Error('Real permission producer omitted MCP identity');
                let answerFailure: string | undefined;
                const hook = await renderHook(() => useMcpAlwaysAllow({ requestId, turnId, identity, scope: { serverId, accountId: account.id },
                    canWriteCatalog: true, answerForSession: async () => {
                        try {
                            await answerSessionPermission({ requestId, turnId, toolName,
                                answer: 'allowForSession', policy: { protocol: 'standard', usePermissionUpdates: false }, respondToPermission: actions.respondToPermission });
                        } catch (error) { answerFailure = String(error); throw error; }
                    } }));
                await vi.waitFor(() => expect(hook.getCurrent().available).toBe(true));
                let save!: Promise<void>;
                let phase: 'catalog' | 'settled' = 'settled';
                await act(async () => {
                    save = hook.getCurrent().allow();
                    phase = await Promise.race([catalogSaveStarted.promise.then(() => 'catalog' as const), save.then(() => 'settled' as const)]);
                });
                expect(phase, JSON.stringify({ state: hook.getCurrent(), answerFailure, emittedMethods, rpcReplies,
                    requests: homes.requests.map(({ path, input }) => ({ path, input })) })).toBe('catalog');
                expect(hook.getCurrent().status).toBe('saving');
                await expect(pending).resolves.toMatchObject({ decision: 'approved' });
                const before = await readMcpServerCatalogRowInTx(db, { accountId: account.id });
                expect(before).toMatchObject({ revision: 0, content: { v: { servers: [{ tools: { overrides: {} } }] } } });
                await act(async () => { releaseCatalogSave.resolve(); await save; });
                expect(hook.getCurrent().status).toBe('save_failed');
                failCatalogSave = false;
                await act(async () => { await hook.getCurrent().retrySave(); });
                expect(hook.getCurrent().status).toBe('saved');
                expect(emittedMethods).toEqual([`${row.id}:session.permission.respond`]);
                expect(await readMcpServerCatalogRowInTx(db, { accountId: account.id })).toMatchObject({ revision: 1,
                    content: { v: { servers: [{ tools: { default: 'allow_read_only', overrides: { delete_file: 'allow' } } }] } } });
                const receipt = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: identity.item.serverId },
                    { serverId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
                expect(receipt.ok).toBe(true);
                if (!receipt.ok) throw new Error(receipt.error);
                expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result)).toMatchObject({
                    settings: { default: 'allow_read_only', tools: { delete_file: 'allow' } }, tools: [{ name: 'delete_file', setting: 'allow', source: 'tool' }] });
                // A new permission owner proves persistence, rather than merely the first handler's session grant.
                const freshSession = { ...session, sessionId: `fresh-${row.id}`,
                    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: `fresh-${row.id}`, encryptionMode: 'plain', logger: () => {} }),
                    getAgentStateSnapshot: () => ({ requests: {}, completedRequests: {} }) };
                const fresh = new ProviderEnforcedPermissionHandler(freshSession as unknown as ApiSessionClient, { logPrefix: '[Persisted MCP seam]',
                    getMcpToolContext: () => ({ catalog: { status: 'ready', authority: 'active', revision: 2, diagnostics: [], catalog },
                        mcpServerIdentities: { github: { serverId: identity.item.serverId, serverTitle: 'GitHub' } } }) });
                try { expect(fresh.getImmediateDecision('next-call', toolName, {})).toMatchObject({ decision: 'approved' }); }
                finally { await fresh.reset(); }
                await hook.unmount();
                return;
            }
            if (button === 'nativeReusableGrantRefusal') {
                // Real Action producer -> exact strict native consumer. An
                // unsupported reusable grant must leave the request pending.
                expect(state.requests?.[requestId])
                    .toMatchObject({ source: 'native_tool_approval_once', turnId });
                expect(nativeApplications).toEqual([]);
                await expect(actions.respondToPermission({ id: requestId, turnId, approved: true, mode: 'acceptEdits',
                    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
                })).rejects.toMatchObject({ code: 'permission_response_invalid' });
                expect(rpcReplies.at(-1)).toMatchObject({ ok: true, result: { ok: false, errorCode: 'permission_response_invalid' } });
                expect(state.requests?.[requestId])
                    .toMatchObject({ source: 'native_tool_approval_once', turnId });
                expect(nativeApplications).toEqual([]);
                expect(state.completedRequests?.[requestId]).toBeUndefined();
                return;
            }
            const source = createTestSessionTranscriptSource({ sessionId: row.id, serverId, agentState: null,
                interaction: { canApprovePermissions: true, canSendMessages: true },
                actions,
            });
            const pendingRequest = listPendingPermissionRequests({ sessionId: row.id, active: true, agentState: null }, messages)
                .find(request => request.id === requestId);
            if (!pendingRequest) throw new Error('Real projected request was not available to the prompt card');
            const screen = await renderWithSessionTranscriptSource(React.createElement(PermissionPromptCard, {
                sessionId: row.id, request: pendingRequest, location: null, metadata: uiSession.metadata,
                canApprovePermissions: true,
            }), source);
            if (isNative) {
                expect(screen.findHostByTestId('permission-footer.allow')).toBeNull();
                expect(screen.findHostByTestId('permission-footer.allow-all-edits')).toBeNull();
            }
            expect(emittedMethods).toEqual([]);
            if (button === 'nativeBashPlugin') {
                const lifetime = captureActiveServerAccountScopeLifetime();
                if (!lifetime) throw new Error('Missing restored plugin Account lifetime');
                const controller = createBoundPluginSurfaceController({ facts: {
                    pluginId: 'acme.triage', contributionId: 'desk', surfaceId: 'approval-seam', placement: 'appSurface',
                    platform: 'web', channel: 'internal', accountLifetime: lifetime,
                    interactionEnabled: true, daemonInteractionEnabled: false,
                } });
                const adapter = createCanonicalPluginReactNativeHostApiAdapter({
                    surface: createPluginSurfaceContextFixture({ target: { kind: 'app' } }),
                    requestSurface: controller.surfaceContext, requestIdPrefix: 'native-bash',
                    handleRequest: controller.hostApi.handleRequest, installedMethods: controller.hostApi.installedMethods,
                });
                try {
                    const read = await adapter.api.readSession(row.id);
                    expect(read?.pendingPermissions).toEqual([expect.objectContaining({ requestId, toolName: 'Bash',
                        answers: [], nativeChoices: permission.nativeChoices })]);
                    const offered = read?.pendingPermissions?.[0]?.nativeChoices;
                    const allowOnce = offered?.choices.find(choice => choice.scope === 'once' && choice.decision === 'approved');
                    if (!offered || !allowOnce) throw new Error('Plugin Session read omitted the native allow-once choice');
                    await expect(adapter.api.respondToSessionPermission({ sessionId: row.id, requestId, answer: 'allowForSession' }))
                        .resolves.toEqual({ status: 'refused', reason: 'answerUnavailable' });
                    expect(emittedMethods).toEqual([]);
                    await expect(adapter.api.respondToSessionPermission({ sessionId: row.id, requestId,
                        nativeChoice: { requirementId: offered.requirementId, choiceId: allowOnce.id } }))
                        .resolves.toEqual({ status: 'answered' });
                } finally { adapter.dispose(); controller.dispose(); }
            } else if (button === 'acceptEdits') {
                await screen.pressByTestIdAsync('permission-footer.allow-all-edits');
            } else if (isNative) {
                const allowOnce = permission.nativeChoices?.choices.find(choice => choice.scope === 'once' && choice.decision === 'approved');
                if (!allowOnce) throw new Error('The native producer omitted its allow-once choice');
                await screen.pressByTestIdAsync(`permission-footer.choice.${allowOnce.id}`);
            } else {
                await screen.pressByTestIdAsync('permission-footer.allow');
            }
            // Footer presses issue their Action without awaiting its RPC. Let
            // the real acknowledgement and its UI result commit before reading.
            await act(async () => { await Promise.all(rpcCompletions); });
            if (button === 'misboundAction') {
                // The same footer and real executor are deliberately bound to
                // another admitted Session, which has no responding publisher.
                expect(emittedMethods).toEqual([`${actionSessionId}:session.permission.respond`]);
                expect(rpcReplies.at(-1)).toMatchObject({ ok: false });
                // The existing transport classifies this unreserved relay
                // refusal as unconfirmed; keep its error visible and prevent a
                // blind second answer while the actual request remains pending.
                await vi.waitFor(() => expect(screen.findHostByTestId('permission-footer.answer-unconfirmed')).not.toBeNull());
                expect(screen.findHostByTestId('permission-footer.allow')?.props.accessibilityState).toMatchObject({ disabled: true });
                expect(state.requests?.[requestId]).toMatchObject({ turnId });
                expect(state.completedRequests?.[requestId]).toBeUndefined();
                return;
            }
            await expect(pending).resolves.toMatchObject(isNative
                ? { behavior: 'allow', updatedInput: input } : { decision: 'approved' });
            expect(emittedMethods.at(-1)).toBe(`${row.id}:session.permission.respond`);
            expect(['ios', 'android', 'web']).toContain(Platform.OS);
            expect(emittedCarriers.at(-1)).toMatchObject({ id: requestId, turnId, answeringClientCategory: Platform.OS });
            if (button === 'acceptEdits') expect(emittedCarriers.at(-1)?.mode).toBe('acceptEdits');
            expect(rpcReplies.at(-1)).toMatchObject({ ok: true, result: null });
            expect(screen.findHostByTestId('permission-footer.action-error')).toBeNull();
            if (isNative) {
                expect(emittedMethods).toEqual([`${row.id}:session.permission.respond`]);
                expect(nativeApplications).toEqual([expect.objectContaining({ behavior: 'allow', updatedInput: input })]);
                expect(homes.requests.slice(requestsBeforeArrival).filter(request => request.method === 'GET'
                    && /^\/v\d+\/account(?:\/|$)/.test(request.path))).toEqual([]);
            }
            const completed = await db.session.findUniqueOrThrow({ where: { id: row.id }, select: { agentState: true } });
            expect(JSON.parse(completed.agentState!).completedRequests[requestId]).toMatchObject({
                status: 'approved', turnId, answeringClientCategory: Platform.OS,
                permissionDecisionActorV1: { kind: 'accountUser', accountId: account.id },
                ...(button === 'acceptEdits' ? {
                    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
                } : {}),
            });
        } finally {
            releaseCatalogSave.resolve();
            await connection?.dispose();
            await handler.reset();
            manager.onSocketDisconnect();
            publisher.disconnect();
            caller.disconnect();
            await new Promise<void>(resolve => sockets.close(() => resolve()));
        }
    });
});
