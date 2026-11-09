import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilitySocketAuthV1,
    type SessionPermissionRemoteRespondInputV1 } from '@happier-dev/protocol';
import { SessionPermissionRemotePendingListOutputV1Schema, SessionPermissionRemoteRespondOutputV1Schema,
    SessionUserActionRemoteAnswerOutputV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import { SessionPermissionMediationRecordStoredSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { SessionPermissionRemoteSettlementRecordV1Schema } from '@happier-dev/protocol/sessions/permissions/mediationRecordsV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { registerSocketRpcHandlers } from '../../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
import { createSessionMachineAccessKeyInTx } from '../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { resolveSessionScopedSocketBinding } from '../../../../server/sources/app/api/socket/sessionScopedBinding';
import { evaluateAccountStoredContentSocketCompatibility } from '../../../../server/sources/app/clientCompatibility/accountStoredContentCompatibility';
import { resolveCurrentSessionCapabilityBinding } from '@/session/presentation/currentSessionUiBindings';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDeferred } from '@/testkit/async/deferred';
import { createCliActionDeps } from './createCliActionDeps';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createSeparateProcessChannelsIngress } from './sessionPermissionRemote.channels.testkit';
import { readConversationPendingPermissions } from '../../../../../packages/plugins/channels/src/permissionMediation';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const childPath = fileURLToPath(new URL('./sessionPermissionRemote.composed.child.ts', import.meta.url));
const sourceRuntime = resolve(cliRoot, '../../packages/cli-common/registerSourceRuntime.mjs');
type ChildMessage = Readonly<{ kind: string; pid?: number; requestId?: string; result?: unknown; completed?: unknown;
    records?: readonly unknown[]; projection?: unknown }>;

/** One composed journey through the real Home relay/ACL and a child Session. */
export async function runSeparateProcessPermissionMediationJourney(): Promise<void> {
    const database = await createLightSqliteHarness({ tempDirPrefix: 'happier-mediation-process-', initAuth: false });
    let sockets: Server | undefined;
    let child: ChildProcess | undefined;
    let exited: Promise<void> | undefined;
    let command: Awaited<ReturnType<typeof createSeparateProcessChannelsIngress>> | undefined;
    const lifetime = new AbortController();
    try {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const collaborator = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const row = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionShare.create({ data: { sessionId: row.id, sharedByUserId: account.id,
            sharedWithUserId: collaborator.id, accessLevel: 'edit', canApprovePermissions: true } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        assert.equal((await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: account.id, sessionId: row.id,
            machineId: machine.id, data: 'fixture-access-key' }))).ok, true);
        const binding = await resolveSessionScopedSocketBinding({ userId: account.id, sessionId: row.id, machineId: machine.id });
        if (!binding.ok) throw new Error('Missing admitted Session publisher binding');
        const rawSession = createSessionRecordFixture({ id: row.id, encryptionMode: 'plain', metadata: '{}',
            metadataLayoutVersion: 0, active: true });
        // Synthetic Account authentication and HTTP persistence are genuine
        // system boundaries. Home ACL, routing, codecs and Session owners stay real.
        const http = createServer((request, response) => {
            const token = request.headers.authorization?.replace(/^Bearer /, '');
            if (token !== account.id && token !== collaborator.id) { response.writeHead(401); response.end(); return; }
            response.setHeader('Content-Type', 'application/json');
            const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
            if (path === '/v1/account/encryption/currentness') {
                response.end(JSON.stringify(createAccountEncryptionCurrentnessFixture()));
            } else if (path === `/v2/sessions/${row.id}`) {
                response.end(JSON.stringify({ session: rawSession }));
            } else { response.writeHead(404); response.end(JSON.stringify({ error: `unexpected_fixture_path:${path}` })); }
        });
        const server = new Server(http, { path: '/v1/updates/' });
        sockets = server;
        const compatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        ).evaluation;
        server.on('connection', socket => {
            const publisher = socket.handshake.query.publisher === '1';
            const authenticatedAccountId = publisher ? account.id : socket.handshake.auth.token;
            if (authenticatedAccountId !== account.id && authenticatedAccountId !== collaborator.id) {
                socket.disconnect(true); return;
            }
            socket.data = { clientType: publisher ? 'session-scoped' : 'user-scoped', sessionId: row.id,
                authAuthority: 'account_automation', authTokenAuthenticationEvidence: [], accountStoredContentCompatibility: compatibility,
                ...(publisher ? { sessionScopedBinding: binding.binding } : {}) };
            registerSocketRpcHandlers({ userId: authenticatedAccountId, socket, io: server });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
        const url = `http://127.0.0.1:${address.port}`;
        const credentials = { token: account.id, encryption: null };
        const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
            sessionId: 'daemon-host', mode: 'plain', ctx: null, serverHttpBaseUrl: url }));
        const createActions = (host: typeof executor, pluginId = 'happier.channels') => createPluginInvocationActionsService({
            seed: { plugin: { id: pluginId, version: '1.0.0' }, contribution: { id: 'provider/observation-ingest-v1' },
                occurrenceId: `${pluginId}-current`, sourceCustody: { kind: 'development', registeredRootId: 'permission-process-fixture' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId,
                    { machineId: machine.id }).resolveCurrentPluginMaterializationRef,
                resolveCurrentPluginExecutionOrigin: async () => ({ serverIdentityId: 'srv_permission_process',
                    materializationRef: createPluginActionCallerMaterializationFixture(pluginId, { machineId: machine.id }).materialization }),
                surface: 'background', signal: lifetime.signal, isOccurrenceCurrent: () => !lifetime.signal.aborted },
            actionExecutor: host,
            // This journey calls only canonical host Actions. Reaching a
            // contributed Action would invalidate its intended boundary.
            invokeContributedAction: async () => { throw new Error('Unexpected contributed Action in permission journey'); },
        });
        const actions = createActions(executor);
        const source = { sessionId: row.id, sourceRef: 'channels:binding:binding-1', sourceRevisionOrEpoch: '1:1' };
        await assert.rejects(actions.execute('session.permission.remote.pending.list', source),
            error => isPluginError(error) && error.code === 'ownerMachineUnavailable');
        assert.deepEqual(await readConversationPendingPermissions({ actions, source, signal: lifetime.signal }),
            { requests: [], truncated: false });
        const ready = createDeferred<ChildMessage>();
        const completions = new Map(['allow-request', 'deny-request', 'question-request'].map(id => [id, createDeferred<ChildMessage>()]));
        for (const pending of completions.values()) void pending.promise.catch(() => {});
        let stderr = '';
        child = spawn(process.execPath, ['--conditions=happier-source', '--import', sourceRuntime, childPath, url, row.id, account.id], {
            cwd: cliRoot, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        child.on('message', (message: ChildMessage) => {
            if (message.kind === 'ready') ready.resolve(message);
            if (message.requestId) completions.get(message.requestId)?.resolve(message);
        });
        child.once('error', error => ready.reject(error));
        exited = new Promise<void>(resolve => child!.once('exit', (code, signal) => {
            const error = new Error(`Session fixture exited code=${code} signal=${signal}\n${stderr}`);
            ready.reject(error);
            for (const pending of completions.values()) pending.reject(error);
            resolve();
        }));
        const initial = await ready.promise;
        assert.equal(initial.pid, child.pid);
        assert.notEqual(initial.pid, process.pid);
        const readPending = (result: unknown) => SessionPermissionRemotePendingListOutputV1Schema.parse(result);
        const ids = (projection: unknown) => SessionPermissionRemotePendingListOutputV1Schema.parse(projection).requests.map(request => request.requestId).sort();
        assert.deepEqual(ids(initial.projection), ['allow-request', 'deny-request', 'question-request']);
        assert.equal(resolveCurrentSessionCapabilityBinding(row.id), null);
        // The same executor/source now reaches the newly available child,
        // without a binding edit or synthetic title/transcript event.
        const pending = readPending(await actions.execute('session.permission.remote.pending.list', source));
        assert.deepEqual(ids(pending), ids(initial.projection));
        assert.equal(pending.truncated, false);
        assert.equal((await readConversationPendingPermissions({ actions, source, signal: lifetime.signal })).requests.length, 3);
        const foreign = { token: collaborator.id, encryption: null };
        const foreignExecutor = createActionExecutor(createCliActionDeps({ token: foreign.token, credentials: foreign,
            sessionId: 'other-account-daemon', mode: 'plain', ctx: null, serverHttpBaseUrl: url }));
        const foreignActions = createActions(foreignExecutor);
        const assertForbidden = (operation: Promise<unknown>) => assert.rejects(operation,
            error => isPluginError(error) && error.code === RPC_ERROR_CODES.FORBIDDEN);
        await assertForbidden(foreignActions.execute('session.permission.remote.pending.list', source));
        const allow = { ...source, turnId: 'turn-allow-request', requestId: 'allow-request', idempotencyKey: 'allow-once',
            actor: { namespace: 'discord', principalId: 'external-person' }, decision: 'allow' as const, scope: 'request' as const };
        await assertForbidden(foreignActions.execute('session.permission.remote.respond', allow));
        const respond = async (input: SessionPermissionRemoteRespondInputV1) => SessionPermissionRemoteRespondOutputV1Schema.parse(
            await actions.execute('session.permission.remote.respond', input));
        for (const invalid of [{ ...allow, turnId: 'stale-turn' }, { ...allow, sourceRevisionOrEpoch: '41' },
            { ...allow, sourceRef: 'binding:other' }]) assert.equal((await respond(invalid)).status, 'rejected');
        const wrongMediator = createActions(executor, 'other.plugin');
        assert.deepEqual(readPending(await wrongMediator.execute('session.permission.remote.pending.list', source)).requests, []);
        command = await createSeparateProcessChannelsIngress({ sessionId: row.id, machineId: machine.id,
            actions, signal: lifetime.signal });
        await command('/allow allow-request', 'allow-message', 'approvalConsumed');
        const approved = await completions.get('allow-request')!.promise;
        assert.deepEqual(approved.result, { decision: 'approved' });
        const completed = AgentStateSchema.parse({ requests: {}, completedRequests: { approved: approved.completed } }).completedRequests!.approved!;
        assert.equal(completed.status, 'approved');
        assert.equal(typeof completed.remoteMediationSettlementId, 'string');
        const stored = approved.records?.map(value => SessionPermissionMediationRecordStoredSchema.parse(value))
            .find(record => record.requestId === 'allow-request');
        assert.ok(stored?.content.t === 'plain');
        const settlement = SessionPermissionRemoteSettlementRecordV1Schema.parse(stored.content.v);
        assert.deepEqual(settlement.actor, { kind: 'externalHuman', assurance: 'pluginAsserted', namespace: 'happier.channel.telegram',
            principalId: 'telegram:user:42', assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'provider/observation-ingest-v1' } });
        assert.equal((await respond({ ...allow, decision: 'deny', idempotencyKey: 'conflicting-decision' })).status, 'rejected');
        await command('/deny deny-request', 'deny-message', 'approvalConsumed');
        assert.deepEqual((await completions.get('deny-request')!.promise).result, { decision: 'denied' });
        const answer = {
            ...source, turnId: 'turn-question-request', requestId: 'question-request', answers: [{ questionIndex: 0, values: ['release'] }],
        };
        await assertForbidden(foreignActions.execute('session.user_action.remote.answer', answer));
        await command('/answer question-request [{"questionIndex":0,"values":["release"]}]', 'answer-message', 'userActionConsumed');
        assert.deepEqual((await completions.get('question-request')!.promise).result,
            { decision: 'approved', answers: { 'Which branch?': ['release'] } });
        const answeredAgain = SessionUserActionRemoteAnswerOutputV1Schema.parse(await actions.execute('session.user_action.remote.answer',
            { ...answer, answers: [{ questionIndex: 0, values: ['main'] }] }));
        assert.equal(answeredAgain.status, 'rejected');
        assert.deepEqual(readPending(await actions.execute('session.permission.remote.pending.list', source)).requests, []);
    } finally {
        lifetime.abort();
        await command?.dispose();
        if (child?.connected) child.send('close');
        if (exited) await exited;
        if (sockets) await new Promise<void>(resolve => sockets!.close(() => resolve()));
        await database.close();
    }
}
