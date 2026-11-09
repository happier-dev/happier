import fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { SessionLookupByTagsResponseV2Schema, V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { configuration } from '@/configuration';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { resolveProcessOwnerRequester } from '@/daemon/processes/ownership/resolveProcessOwnerRequester';
import { createProcessActionExecutor } from '@/daemon/processes/actions/processActionExecutor';
import { processRef } from '@/daemon/processes/view/processRef';
import type { ProcessCensusRow } from '@/processes/census/processCensus';
import type { HappierProcessRoot } from '@/daemon/processes/ownership/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';

afterEach(() => vi.restoreAllMocks());

it.each(['attached', 'attached_failure', 'disconnected'] as const)('settles %s live-only configuration approval through the real Artifact store and exact-daemon replay', async scenario => {
    const app = fastify();
    const endpoint = 'http://live-input-approval.test';
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const serverId = configuration.activeServerId;
    const homeId = 'srv_live_input';
    const machineId = 'configuration-machine';
    const accountId = 'configuration-owner';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const features = registerAccountHomeHttp(app, { accountId, serverId: homeId });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    let createdArtifactId = '';
    app.addHook('preHandler', async request => {
        if (request.method === 'POST' && request.url === '/v1/artifacts' && request.body
            && typeof request.body === 'object' && 'id' in request.body && typeof request.body.id === 'string') {
            createdArtifactId = request.body.id;
        }
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    const policy = { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {
        'connectedServices.configuration.replace': { approvalRequiredSurfaces: ['cli'] },
    } }), getAccountSettings: () => ({}) };
    const cancellation = new AbortController();
    let effects = 0;
    const { executor: daemon } = createCliActionExecutorHarness({ token: credentials.token, credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverIdentityId: homeId,
        serverHttpBaseUrl: endpoint, actionsSettingsProvider: policy }, {
        isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
            machineId, serverId, serverApiUrl: endpoint }),
        connectedServiceAction: async ({ input }) => {
            const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
            expect(getActionSpec('connectedServices.configuration.replace').inputSchema.safeParse(input).success).toBe(true);
            effects += 1;
            if (scenario === 'attached_failure') return { ok: false,
                errorCode: 'connected_account_configuration_target_unavailable', error: 'connected_account_configuration_target_unavailable' };
            return { applied: true, revision: 'configuration-1' };
        },
    });
    const handlers = new Map<string, RpcHandler>();
    registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => handlers.set(method, handler) }, actionExecutor: daemon });
    // Only the Machine transport is replaced; the real replay handler, Action
    // executor, Artifact writer/transition CAS and coordinator run beneath it.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        const handler = handlers.get(request.method);
        if (!handler) throw new Error('Unexpected Machine RPC');
        return await handler(request.request, { signal: new AbortController().signal, callerAuthority: 'present_user' });
    });
    const caller = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        externalActionClient: true, serverId, serverIdentityId: homeId, serverApiUrl: endpoint, actionsSettingsProvider: policy });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId, serverIdentityId: homeId,
        runtimeAccountId: accountId, defaultSessionMachineId: machineId, actionRequestId: 'live-input-request' };
    const pending = runWithServerHttpBaseUrl(endpoint, () => daemon.execute('connectedServices.configuration.replace', {
        machineId, target: { kind: 'attempt', attemptId: 'attempt' }, expectedRevision: null, values: {}, secretValues: {},
    }, { ...context, signal: cancellation.signal }));
    try {
        let artifactId = '';
        await vi.waitFor(() => {
            expect(createdArtifactId.length).toBeGreaterThan(0);
            artifactId = createdArtifactId;
            expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(1);
        });
        if (scenario === 'disconnected') { cancellation.abort(); await pending; }
        const result = await caller.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
            ...context, actionRequestId: 'decide-lost-input',
        });
        if (scenario === 'attached') {
            expect(result.ok).toBe(true);
            expect(await pending).toEqual({ ok: true, result: { applied: true, revision: 'configuration-1' } });
        } else if (scenario === 'attached_failure') {
            expect(result.ok).toBe(true);
            expect(await pending).toMatchObject({ ok: false, errorCode: 'connected_account_configuration_target_unavailable' });
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'approval_stale', details: { reason: 'live_invocation_unavailable' } });
        }
        const content = decodePlainArtifactStoredContent(artifacts.read(artifactId)!.body);
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Missing approval');
        const request = ApprovalRequestV2Schema.parse(JSON.parse(content.body));
        expect(request).toMatchObject(scenario === 'attached'
            ? { status: 'executed', execution: { ok: true } }
            : scenario === 'attached_failure' ? { status: 'failed', execution: { ok: false, effectAttempted: true,
                errorCode: 'connected_account_configuration_target_unavailable' } }
            : { status: 'failed', execution: { ok: false, effectAttempted: false, errorCode: 'approval_stale' } });
        expect(effects).toBe(scenario === 'disconnected' ? 0 : 1);
    } finally { cancellation.abort(); await pending; restore(); await app.close(); }
});

it.each(['policy', 'explicit', 'cli'] as const)('replays a %s native link approval on its Machine without resolving cli-global as a Session', async mode => {
    const app = fastify();
    const endpoint = 'http://native-approval.test';
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const serverId = configuration.activeServerId;
    const homeId = 'srv_native_approval';
    const machineId = 'native-machine';
    const accountId = 'native-owner';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const features = registerAccountHomeHttp(app, { accountId, serverId: homeId });
    // A mistaken contextual-Session lookup sees a valid empty inventory, as on
    // the real Home, rather than failing on a missing HTTP fixture route.
    app.post('/v2/sessions/lookup-by-tags', async () => SessionLookupByTagsResponseV2Schema.parse({ sessions: [] }));
    const emptySessions = V2SessionListResponseSchema.parse({ sessions: [], hasNext: false, nextCursor: null });
    app.get('/v2/sessions', async () => emptySessions);
    app.get('/v2/sessions/archived', async () => emptySessions);
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    const effects: unknown[] = [];
    // HTTP storage/features and the final Machine RPC are system boundaries.
    // MCP, catalog, approval construction/claim/currentness and replay stay real.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        effects.push(request.request);
        return { ok: true, sessionId: 'linked-native-session', created: true };
    });
    const { mcp } = runWithServerHttpBaseUrl(endpoint, () => createExternalMcpServer({ credentials,
        machineId, daemonControlTarget: null,
        serverFeaturesSnapshot: { status: 'ready', provenance: 'authenticated', features } }));
    const client = new Client({ name: 'native-approval', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const input = { machineId, agentId: 'claude', remoteSessionId: 'native-fixture',
        source: { kind: 'claudeConfig', projectId: '-tmp' } };
    const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId,
        serverId, serverApiUrl: endpoint });
    const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverIdentityId: homeId,
        serverHttpBaseUrl: endpoint }, { isApprovalExecutionOriginCurrent: currentness });
    try {
        const response = mode === 'cli' ? null : CallToolResultSchema.parse(await client.callTool({ name: mode === 'policy' ? 'sessions_external_link_ensure' : 'approval_request_create',
            arguments: mode === 'policy' ? input : { actionId: 'sessions.external.link.ensure', actionArgs: input,
                summary: 'Link native fixture', createdBy: { surface: 'mcp' } } }));
        const content = response?.content.find(item => item.type === 'text');
        const cli = mode === 'cli' ? await runWithServerHttpBaseUrl(endpoint, () => executor.execute('sessions.external.link.ensure', input,
            { surface: 'cli', authority: 'present_user', defaultSessionId: 'cli-global', defaultSessionMachineId: machineId,
                serverId, serverIdentityId: homeId, actionRequestId: 'cli-native-link' })) : null;
        const result = cli ? cli.ok ? cli.result : cli : JSON.parse(content?.type === 'text' ? content.text : '{}');
        expect(result).toMatchObject({ artifactId: expect.any(String) });
        expect(effects).toEqual([]);
        const readRequest = () => {
            const body = decodePlainArtifactStoredContent(artifacts.read(result.artifactId)!.body);
            if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing approval body');
            return ApprovalRequestV2Schema.parse(JSON.parse(body.body));
        };
        expect(readRequest()).toMatchObject({ status: 'open', actionArgs: input,
            executionOriginV1: { machineId, sessionId: 'cli-global', surface: mode === 'cli' ? 'cli' : 'mcp' } });
        const decided = await runWithServerHttpBaseUrl(endpoint, () => executor.execute('approval.request.decide',
            { artifactId: result.artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user',
                serverId, serverIdentityId: homeId, runtimeAccountId: accountId }));
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        expect(effects).toEqual([input]);
        expect(readRequest().status).toBe('executed');
    } finally {
        await client.close(); await mcp.close(); restore(); await app.close();
    }
});

it.each((['bob', 'alice'] as const).flatMap(accountId => (['account', 'terminal'] as const).map(authenticationKind => ({ accountId, authenticationKind }))))(
    'refuses unavailable $accountId $authenticationKind requester custody without borrowing a custodian Artifact reader', async ({ accountId, authenticationKind }) => {
    const app = fastify();
    const endpoint = `http://${accountId}-${authenticationKind}-process-approval.test`;
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const serverId = configuration.activeServerId;
    const homeId = 'srv_process_approval';
    const machineId = 'alice-machine';
    const installationId = 'alice-installation';
    const credentialsFor = (id: string) => ({ token: `header.${Buffer.from(JSON.stringify({ sub: id, tokenEpoch: 7,
        provenance: { v: 1, kind: authenticationKind, authority: authenticationKind === 'account' ? 'present_user' : 'account_automation' } })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const });
    const credentials = credentialsFor(accountId);
    const alice = credentialsFor('alice');
    const features = registerAccountHomeHttp(app, { accountId, serverId: homeId });
    const artifactReaders: string[] = [];
    // HTTP authentication/storage is the boundary. An A reader cannot see B's
    // approval; all Artifact construction, CAS, admission and replay stay real.
    app.addHook('preHandler', async (request, reply) => {
        if (!request.url.startsWith('/v1/artifacts')) return;
        const actor = readAccountIdFromToken(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
        artifactReaders.push(actor ?? 'unknown');
        if (actor !== accountId) return reply.code(404).send({ error: 'not_found' });
    });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    const machine = { id: machineId, kind: 'persistent', active: true, installationId,
        revokedAt: null, replacedByMachineId: null,
        access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } };
    app.get('/v1/machines', async () => [machine]);
    app.get('/v1/machines/:id', async () => ({ machine }));
    app.get('/v1/account/security', async () => ({ v: 1, encryptionMode: 'plain', 
        nativeEmail: null, password: { status: 'not_enrolled', revision: null } }));

    const scope = '123456789abc';
    const owner = { kind: 'service', serviceId: 'lsp:owned', pluginId: 'example.language' } as const;
    const row = (pid: number): ProcessCensusRow => ({ pid, ppid: 1, pgid: pid,
        start: { startTimeMs: pid * 10, native: `darwin-proc:${pid}:0:${pid}` },
        principal: { kind: 'uid', value: '501' }, name: 'language-server', memory: { bytes: 4096, kind: 'rss' }, cpuTimeUs: 0,
        argv: ['native-language-server'] });
    const rows = new Map([[process.pid, row(process.pid)], [30, row(30)]]);
    const roots: HappierProcessRoot[] = [{ owner, pid: 30, start: rows.get(30)!.start, live: true, ownerCreatedAtMs: 0,
        requesterWorkAttributionV1: { serverId, machineId, installationId, accountId: 'alice' } }];
    const censusDependencies = { platform: 'darwin' as const, selfPid: process.pid, helperExecutablePath: '/fixture/helper',
        now: () => 100_000, async execFile() { return { stdout: JSON.stringify({ v: 1, capturedAtMs: 100_000,
            logicalCpus: 4, rows: [...rows.values()] }) }; } };
    const ownership = createProcessOwnershipRuntime({ platform: 'darwin', selfPid: process.pid, daemonScopeKey: scope,
        listRoots: () => roots, censusDependencies });
    const stopped: number[] = [];
    const native = createProcessActionExecutor({ ownership, leftBehind: { confirmed: () => [] },
        platform: 'darwin', selfPid: process.pid, allProcessesVisible: () => false,
        systemBoundary: { platform: 'darwin', censusDependencies,
            kill(pid) { stopped.push(pid); rows.delete(pid); }, async wait() {} },
        requesterForOwner: (value, currentRoots) => resolveProcessOwnerRequester(value, currentRoots,
            { target: { serverId, machineId, installationId }, custodianAccountId: 'alice' }),
        stopOwner: async root => { stopped.push(root.pid!); rows.delete(root.pid!); return true; },
    });
    const input = { serverId, machineId, targets: [{ ref: processRef(30, rows.get(30)!.start), expect: { level: 'proven', owner } }] };
    const policy = { getActionsSettings: () => normalizeActionsSettingsV1({}), getAccountSettings: () => ({}) };
    const daemonExecutor = (tokenCredentials: typeof credentials) => createCliActionExecutorHarness({
        token: tokenCredentials.token, credentials: tokenCredentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
        serverId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, actionsSettingsProvider: policy,
    }, { isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
        credentials: tokenCredentials, machineId, serverId, serverApiUrl: endpoint }) }).executor;
    const aliceExecutor = daemonExecutor(alice);
    const handlers = new Map<string, RpcHandler>();
    registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => handlers.set(method, handler) }, actionExecutor: aliceExecutor });
    const admitted = (actorAccountId: string): RpcHandlerContext => ({
        signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId, custodianAccountId: 'alice',
            machineId, installationId, role: actorAccountId === 'alice' ? 'manage' : 'use', encryptionMode: 'plain' }),
        verifyMachineAdmissionCurrent: async () => true,
    });
    let withholdReplay = accountId === 'alice';
    let preparedReplayContext: RpcHandlerContext | undefined;
    // The Machine RPC wire and native census/lifecycle are genuine boundaries;
    // request identity, Account custody, process ownership and Stop stay real.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        if (request.method === RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED) {
            if (withholdReplay) return { ok: false, effectAttempted: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
            return handlers.get(request.method)!(request.request, preparedReplayContext ?? admitted(readAccountIdFromToken(request.credentials.token)!));
        }
        expect(request.method).toBe(RPC_METHODS.MACHINES_PROCESSES_STOP);
        const { MachineProcessesStopInputV1Schema } = await import('@happier-dev/protocol/machines/processes/machineProcessesV1');
        const actor = readAccountIdFromToken(request.credentials.token)!;
        return native.executeStop(MachineProcessesStopInputV1Schema.parse(request.request),
            { accountId: actor, isCustodian: actor === 'alice' });
    });
    const caller = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        externalActionClient: true,
        serverId, serverIdentityId: homeId, serverApiUrl: endpoint, actionsSettingsProvider: policy,
        onRequesterSessionCredentialDisclosure: async () => true });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId, serverIdentityId: homeId,
        runtimeAccountId: accountId, defaultSessionMachineId: machineId, actionRequestId: 'original-process-stop' };
    try {
        const created = await daemonExecutor(credentials).execute('machines.processes.stop', input, context);
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
        if (!created.ok || !created.result || typeof created.result !== 'object' || !('artifactId' in created.result)) throw new Error('Missing Artifact');
        let artifactId = String(created.result.artifactId);
        const read = () => {
            const body = decodePlainArtifactStoredContent(artifacts.read(artifactId)!.body);
            if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing body');
            return ApprovalRequestV2Schema.parse(JSON.parse(body.body));
        };
        let decided = await caller.execute('approval.request.decide', { artifactId, decision: 'approve' },
            { ...context, actionRequestId: 'decide-process-stop' });
        const errorCode = accountId === 'bob' ? 'requester_account_material_unavailable' : 'target_unavailable';
        expect(decided).toMatchObject({ ok: true, result: { status: 'failed', execution: {
            ok: false, effectAttempted: false, errorCode,
        } } });
        expect(read()).toMatchObject({ status: 'failed', execution: { ok: false, effectAttempted: false, errorCode } });
        expect(await caller.execute('approval.request.decide', { artifactId, decision: 'approve' }, context)).toEqual(decided);
        expect(stopped).toEqual([]);
        expect(rows.has(30)).toBe(true);
        const createFreshApproval = async () => {
            const fresh = await daemonExecutor(credentials).execute('machines.processes.stop', input,
                { ...context, actionRequestId: 'fresh-process-stop' });
            if (!fresh.ok || !fresh.result || typeof fresh.result !== 'object' || !('artifactId' in fresh.result)) throw new Error('Missing fresh Artifact');
            artifactId = String(fresh.result.artifactId);
        };
        if (accountId === 'bob') {
            expect(artifactReaders.every(actor => actor === 'bob')).toBe(true);
            expect(stopped).toEqual([]);
            expect(rows.has(30)).toBe(true);
            // Signed terminal continuations retain their automation floor and
            // cannot produce this present-user private Account carrier.
            if (authenticationKind === 'terminal') return;
            await createFreshApproval();
            // Prepared private custody is a host-only ingress result, not a
            // public request field. Consume its real B reader/claim and native
            // owner check rather than silently falling back to A's executor.
            artifactReaders.length = 0;
            const prepared = { ...admitted('bob'), callerInputAuthorization: {
                v: 1 as const, token: 'verified-requester-root', binding: {
                    accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account' as const, tokenEpoch: 7 },
                    accountEncryptionMode: 'plain' as const, serverIdentityId: homeId, machineId, installationId,
                    actionId: 'approval.request.decide' as const, requestId: 'decide-process-stop', requestEnvelopeDigest: 'a'.repeat(43),
                    target: { kind: 'machine' as const, machineId },
                }, requesterAccountExecutor: daemonExecutor(credentials),
            } } satisfies RpcHandlerContext;
            preparedReplayContext = prepared;
            const replayed = await caller.execute('approval.request.decide', { artifactId, decision: 'approve' }, context);
            expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true, result: { status: 'executed', execution: {
                ok: true, result: { status: 'refused', outcomes: [{ outcome: 'refused', reasonCode: 'access_denied' }] },
            } } });
            expect(read().status).toBe('executed');
            expect(artifactReaders.length).toBeGreaterThan(0);
            expect(artifactReaders.every(actor => actor === 'bob')).toBe(true);
            expect(await handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!({ artifactId }, prepared)).toEqual(replayed);
            expect(stopped).toEqual([]);
            expect(rows.has(30)).toBe(true);
            return;
        }
        const before = artifacts.read(artifactId);
        artifactReaders.length = 0;
        // Bob knows Alice's exact approved Artifact id. Trusted Home admission,
        // not input hints, must prevent borrowing Alice's private reader/claim.
        expect(await handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!({ artifactId }, admitted('bob')))
            .toMatchObject({ ok: false, effectAttempted: false, errorCode: 'requester_account_material_unavailable' });
        expect(artifactReaders).toEqual([]);
        expect(artifacts.read(artifactId)).toEqual(before);
        expect(stopped).toEqual([]);
        for (const rejected of [
            { ...admitted('alice'), verifyMachineAdmissionCurrent: undefined },
            { ...admitted('alice'), verifyMachineAdmissionCurrent: async () => false },
            { ...admitted('alice'), signal: AbortSignal.abort() },
        ]) {
            expect(await handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!({ artifactId }, rejected))
                .toMatchObject({ ok: false, effectAttempted: false, errorCode: 'requester_account_material_unavailable' });
            expect(artifactReaders).toEqual([]);
            expect(artifacts.read(artifactId)).toEqual(before);
            expect(stopped).toEqual([]);
        }
        withholdReplay = false;
        await createFreshApproval();
        decided = await caller.execute('approval.request.decide', { artifactId, decision: 'approve' }, context);
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true,
            result: { status: 'ended', outcomes: [{ outcome: 'ended' }] } } } });
        expect(read().status).toBe('executed');
        expect(read().decision?.kind).toBe('approve');
        expect(stopped).toEqual([30]);
        expect(rows.has(30)).toBe(false);
        expect(artifactReaders.every(actor => actor === accountId)).toBe(true);
        expect(await caller.execute('approval.request.decide', { artifactId, decision: 'approve' }, context)).toEqual(decided);
        expect(stopped).toEqual([30]);
    } finally { restore(); await app.close(); }
});
