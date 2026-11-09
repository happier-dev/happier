import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE,
    FeaturesResponseSchema, SessionSystemRecordStoredReadResponseSchema,
    type ActionExecutorDeps, type ActionExecuteResult } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionBoardAuthoredItemUpsertInputV1Schema } from '@happier-dev/protocol/sessions/board/actions';
import { resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board/transcriptReference';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerSessionSystemRecordRoutes } from '@/app/api/routes/session/registerSessionSystemRecordRoutes';
import { registerSessionBoardRoutes } from '@/app/api/routes/session/registerSessionBoardRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { readPublishedSessionSurfaceItemInTx } from '@/app/session/systemRecords/sessionSystemRecordService';
import { mutateSessionBoard } from './service';

async function importCliModule<T>(specifier: string): Promise<T> {
    // Exercise workspace source without widening the server compiler's root.
    return import(specifier) as Promise<T>;
}

function readCliModules() {
    return Promise.all([
        importCliModule<{
            runWithServerHttpBaseUrl: <T>(url: string, run: () => Promise<T>) => Promise<T>;
        }>('../../../../../cli/src/api/client/serverHttpBaseUrl'),
        importCliModule<{
            createSessionBoardActionDeps: (options: unknown) => Pick<ActionExecutorDeps, 'sessionBoardAction' | 'sessionBoardPrepareItem'>;
        }>('../../../../../cli/src/session/board/sessionBoardActionDeps'),
        importCliModule<{
            createCliApprovalsArtifactStore: (options: unknown) => Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'>;
        }>('../../../../../cli/src/session/actions/approvals/artifactStore'),
        importCliModule<{
            RpcHandlerManager: new (options: unknown) => {
                registerHandler: (method: string, handler: (input: unknown) => Promise<unknown>) => void;
                invokeLocal: {
                    (method: typeof RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, input: unknown): Promise<ActionExecuteResult>;
                    (method: string, input: unknown, options: { verifiedPeerAuthority: 'present_user' | 'account_automation' }): Promise<unknown>;
                };
            };
        }>('../../../../../cli/src/api/rpc/RpcHandlerManager'),
        importCliModule<{
            registerApprovalRpcHandlers: (options: unknown) => void;
        }>('../../../../../cli/src/rpc/handlers/approvals'),
        importCliModule<{
            createUnavailableActionTransportDeps: () => ActionExecutorDeps;
        }>('../../../../../cli/src/testkit/actionTransportDeps'),
    ]);
}

describe('Session visual creator persistence', () => {
    let harness: LightSqliteHarness | undefined;
    let cliModules: Awaited<ReturnType<typeof readCliModules>>;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-visual-creator-', initAuth: false, initEncrypt: true, initFiles: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: '1' } });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
        // Cold cross-workspace module preparation belongs to the suite bootstrap,
        // before the test's HTTP/approval execution budget starts.
        cliModules = await readCliModules();
    }, 300_000);
    afterAll(async () => { resetSessionSystemRecordsProtocolV1ActivationForTests(); await harness?.close(); });

    it('persists an approved CLI visual through registered HTTP routes and replays its exact transcript reference', async () => {
        const account = await db.account.create({ data: { publicKey: `visual-action-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const app = createAuthenticatedTestApp();
        const httpFailures: unknown[] = [];
        app.addHook('onSend', async (request: FastifyRequest, reply: { statusCode: number }, payload: unknown) => {
            if (reply.statusCode >= 400) httpFailures.push({ path: request.url, status: reply.statusCode, payload });
            return payload;
        });
        // Authentication is the external boundary; routes, codecs, approval storage
        // and Board transactions below are the production implementations.
        app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = account.id; });
        registerSessionListingRoutes(app);
        registerSessionSystemRecordRoutes(app);
        registerSessionBoardRoutes(app);
        registerAccountEncryptionRoutes(app);
        artifactsRoutes(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const [{ runWithServerHttpBaseUrl }, { createSessionBoardActionDeps }, { createCliApprovalsArtifactStore },
                { RpcHandlerManager }, { registerApprovalRpcHandlers }, { createUnavailableActionTransportDeps }] = cliModules;
            await runWithServerHttpBaseUrl(origin, async () => {
                const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: account.id,
                    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
                const store = createCliApprovalsArtifactStore({ credentials, serverId: 'visual-home' });
                const rpc = new RpcHandlerManager({ scopePrefix: 'visual-machine', encryptionMode: 'plain', logger: () => {} });
                const executor = createActionExecutor({
                    ...createUnavailableActionTransportDeps(),
                    ...createSessionBoardActionDeps({ credentials, serverId: 'visual-home', serverHttpBaseUrl: origin,
                        resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
                            features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: {},
                        }) }),
                    }),
                    ...store,
                    // The exact daemon currentness witness is an authenticated
                    // runtime boundary; replay/registration itself stays real.
                    isApprovalExecutionOriginCurrent: async ({ origin }) => origin.machineId === 'visual-machine'
                        && origin.sessionId === session.id && origin.serverId === 'visual-home',
                    approvalRequestApprovedReplay: async ({ artifactId }) => rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId }),
                });
                registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
                const input = SessionBoardAuthoredItemUpsertInputV1Schema.parse({ sessionId: session.id, itemId: 'chart', expectedItemRevision: null,
                    destination: 'transcript', item: { v: 1, title: 'Observed result', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Stored through the Board route' } } } },
                });
                const pending = await executor.execute('session.board.item.upsert', input, {
                    surface: 'agent', authority: 'account_automation', serverId: 'visual-home', runtimeAccountId: account.id,
                    defaultSessionId: session.id, defaultSessionMachineId: 'visual-machine', actionRequestId: 'visual-request',
                    actionCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                    actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] } } }),
                });
                expect(pending, JSON.stringify({ pending, httpFailures })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                if (!pending.ok || !pending.result || typeof pending.result !== 'object' || !('artifactId' in pending.result)
                    || typeof pending.result.artifactId !== 'string') throw new Error('Expected durable visual approval');
                const artifactId = pending.result.artifactId;
                expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(0);
                expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(1);
                const address = { serverId: 'visual-home', sessionId: session.id };
                expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: 'session_board_item_upsert', state: 'completed', input,
                    result: pending, address })).toBeNull();
                const decisionInput = getActionSpec('approval.request.decide').inputSchema.parse({ artifactId, decision: 'approve' });
                const automatedDecision = await rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_DECIDE, decisionInput,
                    { verifiedPeerAuthority: 'account_automation' });
                expect(automatedDecision).toMatchObject({ ok: false, errorCode: 'present_user_required' });
                expect(await store.approvalsGet!({ artifactId, serverId: 'visual-home' })).toMatchObject({ status: 'open' });
                expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(0);
                const decision = await rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_DECIDE, decisionInput,
                    { verifiedPeerAuthority: 'present_user' });
                expect(decision, JSON.stringify({ decision, httpFailures })).toMatchObject({ status: 'executed', execution: { ok: true } });
                getActionSpec('approval.request.decide').outputSchema!.parse(decision);
                const approved = await store.approvalsGet!({ artifactId, serverId: 'visual-home' });
                expect(approved).toMatchObject({ status: 'executed', execution: { ok: true } });
                if (!approved?.execution?.ok) throw new Error('Expected stored executed result');
                const acknowledgement = getActionSpec('session.board.item.upsert').outputSchema!.parse(approved.execution.result);
                const reference = resolveTranscriptSessionBoardItemReferenceV1({ toolName: 'session_board_item_upsert', state: 'completed', input,
                    result: acknowledgement, address });
                expect(reference).toMatchObject({ address, itemId: input.itemId, itemDestination: 'transcript', outcome: 'created', destination: null });
                if (!reference) throw new Error('Producer acknowledgement was not admitted by the transcript consumer');
                const headers = { [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE };
                const recordUrl = `/v2/sessions/${reference.address.sessionId}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=${reference.itemId}`;
                const response = await app.inject({ method: 'GET', url: recordUrl, headers });
                expect(response.statusCode, response.body).toBe(200);
                const record = SessionSystemRecordStoredReadResponseSchema.parse(response.json()).record;
                expect(record?.revision).toBe(reference.itemRevision);
                expect(record?.content).toEqual({ t: 'plain', v: { ...input.item, destination: input.destination } });
                expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(1);
                await expect(rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, {
                    artifactId, decision: 'reject', authority: 'present_user',
                })).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
                expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(1);
                const afterReplay = await app.inject({ method: 'GET', url: recordUrl, headers });
                expect(SessionSystemRecordStoredReadResponseSchema.parse(afterReplay.json()).record).toEqual(record);
                expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: 'session_board_item_upsert', state: 'completed', input,
                    result: acknowledgement, address: { ...address, sessionId: 'foreign-session' } })).toBeNull();
            });
        } finally { await app.close(); }
    });

    it('persists exact visual content without creation attribution and retains item CAS', async () => {
        const account = await db.account.create({ data: { publicKey: `creator-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const itemContent = { t: 'plain' as const, v: { v: 1, destination: 'transcript', title: 'Result', frame: 'frameless',
            height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } } };
        const create = await mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
            mutation: { operation: 'upsert_item', itemId: 'visual', expectedItemRevision: null, itemContent } });
        expect(create.ok).toBe(true);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication is the network boundary; all persistence and projection logic stays real.
        app.decorate('authenticate', async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = 'present_user'; });
        registerSessionSystemRecordRoutes(app);
        try {
            const query = 'owner=host&namespace=surface&kind=item.v1&localId=visual';
            const headers = { [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE };
            const first = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query}`, headers });
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json().record).not.toHaveProperty('creator');
            expect((await db.sessionSystemRecord.findUniqueOrThrow({ where: { id: first.json().record.id } })).content).toEqual(itemContent);
            expect(first.json().record.content).toEqual(itemContent);
            const update = await mutateSessionBoard({ actorUserId: account.id, sessionId: session.id,
                authentication: { ...authentication, authority: 'account_automation' },
                mutation: { operation: 'upsert_item', itemId: 'visual', expectedItemRevision: first.json().record.revision,
                    itemContent: { ...itemContent, v: { ...itemContent.v, title: 'Updated' } } } });
            expect(update.ok).toBe(true);
            const second = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query}`, headers });
            expect(second.json().record).not.toHaveProperty('creator');
            const published = await inTx(tx => readPublishedSessionSurfaceItemInTx(tx, {
                accountId: account.id, sessionId: session.id, itemId: 'visual', encryptionMode: 'plain',
            }));
            expect(published).not.toHaveProperty('creator');
            expect(published?.content).toEqual({ ...itemContent, v: { ...itemContent.v, title: 'Updated' } });

            await expect(mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
                mutation: { operation: 'upsert_item', itemId: 'visual', expectedItemRevision: first.json().record.revision,
                    itemContent } })).resolves.toMatchObject({ ok: false, result: { error: 'session_board_revision_conflict' } });

            // Retained development attribution wrappers remain readable without
            // restoring attribution as a new write or admission authority.
            await db.sessionSystemRecord.update({ where: { id: first.json().record.id }, data: { content: {
                t: 'session_surface_record_v1', content: itemContent, creator: { kind: 'session', sessionId: session.id },
            } } });
            const legacy = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query}`, headers });
            expect(legacy.json().record).not.toHaveProperty('creator');
            expect(legacy.json().record.content).toEqual(itemContent);
            await expect(mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
                mutation: { operation: 'upsert_item', itemId: 'visual',
                    expectedItemRevision: legacy.json().record.revision, itemContent: { ...itemContent, v: { ...itemContent.v, title: 'Legacy update' } } } })).resolves.toMatchObject({ ok: true });
            const legacyUpdate = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query}`, headers });
            expect(legacyUpdate.json().record).not.toHaveProperty('creator');
            expect((await db.sessionSystemRecord.findUniqueOrThrow({ where: { id: first.json().record.id } })).content)
                .toEqual({ ...itemContent, v: { ...itemContent.v, title: 'Legacy update' } });
            const forged = await mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
                mutation: { operation: 'upsert_item', itemId: 'forged', expectedItemRevision: null,
                    creator: { kind: 'session', sessionId: session.id }, itemContent } });
            expect(forged).toMatchObject({ ok: false, result: { error: 'session_board_invalid' } });
        } finally { await app.close(); }
    });
});
