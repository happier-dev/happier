import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { type AxiosAdapter } from 'axios';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema, SessionDraftReadResponseV2Schema,
    SESSION_DRAFT_V2_ROUTE_MUTATE, SESSION_DRAFT_V2_ROUTE_READ, type SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SESSION_DRAFT_ROUTE_MUTATE } from '@happier-dev/protocol/drafts/sessionDrafts';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { createSessionDraftRepository } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createClientActionReverseDispatcher } from '../../../../../cli/src/session/actions/clientActionReverseDispatch';
import { createCliActionExecutorFromCredentials } from '../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '../../../../../cli/src/settings/actionsSettingsProvider';
import { listCompiledActionCliCommands } from '../../../../../cli/src/cli/actions/compiledCommands';
import { runCompiledActionCliCommand } from '../../../../../cli/src/cli/actions/executeCommand';
import { captureConsoleJsonOutput } from '../../../../../cli/src/testkit/logger/captureOutput';
import { resolvePublishedMachineContentCodec } from '../../../../../cli/src/api/machine/machineDataEncryptionKey';
import { sessionUiActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { selectRpcTarget } from '../../../../../server/sources/app/api/socket/rpc/rpcTargetSelection';

vi.mock('socket.io-client', async (original) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { resetSessionDraftRepositoryForTests, getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const originalState = storage.getState();
const originalAxiosAdapter = axios.defaults.adapter;
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
const draftId = '00000000-0000-4000-8000-000000000073';
let record: SessionDraftRecordV2;
let mutations: unknown[];
let conflictOnDelete = false;
let loseDeleteResponse = false;
let busyOnDelete: string | null = null;
let relayRequests: string[];
let replayRpcRequests: string[];
let replaySocketBoundary: ReturnType<typeof installDisconnectedServerSocketBoundary> | undefined;

beforeEach(() => { mutations = []; relayRequests = []; replayRpcRequests = []; conflictOnDelete = false; loseDeleteResponse = false; busyOnDelete = null; resetSessionDraftRepositoryForTests(); });
afterEach(async () => {
    axios.defaults.adapter = originalAxiosAdapter;
    vi.unstubAllGlobals();
    await account?.dispose(); account = undefined;
    replaySocketBoundary?.dispose(); replaySocketBoundary = undefined;
    resetSessionDraftRepositoryForTests(); storage.setState(originalState, true);
    process.exitCode = 0;
});

async function setup(mode: 'plain' | 'e2ee', connected = true, synchronized = true, viewedSessionId?: string) {
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.drafts', synchronized)) throw new Error('Missing draft feature');
    features.capabilities.serverIdentity.serverIdentityId = 'srv_draft_delete';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-a', tokenEpoch: 7,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    account = await createSecretSettingsTestHarness({ mode, features, token, serverIdentityId: 'srv_draft_delete' });
    const owner = account;
    const { serverId, accountId } = owner.scope;
    const credentials = { token, encryption: mode === 'e2ee'
        ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } : null, credentialProvenance: 'stored_session' as const };
    const machine = createPlainMachineRowFixture({ id: 'fix73-machine', accountId });
    // A genuine legacy E2EE Machine has no per-Machine key envelope. Its owning
    // Account's recovery-secret codec reads both stored content and RPC frames.
    const machineKey = mode === 'plain' ? machine.dataEncryptionKey : null;
    const access = { ...machine.access!, resourceMode: mode };
    const machineCodec = resolvePublishedMachineContentCodec({ credentials, machineId: machine.id,
        expectedAccountMode: mode, publishedDataEncryptionKey: machineKey, access,
        machineKind: 'persistent', installationId: machine.installationId });
    const rpcContent: SocketRpcContent = machineCodec.mode === 'plain' ? { mode: 'plain' } : {
        mode: 'e2ee', cipher: { encryptRaw: async value => machineCodec.encodeRpc(value),
            decryptRaw: async value => machineCodec.decodeRpc(value) },
    };
    const machineRow = { ...machine, access, dataEncryptionKey: machineKey,
        metadata: machineCodec.encodeStored(createMachineFixture({ id: machine.id }).metadata) };
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const address = { kind: 'newSession' as const, draftId };
    const cipher = createSessionDraftCipher({ accountMode: mode,
        accountCryptoMaterial: mode === 'e2ee' ? resolveAccountScopedCryptoMaterialFromCredentials(owner.credentials) : null,
        getSessionContext: () => null, randomBytes: length => new Uint8Array(length).fill(3) });
    // A different app produced the persisted draft; the approving app has no replica or configured Sync runtime.
    const values = new Map<string, string>();
    const author = createSessionDraftRepository({ storage: { getString: key => values.get(key), set: (key, value) => { values.set(key, value); },
        delete: key => { values.delete(key); } }, scope: owner.scope, cipher, syncEnabled: false });
    author.writeNewSessionDraft({ scope: owner.scope, draftId, materializationIntent: 'userEdit', patch: { text: 'FIX73 owned draft' } });
    record = { address, revision: 1, createdAt: 1, updatedAt: 1,
        content: await cipher.seal(address, author.getSessionDraftSnapshot(owner.scope, address)!.document) };
    const originalRequest = owner.request.getMockImplementation()!;
    owner.request.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1) return Response.json({ tokens: [] });
        if (path === '/v1/machines' || path === '/v1/machines/fix73-machine') {
            return Response.json(path === '/v1/machines' ? [machineRow] : { machine: machineRow });
        }
        if (path === '/v1/actions/approval.request.decide') {
            relayRequests.push(path);
            throw new Error('An approved standalone CLI request must use its recorded daemon replay RPC');
        }
        if (path === SESSION_DRAFT_V2_ROUTE_READ) return Response.json(SessionDraftReadResponseV2Schema.parse({ status: record.content ? 'present' : 'deleted', record }));
        if (path === SESSION_DRAFT_V2_ROUTE_MUTATE || path === SESSION_DRAFT_ROUTE_MUTATE) {
            const body = SessionDraftMutateRequestV2Schema.parse(JSON.parse(String(init?.body)));
            mutations.push(body);
            if (busyOnDelete) return Response.json({ error: busyOnDelete }, { status: 503 });
            if (conflictOnDelete) record = { ...record, revision: record.revision + 1 };
            if (body.expectedRevision !== record.revision) return Response.json(SessionDraftMutateResponseV2Schema.parse({ status: 'conflict', current: record }));
            record = { ...record, revision: record.revision + 1, content: body.content };
            if (loseDeleteResponse) throw new TypeError('Delete response lost after commit');
            return Response.json(SessionDraftMutateResponseV2Schema.parse({ status: 'updated', record }));
        }
        return originalRequest(input, init);
    });
    // Axios is the CLI's network boundary; share the same stateful Home HTTP boundary as the app.
    const adapter: AxiosAdapter = async config => {
        const response = await owner.request(String(config.url), { method: config.method,
            headers: Object.fromEntries(Object.entries(config.headers.toJSON()).map(([key, value]) => [key, String(value)])),
            ...(config.data === undefined ? {} : { body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data) }) });
        return { config, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), data: await response.json() };
    };
    axios.defaults.adapter = adapter;
    vi.stubGlobal('fetch', owner.request);
    const receive = createUiClientActionReverseHandler({ serverId, accountId, isCurrent: () => true });
    const selectedMethods: string[] = [];
    let foreignEffects = 0;
    const reverse = createClientActionReverseDispatcher(() => ({ hasConnectedClientRpcHandler: () => connected,
        callConnectedClientRpc: async (method, payload, options) => {
            selectedMethods.push(method);
            // The Home server selects the receiver; with no connected client it answers typed absence.
            if (!connected) return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
            if (viewedSessionId) {
                // Socket membership/ACKs are the boundary; selection and the app's
                // actual Action receiver stay real, including the other client.
                const foreign = { id: 'a-settings-client', timeout: () => ({ emitWithAck: async () => {
                    foreignEffects++;
                    return { v: 1, execution: { ok: true, result: { status: 'noMountedSurface' } } };
                } }) };
                const viewed = { id: 'z-session-client', timeout: () => ({ emitWithAck: async () =>
                    receive(JSON.parse(JSON.stringify(payload)), { signal: new AbortController().signal }) }) };
                const targets = method === sessionUiActionClientRpcMethod(viewedSessionId) ? [viewed] : [foreign, viewed];
                const selection = selectRpcTarget({ targets, answeringClient: options.answeringClient });
                if (selection.type !== 'target') return { ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS' };
                options.onIssued();
                return { ok: true, result: await selection.target.timeout(0).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, payload) };
            }
            options.onIssued();
            return { ok: true, result: await receive(JSON.parse(JSON.stringify(payload)), { signal: new AbortController().signal }) };
        } }));
    const options = { credentials, serverId, serverIdentityId: 'srv_draft_delete', machineId: 'fix73-machine',
        serverApiUrl: new URL(owner.request.mock.calls[0]![0].toString()).origin,
        actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => owner.persistedSettings }) };
    const cli = createCliActionExecutorFromCredentials({ ...options, clientActionExecute: reverse });
    // The standalone CLI replays an already-approved Artifact at its recorded
    // daemon over exact-Machine RPC, not a second approval-decision HTTP relay.
    replaySocketBoundary = installDisconnectedServerSocketBoundary((socket, endpoint) => {
        expect(new URL(endpoint!).origin).toBe(options.serverApiUrl);
        configureConnectedServerSocketBoundary(socket);
        socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload) || !('params' in payload)
                || payload.method !== `fix73-machine:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`) {
                throw new Error('Unexpected standalone CLI replay RPC');
            }
            const decoded = await socketRpcCodec.decodeRequestParams(rpcContent, payload.params, payload.method);
            const input = decoded.params;
            if (!input || typeof input !== 'object' || !('artifactId' in input) || typeof input.artifactId !== 'string') {
                throw new Error('Missing approved Artifact identity');
            }
            replayRpcRequests.push(payload.method);
            const result = await cli.replayApprovedApprovalRequest({ artifactId: input.artifactId, callerAuthority: 'present_user' });
            return { ok: true, result: await socketRpcCodec.encodeResponse(rpcContent, result, decoded.callId) };
        });
    }, { serverUrl: options.serverApiUrl, token });
    const standaloneCli = createCliActionExecutorFromCredentials(options);
    const { actionsSettingsProvider: _reviewedPolicy, ...accountOptions } = options;
    const standaloneAccountCli = createCliActionExecutorFromCredentials(accountOptions);
    return { cli, standaloneCli, standaloneAccountCli, credentials, serverId, accountId, address, selectedMethods,
        readForeignEffects: () => foreignEffects };
}

describe('CLI approved draft delete through the executing app', () => {
    it.each([
        ['database_transaction_conflict_exhausted', 'approvals.transientFailure'],
        ['database_transaction_timeout', 'toolView.pending.unknownDescription'],
        ['database_connection_unavailable', 'toolView.pending.unknownDescription'],
    ] as const)('names a rejected draft tombstone (%s) and preserves the draft for retry', async (code, messageKey) => {
        const { serverId, address, accountId } = await setup('plain');
        const { deleteNewSessionDraft } = await import('@/components/sessions/drafts/deleteNewSessionDraft');
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => {});
        const { t } = await import('@/text');
        const executor = createDefaultActionExecutor();
        const execute = (actionId: 'session.draft.delete', input: Readonly<{ draftId: string }>) => executor.execute(actionId, input, { surface: 'ui', serverId });
        try {
            busyOnDelete = code;
            expect(await deleteNewSessionDraft({ execute, draftId })).toBe(false);
            expect(alert).toHaveBeenLastCalledWith(t('approvals.transientFailureTitle'), t(messageKey));
            expect(record.content).not.toBeNull();
            expect(getSessionDraftSnapshot({ serverId, accountId }, address)).not.toBeNull();
            busyOnDelete = null;
            expect(await deleteNewSessionDraft({ execute, draftId })).toBe(true);
            expect(record.content).toBeNull();
            expect(mutations).toHaveLength(2);
        } finally { alert.mockRestore(); }
    });
    it.each(['plain', 'e2ee'] as const)('replays an approved Session Find from a standalone %s operator CLI on the client viewing that Session', async mode => {
        const sessionId = 'viewed-session';
        const { cli, standaloneCli, serverId, accountId, selectedMethods, readForeignEffects } = await setup(mode, true, true, sessionId);
        const { createFindSurfaceRegistry } = await import('@/keyboard/findSurfaceRegistry');
        const { registerFindActionRuntime } = await import('@/keyboard/findActionRuntime');
        const { createFileViewerFindModel } = await import('@/components/workspaces/files/details/useFileViewerFind');
        const find = createFindSurfaceRegistry();
        const model = createFileViewerFindModel(() => ({ path: 'notes.md', mode: 'file', text: 'needle\nneedle' }));
        const releaseRuntime = registerFindActionRuntime(find);
        const releaseSurface = find.register({ surfaceId: 'file:notes', controller: model, open: model.open,
            containsFocus: () => true, isOpen: () => model.getSnapshot().open, isInputFocused: () => true });
        try {
            const proposed = await cli.execute('approval.request.create', { actionId: 'ui.find',
                actionArgs: { op: 'set', query: 'needle', target: 'file:notes' }, summary: 'Find in my Session',
                createdBy: { surface: 'agent', sessionId } }, {
                surface: 'agent', authority: 'account_automation', serverId, runtimeAccountId: accountId,
                defaultSessionId: sessionId, defaultSessionMachineId: 'fix73-machine',
                actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, actionRequestId: `find-${mode}`,
            });
            if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object'
                || !('artifactId' in proposed.result) || typeof proposed.result.artifactId !== 'string') {
                throw new Error(JSON.stringify(proposed));
            }
            const { artifactId } = proposed.result;
            expect(model.getSnapshot().open).toBe(false);
            const result = await standaloneCli.execute('approval.request.decide', { artifactId, decision: 'approve' },
                { surface: 'cli', authority: 'present_user' });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
                status: 'executed', execution: { ok: true, result: { status: 'results', current: 1, total: 2 } },
            } });
            expect(model.getSnapshot()).toMatchObject({ open: true, query: 'needle' });
            expect(selectedMethods).toEqual([sessionUiActionClientRpcMethod(sessionId)]);
            expect(replayRpcRequests).toEqual([`fix73-machine:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`]);
            expect(readForeignEffects()).toBe(0);
        } finally { releaseSurface(); releaseRuntime(); }
    });
    it.each(['plain', 'e2ee'] as const)('forwards a standalone %s CLI approval to its original daemon and executing app', async mode => {
        const { standaloneCli } = await setup(mode);
        const created = await standaloneCli.execute('session.draft.delete', { draftId },
            { surface: 'cli', authority: 'present_user', actionRequestId: 'fix73-standalone' });
        if (!created.ok) throw new Error(JSON.stringify(created));
        const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(created.result);
        const result = await standaloneCli.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'deleted' } } } });
        expect(record.content).toBeNull();
        expect(relayRequests).toEqual([]);
        expect(replayRpcRequests).toEqual([`fix73-machine:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`]);
    });
    it.each(['plain', 'e2ee'] as const)('deletes a cold %s draft and persists a successful approval receipt', async mode => {
        const { cli, credentials, serverId, accountId, address } = await setup(mode);
        expect(getSessionDraftSnapshot({ serverId, accountId }, address)).toBeNull();
        const command = listCompiledActionCliCommands().find(command => command.actionId === 'session.draft.delete')!;
        const output = captureConsoleJsonOutput();
        let artifactId: string;
        try {
            await runCompiledActionCliCommand({ command, argv: [...command.path, '--input-json', JSON.stringify({ draftId }), '--json'],
                deps: { readCredentialsFn: async () => credentials, createExecutorFn: () => cli } });
            const envelope = output.json<{ data: unknown }>();
            artifactId = ActionApprovalRequestCreatedResultSchema.parse(envelope.data).artifactId;
        } finally { output.restore(); }
        const result = await cli.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'deleted' } } } });
        expect(record.content).toBeNull();
        expect(getSessionDraftSnapshot({ serverId, accountId }, address)).toBeNull();
        const receipt = await createDefaultActionExecutor().execute('approval.request.get', { artifactId }, { surface: 'ui', serverId });
        expect(receipt).toMatchObject({ ok: true, result: { request: { status: 'executed', execution: { ok: true, result: { status: 'deleted' } } } } });
    });

    it('records an actionable failure for an approved draft delete with no connected app', async () => {
        const { standaloneCli } = await setup('plain', false);
        const created = await standaloneCli.execute('session.draft.delete', { draftId }, { surface: 'cli', authority: 'present_user', actionRequestId: 'fix73-no-client' });
        if (!created.ok) throw new Error(JSON.stringify(created));
        const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(created.result);
        const result = await standaloneCli.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user' });
        expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'unavailable' } } });
        expect(record.content).not.toBeNull();
        expect(mutations).toEqual([]);
        expect(relayRequests).toEqual([]);
        expect(replayRpcRequests).toEqual([`fix73-machine:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`]);
    });

    it('keeps an Account-placed Artifact delete independent of connected apps', async () => {
        const { standaloneAccountCli, serverId } = await setup('plain', false);
        const artifactId = '00000000-0000-4000-8000-000000000074';
        const document = await createDefaultActionExecutor().execute('artifact.create', { artifactId,
            header: { title: 'FIX73 neighboring delete' }, body: 'Owned disposable document' }, { surface: 'ui', serverId });
        if (!document.ok) throw new Error(JSON.stringify(document));
        const { revision } = ArtifactActionOutputSchemasV1['artifact.create'].parse(document.result);
        const created = await standaloneAccountCli.execute('artifact.delete', { artifactId, expectedRevision: revision },
            { surface: 'cli', authority: 'present_user', actionRequestId: 'fix73-artifact-delete' });
        if (!created.ok) throw new Error(JSON.stringify(created));
        const approval = ActionApprovalRequestCreatedResultSchema.parse(created.result);
        const decision = await standaloneAccountCli.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' },
            { surface: 'cli', authority: 'present_user' });
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        expect(account!.artifacts.list().some(artifact => artifact.id === artifactId)).toBe(false);
        expect(relayRequests).toEqual([]);
    });

    it('retains local-only draft deletion on a Home without draft synchronization', async () => {
        const { cli, serverId, accountId, address } = await setup('plain', true, false);
        const { configureSessionDraftRepository } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        configureSessionDraftRepository({ scope: { serverId, accountId }, syncEnabled: false });
        writeNewSessionDraft({ scope: { serverId, accountId }, draftId, materializationIntent: 'userEdit', patch: { text: 'Local only' } });
        const created = await cli.execute('session.draft.delete', { draftId },
            { surface: 'cli', authority: 'present_user', actionRequestId: 'fix73-local' });
        if (!created.ok) throw new Error(JSON.stringify(created));
        const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(created.result);
        expect(await cli.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user' }))
            .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'deleted' } } } });
        expect(getSessionDraftSnapshot({ serverId, accountId }, address)).toBeNull();
        expect(mutations).toEqual([]);
    });

    it('reports canonical absence without issuing another tombstone', async () => {
        const { cli } = await setup('plain');
        record = { ...record, content: null };
        const created = await cli.execute('session.draft.delete', { draftId },
            { surface: 'cli', authority: 'present_user', actionRequestId: 'fix73-absent' });
        if (!created.ok) throw new Error(JSON.stringify(created));
        const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(created.result);
        expect(await cli.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user' }))
            .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'missing' } } } });
        expect(mutations).toEqual([]);
    });

    it.each(['conflict', 'response_lost'] as const)('records a truthful %s failure rather than unavailable', async failure => {
        const { cli } = await setup('plain');
        const created = await cli.execute('session.draft.delete', { draftId }, { surface: 'cli', authority: 'present_user', actionRequestId: `fix73-${failure}` });
        if (!created.ok) throw new Error(JSON.stringify(created));
        const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(created.result);
        conflictOnDelete = failure === 'conflict';
        loseDeleteResponse = failure === 'response_lost';
        const result = await cli.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user' });
        expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false,
            errorCode: failure === 'conflict' ? 'session_draft_conflict' : 'outcome_uncertain' } } });
        expect(record.content === null).toBe(failure === 'response_lost');
    });

    it('refuses a reverse receiver bound to another Account before draft mutation', async () => {
        const { serverId } = await setup('plain');
        const receive = createUiClientActionReverseHandler({ serverId, accountId: 'wrong-account', isCurrent: () => true });
        const result = await receive({ v: 1, actionId: 'session.draft.delete', input: { draftId },
            context: { surface: 'cli', authority: 'present_user' } }, { signal: new AbortController().signal });
        expect(result).toMatchObject({ execution: { ok: false } });
        expect(record.content).not.toBeNull();
        expect(mutations).toEqual([]);
    });
});
