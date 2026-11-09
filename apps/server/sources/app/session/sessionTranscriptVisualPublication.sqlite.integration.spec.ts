import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1,
    sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { readApprovalTranscriptVisualPublicationV1 } from '@happier-dev/protocol/sessions/board/transcriptReference';
import { resolveTranscriptBodySessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { deriveSessionSystemRecordAddressKeys } from './systemRecords/sessionSystemRecordAddressKeys';
import { encodeSessionSystemRecordRevision } from './systemRecords/sessionSystemRecordRevision';
import { bindSessionTranscriptApprovalVisualPublication } from './sessionTranscriptApprovalVisualPublication';

describe('approved visual publication on the existing native transcript row', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-transcript-approval-visual-', initAuth: true,
            initEncrypt: true, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'none' } });
    });
    afterAll(async () => { await harness?.close(); });

    it.each([
        { mode: 'plain' as const, order: 'bind-first', itemUnavailable: false, collaborator: false }, { mode: 'e2ee' as const, order: 'bind-first', itemUnavailable: false, collaborator: false },
        { mode: 'plain' as const, order: 'settle-first', itemUnavailable: false, collaborator: false }, { mode: 'e2ee' as const, order: 'settle-first', itemUnavailable: false, collaborator: false },
        { mode: 'plain' as const, order: 'bind-first', itemUnavailable: true, collaborator: false }, { mode: 'e2ee' as const, order: 'bind-first', itemUnavailable: true, collaborator: false },
        { mode: 'plain' as const, order: 'bind-first', itemUnavailable: false, collaborator: true },
    ])('settles $mode/$order with Item unavailable=$itemUnavailable and collaborator=$collaborator without rewriting the native row', async ({ mode, order, itemUnavailable, collaborator }) => {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const key = tweetnacl.randomBytes(32);
        const encode = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : privacyKit.encodeBase64(await sealSessionDataKeyBundleV0(value, key));
        const dataEncryptionKey = mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
            : privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
                recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes }));
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: mode } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: 'fixture' } });
        const item = { v: 1, destination: 'transcript', title: 'Result', frame: 'frameless',
            height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Result' } } } };
        const record = await db.sessionSystemRecord.create({ data: {
            accountId: owner.id, sessionId: session.id, ownerKind: 'host', pluginId: null,
            namespace: 'surface', kind: 'item.v1', localId: 'visual', version: 1,
            ...deriveSessionSystemRecordAddressKeys({ ownerKind: 'host', pluginId: null, namespace: 'surface', localId: 'visual' }),
            content: mode === 'plain' ? { t: 'plain', v: item } : { t: 'encrypted', c: 'sealed-item' },
        } });
        const revision = encodeSessionSystemRecordRevision(record);
        const approvalId = randomUUID();
        const reference = { v: 1 as const, references: [{ v: 1 as const, itemId: 'visual', itemRevision: revision,
            sourceAddress: { serverId: 'home', sessionId: session.id }, sourceItemId: 'visual', sourceItemRevision: revision,
            approvalRequestArtifactId: approvalId }] };
        const input = { sessionId: session.id, itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: session.id }, requestedSurface: 'agent', summary: 'Show result',
            actionId: 'session.board.item.upsert', actionArgs: input,
            origin: { kind: 'transcript_tool_call', sessionId: session.id, toolName: 'session_board_item_upsert', toolInput: input },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                serverId: 'home', sessionId: session.id, machineId, actionId: 'session.board.item.upsert', requestId: randomUUID() } });
        const settled = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 3,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { ok: true, effectAttempted: true, executedAtMs: 3,
                result: { v: 1, serverId: 'home', sessionId: session.id, itemDestination: 'transcript', destination: null,
                    result: { operation: 'upsert_item', itemId: 'visual', itemRevision: revision, outcome: 'created' } } } });
        const publicationCandidate = readApprovalTranscriptVisualPublicationV1({ artifactId: approvalId,
            approval: approvalArtifactBodyMatchesHeaderV1(buildApprovalRequestArtifactHeaderV1(settled), JSON.stringify(settled)) });
        expect(publicationCandidate).toEqual({ v: 1, sessionId: session.id, surfaceItemReference: reference });
        for (const unsettled of [request,
            ApprovalRequestV2Schema.parse({ ...request, status: 'rejected', updatedAtMs: 2,
                decision: { kind: 'reject', decidedAtMs: 2 } }),
            ApprovalRequestV2Schema.parse({ ...settled, status: 'failed', execution: { ...settled.execution, ok: false } }),
        ]) expect(readApprovalTranscriptVisualPublicationV1({ artifactId: approvalId,
            approval: approvalArtifactBodyMatchesHeaderV1(buildApprovalRequestArtifactHeaderV1(unsettled), JSON.stringify(unsettled)) })).toBeNull();
        const receipt = { role: 'agent', content: { type: 'codex', data: { type: 'tool-result', callId: 'native-call',
            output: { kind: 'approval_request_created', artifactId: approvalId, actionId: 'session.board.item.upsert' } } } };
        const content = mode === 'plain' ? { t: 'plain' as const, v: receipt }
            : { t: 'encrypted' as const, c: await encode(receipt) };
        const localId = 'native-result';
        const socket = createAuthenticatedFakeSocket({ id: randomUUID() });
        sessionUpdateHandler(owner.id, socket as never, { connectionType: 'session-scoped', socket, userId: owner.id, sessionId: session.id } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId: owner.id, machineId, sessionId: session.id } });
        await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: session.id, mutationId: randomUUID(),
            snapshot: { state: 'idle', activeCount: 0 } }, () => {});
        const bind = async (updatedAt = 1) => {
            let ack: unknown;
            await getSocketHandler(socket, 'transcript-observation-v1')({ v: 2, sessionId: session.id, localId,
                messageRole: resolveTranscriptBodySessionMessageRole({ protocol: 'acp', body: receipt.content }), content, createdAt: 1, updatedAt,
                provenance: { kind: 'non_dependent', source: 'external' }, approvalRequestArtifactId: approvalId }, (value: unknown) => { ack = value; });
            expect(ack).toMatchObject({ ok: true, localId });
        };
        const row = () => db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                id: approvalId, kind: deriveArtifactStoredKindV1(buildApprovalRequestArtifactHeaderV1(request)), approvalState: 'open', approvalSessionId: session.id,
                header: await encode(buildApprovalRequestArtifactHeaderV1(request)), body: await encode({ body: JSON.stringify(request) }), dataEncryptionKey,
            } });
            expect(created.statusCode, created.body).toBe(200);
            if (order === 'bind-first') {
                expect(await bindSessionTranscriptApprovalVisualPublication({ accountId: owner.id,
                    artifactId: approvalId, sessionId: session.id, localId, messageId: 'missing-native-row', content })).toBe(false);
                expect((await db.artifact.findUniqueOrThrow({ where: { id: approvalId } })).transcriptVisualPublication).toBeNull();
                await bind();
                expect((await row()).surfaceItemReference).toBeNull();
            }
            const settlementPayload = {
                kind: deriveArtifactStoredKindV1(buildApprovalRequestArtifactHeaderV1(settled)), approvalState: 'executed', approvalSessionId: session.id,
                header: await encode(buildApprovalRequestArtifactHeaderV1(settled)), expectedHeaderVersion: 1,
                body: await encode({ body: JSON.stringify(settled) }), expectedBodyVersion: 1,
                transcriptVisualPublication: publicationCandidate,
            };
            if (order === 'bind-first') {
                const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
                const foreignSession = await db.session.create({ data: { accountId: foreign.id, tag: randomUUID(), metadata: '{}' } });
                const denied = await app.inject({ method: 'POST', url: `/v1/artifacts/${approvalId}`,
                    headers: { 'x-test-user-id': foreign.id }, payload: settlementPayload });
                expect(denied.statusCode).toBe(404);
                for (const candidate of [
                    { ...publicationCandidate, sessionId: foreignSession.id },
                    { ...publicationCandidate, surfaceItemReference: { v: 1, references: [{ ...reference.references[0], itemId: 'missing' }] } },
                    { ...publicationCandidate, surfaceItemReference: { v: 1, references: [{ ...reference.references[0], approvalRequestArtifactId: 'other-receipt' }] } },
                ]) {
                    const refused = await app.inject({ method: 'POST', url: `/v1/artifacts/${approvalId}`, headers,
                        payload: { ...settlementPayload, approvalSessionId: candidate.sessionId, transcriptVisualPublication: candidate } });
                    expect(refused.statusCode, refused.body).toBe(400);
                }
                // Index hints alone remain ordinary metadata, not a publication candidate.
                const hintOnly = await app.inject({ method: 'POST', url: `/v1/artifacts/${approvalId}`, headers,
                    payload: { expectedHeaderVersion: 1, approvalState: 'open', approvalSessionId: session.id,
                        transcriptVisualPublication: publicationCandidate } });
                expect(hintOnly.statusCode).toBe(400);
                expect((await row()).surfaceItemReference).toBeNull();
                expect(await db.artifact.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ headerVersion: 1, bodyVersion: 1 });
            }
            if (itemUnavailable) await db.sessionSystemRecord.delete({ where: { id: record.id } });
            let settlementHeaders = headers;
            if (collaborator) {
                const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
                await makeShareEligibleForTest(owner.id, editor.id);
                const grant = await app.inject({ method: 'PUT', url: `/v1/artifacts/${approvalId}/access/grants`, headers,
                    payload: { artifactId: approvalId, principal: { kind: 'account', accountId: editor.id }, accessLevel: 'edit' } });
                expect(grant.statusCode, grant.body).toBe(200);
                settlementHeaders = { 'x-test-user-id': editor.id };
            }
            const result = await app.inject({ method: 'POST', url: `/v1/artifacts/${approvalId}`, headers: settlementHeaders, payload: settlementPayload });
            expect(result.statusCode, result.body).toBe(200);
            expect(await db.artifact.findUniqueOrThrow({ where: { id: approvalId } }))
                .toMatchObject({ approvalState: 'executed', headerVersion: 2, bodyVersion: 2 });
            if (order === 'settle-first') await bind();
        });
        const published = await row();
        if (itemUnavailable || collaborator) {
            expect(published).toMatchObject({ localId, seq: 1, content, surfaceItemReference: null });
            await bind();
            expect((await row()).surfaceItemReference).toBeNull();
            expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
            return;
        }
        expect(published).toMatchObject({ localId, seq: 1, content, surfaceItemReference: reference });
        const publication = await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: owner.id, kind: 'session', entityId: session.id },
        } });
        expect(publication.hint).toMatchObject({ updatedMessageId: published.id, updatedMessageSeq: published.seq });
        // A new transport invocation reads persisted correspondence; no live approval or UI reader exists here.
        await bind();
        expect(await row()).toMatchObject({ id: published.id, seq: published.seq, content,
            rowRevision: published.rowRevision, surfaceItemReference: reference });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
        expect(await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: owner.id, kind: 'session', entityId: session.id },
        } })).toEqual(publication);
        // Advancing only native source metadata is not a different receipt/body.
        await bind(2);
        expect(await row()).toMatchObject({ id: published.id, seq: published.seq, content,
            rowRevision: published.rowRevision + 1n, surfaceItemReference: reference });
    });
});
