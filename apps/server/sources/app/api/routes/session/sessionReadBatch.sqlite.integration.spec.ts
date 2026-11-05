import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { encodeSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { projectSessionDisplayV1, sealSessionOwnerDisplayEnvelopeV1, sealSessionSharedDisplayEnvelopeV1,
    sealSessionSharedDisplayEnvelopeV1Sync, sealSessionDataKeyBundleV0, SessionListQueryV1Schema } from '@happier-dev/protocol';
import { SessionOwnerMetadataV1Schema, SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { registerSessionListingRoutes } from './registerSessionListingRoutes';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';
import { registerSessionTurnMutationRoute } from './registerSessionTurnMutationRoute';
import { registerSessionPatchRoute } from './registerSessionPatchRoute';
import { registerSessionCreateOrLoadRoute } from './registerSessionCreateOrLoadRoute';
import { createMaterializedEphemeralRunnerFixture } from '@/app/ephemeralRunner/materializedRunner.testkit';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { sessionReadBatchCostContract } from './sessionReadBatchCost.testkit';

// The actual read owners are sufficient; Session deletion and mutation registrars
// are not part of this transport's HTTP/authentication contract.
function registerSessionReadRoutes(app: Fastify) {
    registerSessionListingRoutes(app);
    registerSessionReadBatchRoute(app);
    registerSessionMessageRoutes(app);
    registerSessionTurnMutationRoute(app);
}

describe('Session id-batched reads (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-read-batch-', initAuth: true, initEncrypt: true, env: {
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); vi.unstubAllEnvs(); });

    sessionReadBatchCostContract('sqlite');

    it('atomically creates pre-encrypted display before the server allocates its Session id', async () => {
        const sessionKey = new Uint8Array(32).fill(8);
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
        const owner = await db.account.create({ data: {
            ...createSignedAccountContentBinding(tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey),
            encryptionMode: 'e2ee',
        } });
        const random = (length: number) => new Uint8Array(length).fill(4);
        const sharedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: 'Before-id shared title', updatedAt: 0 } });
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { name: 'Before-id private title' } });
        const semantic = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        const shared = await sealSessionSharedDisplayEnvelopeV1({ sessionMode: 'e2ee', display: semantic.shared,
            encryptPayload: async payload => encodeBase64(await sealSessionDataKeyBundleV0(payload, sessionKey), 'base64') });
        const privateDisplay = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', display: semantic.owner!,
            material, randomBytes: random });
        if (!shared.ok || !privateDisplay.ok || !owner.contentPublicKey) throw new Error('Canonical before-id display producer failed');
        const displayProjectionV1 = { v: 1, metadataLayoutVersion: 1, sourceMetadataVersion: 0,
            shared: shared.envelope, owner: privateDisplay.envelope };
        const metadataEnvelope = sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata, material, randomBytes: random });
        const body = { tag: crypto.randomUUID(), metadataLayoutVersion: 1, encryptionMode: 'e2ee',
            sharedMetadata: { ciphertext: encodeBase64(await sealSessionDataKeyBundleV0(sharedMetadata, sessionKey), 'base64') },
            ownerMetadata: metadataEnvelope, agentState: null, displayProjectionV1,
            dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
                recipientPublicKey: new Uint8Array(owner.contentPublicKey), randomBytes: random }), 'base64') };
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(app => { registerSessionReadRoutes(app); registerSessionCreateOrLoadRoute(app); }, async app => {
            const headers = { authorization: `Bearer ${token}`, 'x-happier-account-stored-content-protocol': '4' };
            expect(body).not.toHaveProperty('id');
            const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
            expect(created.statusCode, created.body).toBe(200);
            const sessionId = created.json().session.id as string;
            const stored = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
            expect(stored.metadataVersion).toBe(0);
            expect(JSON.parse(stored.displayProjectionV1 ?? 'null')).toEqual(displayProjectionV1);
            const listed = await app.inject({ method: 'GET', url: '/v2/sessions', headers });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().sessions.find((row: { id: string }) => row.id === sessionId).displayProjectionV1).toEqual(displayProjectionV1);
            const replayed = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
                payload: { ...body, displayProjectionV1: null, sharedMetadata: { ciphertext: 'losing-create-content' } } });
            expect(replayed.statusCode, replayed.body).toBe(200);
            expect(replayed.json()).toMatchObject({ created: false, session: { id: sessionId } });
            const winner = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
            expect(winner.metadata).toBe(stored.metadata);
            expect(winner.displayProjectionV1).toBe(stored.displayProjectionV1);
            const invalidRevision = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
                payload: { ...body, tag: crypto.randomUUID(), displayProjectionV1: { ...displayProjectionV1, sourceMetadataVersion: 1 } } });
            expect(invalidRevision.statusCode, invalidRevision.body).toBe(400);
            const wrongMode = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', display: semantic.shared });
            if (!wrongMode.ok) throw new Error('Canonical plain display producer failed');
            const invalidMode = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
                payload: { ...body, tag: crypto.randomUUID(), displayProjectionV1: { ...displayProjectionV1, shared: wrongMode.envelope } } });
            expect(invalidMode.statusCode, invalidMode.body).toBe(400);
            expect(await db.session.count({ where: { accountId: owner.id } })).toBe(1);
        }, { authentication: 'real' });
    }, 120_000);

    it('commits display with its metadata tuple and reads it through the compact list', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const previousOwner = { t: 'plain', v: { v: 1 } } as const;
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify(previousOwner) } });
        const sharedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: 'Shared display title', updatedAt: 1 } });
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { name: 'Private display title', path: '/private/repository' } });
        const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        const shared = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', display: display.shared });
        const privateDisplay = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', display: display.owner! });
        if (!shared.ok || !privateDisplay.ok) throw new Error('Canonical plain display producer failed');
        const displayProjectionV1 = { v: 1, sourceMetadataVersion: 1, metadataLayoutVersion: 1,
            shared: shared.envelope, owner: privateDisplay.envelope };
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const editor = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id,
            sharedWithUserId: editor.id, accessLevel: 'edit' } });
        const editorToken = await auth.createToken(editor.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(app => { registerSessionReadRoutes(app); registerSessionPatchRoute(app); }, async app => {
            const headers = { authorization: `Bearer ${ownerToken}`, 'x-happier-account-stored-content-protocol': '4' };
            const payload = { mode: 'owner', metadataLayoutVersion: 1, expectedOwnerMetadata: previousOwner,
                ownerMetadata: { t: 'plain', v: ownerMetadata }, sharedMetadata: { ciphertext: JSON.stringify(sharedMetadata), expectedVersion: 0 },
                agentState: { ciphertext: null, expectedVersion: 0 }, displayProjectionV1 };
            const written = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers, payload });
            expect(written.statusCode, written.body).toBe(200);
            const stored = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(stored.metadataVersion).toBe(1);
            expect(JSON.parse(stored.displayProjectionV1 ?? 'null')).toEqual(displayProjectionV1);
            const list = await app.inject({ method: 'GET', url: '/v2/sessions', headers });
            expect(list.statusCode, list.body).toBe(200);
            expect(list.json().sessions.find((row: { id: string }) => row.id === session.id)).toMatchObject({
                documents: 'omitted', metadataVersion: 1, displayProjectionV1,
            });
            const ownerRetry = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers, payload });
            expect(ownerRetry.statusCode, ownerRetry.body).toBe(200);
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).metadataVersion).toBe(1);
            const wrongAccountMode = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', display: display.owner!,
                material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) }, randomBytes: length => new Uint8Array(length).fill(4) });
            if (!wrongAccountMode.ok) throw new Error('Canonical encrypted display producer failed');
            const incompatibleOwner = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers,
                payload: { ...payload, expectedOwnerMetadata: payload.ownerMetadata,
                    sharedMetadata: { ...payload.sharedMetadata, expectedVersion: 1 },
                    agentState: { ...payload.agentState, expectedVersion: stored.agentStateVersion },
                    displayProjectionV1: { ...displayProjectionV1, sourceMetadataVersion: 2, owner: wrongAccountMode.envelope } } });
            expect(incompatibleOwner.statusCode, incompatibleOwner.body).toBe(400);
            const losingMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: 'Losing title', updatedAt: 2 } });
            const losingDisplay = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain',
                display: projectSessionDisplayV1({ sharedMetadata: losingMetadata }).shared });
            if (!losingDisplay.ok) throw new Error('Canonical stale display producer failed');
            const stale = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers,
                payload: { ...payload, sharedMetadata: { ...payload.sharedMetadata, ciphertext: JSON.stringify(losingMetadata) },
                    displayProjectionV1: { ...displayProjectionV1, shared: losingDisplay.envelope } } });
            expect(stale.statusCode, stale.body).toBe(409);
            const afterConflict = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(afterConflict.displayProjectionV1).toBe(stored.displayProjectionV1);
            const editorHeaders = { ...headers, authorization: `Bearer ${editorToken}` };
            const editedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: 'Edited shared display', updatedAt: 2 } });
            const editedDisplay = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain',
                display: projectSessionDisplayV1({ sharedMetadata: editedMetadata }).shared });
            if (!editedDisplay.ok) throw new Error('Canonical editor display producer failed');
            const sharedOnly = { ...displayProjectionV1, sourceMetadataVersion: 2, shared: editedDisplay.envelope, owner: undefined };
            const sharedPatch = { mode: 'shared_editor', metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: JSON.stringify(editedMetadata), expectedVersion: 1 }, displayProjectionV1: sharedOnly };
            const forged = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers: editorHeaders,
                payload: { ...sharedPatch, displayProjectionV1: { ...sharedOnly, owner: privateDisplay.envelope } } });
            expect(forged.statusCode, forged.body).toBe(400);
            const tupleWrites: unknown[] = [];
            const stopObserving = observeSqliteRequests({ after: async request => {
                if (request.model === 'Session' && request.action === 'updateMany') tupleWrites.push(request.args);
            } });
            try {
                const edited = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers: editorHeaders, payload: sharedPatch });
                expect(edited.statusCode, edited.body).toBe(200);
            } finally { stopObserving(); }
            // The same durable UPDATE that advances the tuple must prove the
            // captured owner content did not change while retaining its leaf.
            expect(tupleWrites).toEqual(expect.arrayContaining([expect.objectContaining({
                where: expect.objectContaining({ id: session.id, metadataVersion: 1, ownerMetadata: stored.ownerMetadata }),
                data: expect.objectContaining({ metadataVersion: 2 }),
            })]));
            const preserved = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(JSON.parse(preserved.displayProjectionV1 ?? 'null')).toEqual({ ...sharedOnly, owner: privateDisplay.envelope });
            const sharedRetry = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers: editorHeaders,
                payload: sharedPatch });
            expect(sharedRetry.statusCode, sharedRetry.body).toBe(200);
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).displayProjectionV1).toBe(preserved.displayProjectionV1);
            const editorList = await app.inject({ method: 'GET', url: '/v2/sessions', headers: editorHeaders });
            expect(editorList.statusCode, editorList.body).toBe(200);
            const sharedRow = editorList.json().sessions.find((row: { id: string }) => row.id === session.id);
            expect(sharedRow.displayProjectionV1).toEqual(JSON.parse(JSON.stringify(sharedOnly)));
            expect(editorList.body).not.toContain('Private display title');
            expect(editorList.body).not.toContain('/private/repository');
            const invalidLink = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers: editorHeaders,
                payload: { ...sharedPatch, sharedMetadata: { ...sharedPatch.sharedMetadata, expectedVersion: 2 },
                    displayProjectionV1: { ...sharedOnly, sourceMetadataVersion: 99 } } });
            expect(invalidLink.statusCode, invalidLink.body).toBe(400);
            const omitted = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers: editorHeaders,
                payload: { mode: 'shared_editor', metadataLayoutVersion: 1,
                    sharedMetadata: { ciphertext: JSON.stringify({ v: 1, summary: { text: 'No display producer', updatedAt: 3 } }), expectedVersion: 2 } } });
            expect(omitted.statusCode, omitted.body).toBe(200);
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).displayProjectionV1).toBeNull();
            const ownerWithoutLeaf = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers,
                payload: { ...payload, expectedOwnerMetadata: payload.ownerMetadata,
                    sharedMetadata: { ...payload.sharedMetadata, expectedVersion: 3 },
                    agentState: { ...payload.agentState, expectedVersion: stored.agentStateVersion },
                    displayProjectionV1: { ...displayProjectionV1, owner: undefined, sourceMetadataVersion: 4 } } });
            expect(ownerWithoutLeaf.statusCode, ownerWithoutLeaf.body).toBe(200);
            const ownerDropped = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(JSON.parse(ownerDropped.displayProjectionV1 ?? 'null')).toEqual({
                v: 1, metadataLayoutVersion: 1, sourceMetadataVersion: 4, shared: shared.envelope,
            });
            await db.session.update({ where: { id: session.id }, data: { displayProjectionV1: '{invalid-retained-display' } });
            const full = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [session.id], accessProjectionVersion: 1,
                    includeSnapshot: true, includeTurns: false, includeMessages: false } });
            expect(full.statusCode, full.body).toBe(200);
            expect(full.json().results[0]).toMatchObject({ detail: { status: 200, body: { session: { metadataVersion: 4,
                metadata: payload.sharedMetadata.ciphertext } } } });
            expect(full.json().results[0].detail.body.session).not.toHaveProperty('displayProjectionV1');
            // A stale stored linkage is not proof that the exact old owner leaf
            // still describes this tuple, even though its ciphertext is present.
            await db.session.update({ where: { id: session.id }, data: {
                displayProjectionV1: JSON.stringify({ ...displayProjectionV1, sourceMetadataVersion: 3 }),
            } });
            const afterUnprovenOwner = { ...sharedOnly, sourceMetadataVersion: 5 };
            const unproven = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`, headers: editorHeaders,
                payload: { ...sharedPatch, sharedMetadata: { ...sharedPatch.sharedMetadata, expectedVersion: 4 },
                    displayProjectionV1: afterUnprovenOwner } });
            expect(unproven.statusCode, unproven.body).toBe(200);
            const unprovenStored = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(JSON.parse(unprovenStored.displayProjectionV1 ?? 'null')).toEqual(JSON.parse(JSON.stringify(afterUnprovenOwner)));
        }, { authentication: 'real' });
    }, 120_000);

    it('hydrates only the current runtime managed subtree without granting exact detail or transcripts', async () => {
        const fixture = await createMaterializedEphemeralRunnerFixture();
        const sharedRoot = JSON.stringify(projectSessionSharedMetadataV1({ metadata: { summary: { text: 'shared-root', updatedAt: 0 } } }));
        const sharedChild = JSON.stringify(projectSessionSharedMetadataV1({ metadata: { summary: { text: 'shared-child', updatedAt: 0 } } }));
        const display = projectSessionDisplayV1({ sharedMetadata: SessionSharedMetadataV1Schema.parse(JSON.parse(sharedRoot)),
            ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { name: 'owner-only display' } }) });
        const sharedDisplay = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', display: display.shared });
        const ownerDisplay = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', display: display.owner! });
        if (!sharedDisplay.ok || !ownerDisplay.ok) throw new Error('Canonical runtime display producer failed');
        const displayProjectionV1 = { v: 1 as const, sourceMetadataVersion: 0, metadataLayoutVersion: 1 as const,
            shared: sharedDisplay.envelope, owner: ownerDisplay.envelope };
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadata: sharedRoot,
            displayProjectionV1: JSON.stringify(displayProjectionV1),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1, workspace: { name: 'owner-only' } } }),
            agentState: 'owner-agent-state', agentStateVersion: 1,
        } });
        const child = await db.session.create({ data: { accountId: fixture.accountId, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: sharedChild,
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }) } });
        const outside = await db.session.create({ data: { accountId: fixture.accountId, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1, name: 'outside' }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }) } });
        const edge = await db.sessionFollowEdge.create({ data: {
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: child.id }),
            sourceSessionId: child.id, destinationSessionId: fixture.sessionId, relation: 'manager',
            managerSourceSessionId: child.id, policyJson: JSON.stringify({ preset: 'important' }),
        } });
        await withAuthenticatedTestApp(registerSessionReadRoutes, async app => {
            const headers = { authorization: `Bearer ${fixture.token}`, 'x-happier-account-stored-content-protocol': '4' };
            const demand = { sessionIds: [fixture.sessionId, child.id, outside.id], underSessionId: fixture.sessionId,
                accessProjectionVersion: 1, includeSnapshot: true, includeTurns: false, includeMessages: false };
            const read = () => app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers, payload: demand });
            const batch = await read();
            expect(batch.statusCode, batch.body).toBe(200);
            const { results } = SessionReadBatchResponseV1Schema.parse(batch.json());
            expect(results).toMatchObject([
                { sessionId: fixture.sessionId, detail: { status: 200, body: { session: { metadata: sharedRoot, agentState: null, effectiveAccess: { level: 'view', sources: [] } } } } },
                { sessionId: child.id, detail: { status: 200, body: { session: { metadata: sharedChild, agentState: null } } } },
                { sessionId: outside.id, detail: { status: 404 } },
            ]);
            for (const result of results) {
                expect(result).not.toHaveProperty('turns');
                expect(result).not.toHaveProperty('messages');
                if (result.detail?.status === 200) for (const field of ['viewer', 'ownerMetadata', 'lastViewedSessionSeq', 'unreadSince', 'receivedRuleCount']) {
                    expect(result.detail.body.session).not.toHaveProperty(field);
                }
            }
            expect(batch.body).not.toContain('owner-only');
            expect(batch.body).not.toContain('owner-agent-state');
            const runtimeList = await app.inject({ method: 'POST', url: '/v2/sessions/query', headers,
                payload: SessionListQueryV1Schema.parse({ v: 1, storage: 'active', includeInactive: true,
                    scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [], underSessionId: fixture.sessionId }) });
            expect(runtimeList.statusCode, runtimeList.body).toBe(200);
            const runtimeRow = runtimeList.json().sessions.find((row: { id: string }) => row.id === fixture.sessionId);
            expect(runtimeRow.displayProjectionV1).toEqual({ ...displayProjectionV1, owner: undefined });
            expect(runtimeRow.displayProjectionV1).not.toHaveProperty('owner');
            expect(results[0]?.detail).toMatchObject({ status: 200, body: { session: {
                displayProjectionV1: { shared: sharedDisplay.envelope },
            } } });
            if (results[0]?.detail?.status === 200) expect(results[0].detail.body.session.displayProjectionV1).not.toHaveProperty('owner');
            const ownSnapshot = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [fixture.sessionId], accessProjectionVersion: 1,
                    includeSnapshot: true, includeTurns: false, includeMessages: false } });
            expect(ownSnapshot.statusCode, ownSnapshot.body).toBe(403);
            expect(ownSnapshot.json()).toEqual({ error: 'present_user_required' });
            const accountBound = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { ...headers, authorization: `Bearer ${fixture.accountToken}` }, payload: demand });
            expect(accountBound.statusCode, accountBound.body).toBe(200);
            expect(accountBound.json().results.map((result: { detail: { status: number } }) => result.detail.status)).toEqual([200, 200, 404]);
            const exact = await app.inject({ method: 'GET', url: `/v2/sessions/${child.id}?accessProjectionVersion=1`, headers });
            expect(exact.statusCode, exact.body).toBe(403);
            expect(exact.json()).toEqual({ error: 'present_user_required' });
            const unbounded = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [child.id], accessProjectionVersion: 1, includeSnapshot: true, includeTurns: false, includeMessages: false } });
            expect(unbounded.statusCode, unbounded.body).toBe(403);
            for (const mutation of [{ includeTurns: true }, { includeMessages: true }]) {
                const denied = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers, payload: { ...demand, ...mutation } });
                expect(denied.statusCode, denied.body).toBe(400);
            }
            const escaped = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { ...demand, underSessionId: child.id } });
            expect(escaped.statusCode, escaped.body).toBe(403);
            let detached = false;
            const stop = observeSqliteRequests({ after: async request => {
                const select = (request.args as { select?: { metadata?: boolean } } | undefined)?.select;
                if (detached || request.model !== 'Session' || request.action !== 'findMany' || select?.metadata !== true) return;
                detached = true;
                await db.sessionFollowEdge.delete({ where: { destinationSessionId_sourceKey_relation: {
                    destinationSessionId: edge.destinationSessionId, sourceKey: edge.sourceKey, relation: edge.relation,
                } } });
            } });
            try {
                const captured = await read();
                expect(captured.statusCode, captured.body).toBe(200);
                expect(captured.json().results[0]).toMatchObject({ sessionId: fixture.sessionId, detail: { status: 200 } });
                expect(captured.json().results[1]).toMatchObject({ sessionId: child.id, detail: { status: 404 } });
            } finally { stop(); }
        }, { authentication: 'real' });
    }, 120_000);

    it('admits only signed snapshot preparation while retaining captured operands, subtree and currentness', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const keyPair = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { accountId: owner.id, id: crypto.randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'snapshot-controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keyPair.publicKey) } });
        const createSession = (accountId = owner.id) => db.session.create({ data: { accountId, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }), active: true, lastActiveAt: new Date() } });
        const foreignOwner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const [source, child, outside, foreign] = await Promise.all([
            createSession(), createSession(), createSession(), createSession(foreignOwner.id),
        ]);
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: source.id, machineId: machine.id, data: 'source-key' } });
        await db.sessionFollowEdge.create({ data: { sourceSessionId: child.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: child.id }),
            destinationSessionId: source.id, relation: 'manager', managerSourceSessionId: child.id,
            policyJson: JSON.stringify({ preset: 'important' }) } });
        const pat = await auth.createApiToken({ accountId: owner.id, tokenId: crypto.randomUUID(), label: 'snapshot reader' });
        const principal = (await auth.verifyToken(pat.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Expected the real PAT principal');
        const homeId = await getOrCreateServerIdentityId();
        const mint = async (actionId: ActionId, input: unknown, options: { installed?: boolean; scoped?: boolean } = {}) => {
            const requestId = crypto.randomUUID();
            const target = { kind: 'machine' as const, machineId: machine.id };
            const parsedInput = normalizeStrictJsonValue(getActionSpec(actionId).inputSchema.parse(input));
            const envelope = { v: 1 as const, requestId, target, input: parsedInput };
            const routing = { serverIdentityId: homeId, accountId: owner.id, machineId: machine.id, actionId,
                requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target };
            if (options.installed) return auth.mintExternalActionExecutionAuthorization({ ...routing,
                authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
                sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: source.id, starterDepth: 0, turnDepth: 0 },
                    sourceTurnId: 'snapshot-turn', callerPermissionMode: 'default', causalPermissionAuthority: null, requestId },
                sessionActionSource: { machineId: machine.id, installationId: machine.installationId! },
            }, { input: parsedInput, resolveCurrentSessionMachine: async () => machine.id });
            const grant = options.scoped ? { ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: [], ids: [actionId] }, targets: { sessions: [source.id], machines: [machine.id] } }
                : { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] } };
            await db.accountApiToken.update({ where: { id: pat.tokenId }, data: { accessGrant: grant } });
            return auth.mintExternalActionExecutionAuthorization({ ...routing, principalId: principal.principalId,
                credentialId: principal.credentialId, grant }, { input: parsedInput });
        };
        await withAuthenticatedTestApp(app => {
            // Current publisher discovery is a transport boundary; source custody and grant checks remain real.
            app.decorate('resolveCurrentSessionMachine', async () => machine.id);
            registerSessionReadRoutes(app);
        }, async app => {
            const path = '/v2/sessions/read-batch';
            const demand = { sessionIds: [source.id, foreign.id], includeSnapshot: true, includeTurns: false,
                includeMessages: false, accessProjectionVersion: 1 };
            const read = (root: ExternalActionExecutionAuthorizationV1, body: unknown = demand,
                effectActionId: string = root.binding.actionId, signedBody: unknown = body) => app.inject({ method: 'POST', url: path,
                payload: body, headers: { 'x-happier-account-stored-content-protocol': '4',
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId, target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body: signedBody, privateKey: keyPair.secretKey }),
                } });
            for (const request of [
                { actionId: 'session.list', input: {} },
                { actionId: 'follow.preview', input: { receiver: { kind: 'account' }, filter: normalizeSessionListFilterV1({ show: 'sessions' }) } },
                { actionId: 'discussion.candidates.list', input: { source: 'sessions' } },
                { actionId: 'session.status.get', input: { sessionId: { selector: 'self', of: source.id } } },
                { actionId: 'session.targets.resolve', input: { actionId: 'session.goal.get', target: { selector: 'workers', of: source.id } } },
                { actionId: 'session.goal.set', input: { objective: 'Selected goal', sessionId: { selector: 'self', of: source.id } } },
            ] as const) {
                const root = await mint(request.actionId, request.input);
                const response = await read(root);
                expect(response.statusCode, `${request.actionId}: ${response.body}`).toBe(200);
                const { results } = SessionReadBatchResponseV1Schema.parse(response.json());
                expect(results).toMatchObject([{ sessionId: source.id, detail: { status: 200 } },
                    { sessionId: foreign.id, detail: { status: 404 } }]);
                expect(results.every(result => result.turns === undefined && result.messages === undefined)).toBe(true);
                const { includeTurns: _turns, ...withoutTurns } = demand;
                for (const body of [{ ...demand, includeTurns: true }, withoutTurns, { ...demand, includeMessages: true }]) {
                    const denied = await read(root, body);
                    expect(denied.statusCode, `${request.actionId}: ${denied.body}`).toBe(401);
                }
                expect((await read(root, demand, 'session.message.send')).statusCode).toBe(401);
            }
            const root = await mint('session.list', {});
            expect((await read(root, { ...demand, includeSnapshot: false, includeMessages: true })).statusCode).toBe(401);
            expect((await read(root, { ...demand, unrecognized: true })).statusCode).toBe(400);
            expect((await read(root, { ...demand, sessionIds: [outside.id] }, root.binding.actionId, demand)).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: path, payload: demand,
                headers: { authorization: `Bearer ${pat.token}`, 'x-happier-account-stored-content-protocol': '4' } })).statusCode).toBe(403);
            const unrelated = await mint('agents.models.list', { agentId: 'codex', backendTargetKey: 'agent:happier.agent.codex/codex' });
            expect((await read(unrelated)).statusCode).toBe(401);

            const scoped = await mint('session.goal.set', { objective: 'Scoped goal',
                sessionId: { selector: 'self', of: source.id } }, { scoped: true });
            expect((await read(scoped, { ...demand, sessionIds: [source.id] })).statusCode).toBe(200);
            expect((await read(scoped, { ...demand, sessionIds: [source.id, outside.id] })).statusCode).toBe(401);
            await db.accountApiToken.update({ where: { id: pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
            expect((await read(scoped, { ...demand, sessionIds: [outside.id] })).statusCode).toBe(401);

            const installed = await mint('session.list', { underSessionId: source.id }, { installed: true });
            const subtreeDemand = { ...demand, sessionIds: [child.id, outside.id], underSessionId: source.id };
            const subtree = await read(installed, subtreeDemand);
            expect(subtree.statusCode, subtree.body).toBe(200);
            expect(subtree.json().results).toMatchObject([{ sessionId: child.id, detail: { status: 200 } },
                { sessionId: outside.id, detail: { status: 404 } }]);
            const { underSessionId: _underSessionId, ...withoutSubtreeRoot } = subtreeDemand;
            expect((await read(installed, withoutSubtreeRoot)).statusCode).toBe(401);
            expect((await read(installed, { ...subtreeDemand, underSessionId: outside.id })).statusCode).toBe(401);
            await db.sessionFollowEdge.delete({ where: { destinationSessionId_sourceSessionId_relation: {
                destinationSessionId: source.id, sourceSessionId: child.id, relation: 'manager',
            } } });
            expect((await read(installed, subtreeDemand)).json().results[0]).toMatchObject({ sessionId: child.id, detail: { status: 404 } });
            await auth.revokeApiToken({ accountId: owner.id, tokenId: pat.tokenId });
            expect((await read(root)).statusCode).toBe(401);
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            expect((await read(installed, subtreeDemand)).statusCode).toBe(401);
        }, { authentication: 'real' });
    }, 120_000);

    it('serves compact V2 lists and full batched detail while the retired V1 list returns a typed 404', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            metadata: '{}', metadataVersion: 3, agentState: '{"requests":{}}', agentStateVersion: 4,
            encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(registerSessionReadRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
            const list = await app.inject({ method: 'GET', url: '/v2/sessions', headers });
            expect(list.statusCode, list.body).toBe(200);
            expect(list.json().sessions).toMatchObject([{ id: session.id, documents: 'omitted',
                metadataAudience: 'owner', agentStateDocument: 'omitted', metadataVersion: 3, agentStateVersion: 4 }]);
            expect(list.json().sessions[0]).not.toHaveProperty('metadata');
            expect(list.json().sessions[0]).not.toHaveProperty('agentState');
            const batch = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [session.id], accessProjectionVersion: 1, includeTurns: false } });
            expect(batch.statusCode, batch.body).toBe(200);
            const result = SessionReadBatchResponseV1Schema.parse(batch.json()).results[0];
            expect(result?.detail).toMatchObject({ status: 200, body: { session: {
                id: session.id, metadata: '{}', agentState: '{"requests":{}}', metadataVersion: 3, agentStateVersion: 4,
            } } });
            const retired = await app.inject({ method: 'GET', url: '/v1/sessions', headers });
            expect(retired.statusCode, retired.body).toBe(404);
            expect(retired.json()).toEqual({ error: 'Not found', path: '/v1/sessions', method: 'GET' });
        });
    });

    it('omits turns for explicit encryption-context demand while default full snapshots retain admitted turns', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'required-turn', status: 'completed',
            startedAt: 10n, updatedAt: 20n, terminalAt: 20n } });
        let turnReads = 0;
        const stopObserving = observeSqliteRequests({ before: request => {
            if (request.model === 'SessionTurn' && request.action === 'findMany') turnReads += 1;
        } });
        try {
            await withAuthenticatedTestApp(registerSessionReadRoutes, async app => {
                const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
                const read = (includeTurns?: boolean) => app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                    payload: { sessionIds: [session.id, 'unreadable'], accessProjectionVersion: 1,
                        ...(includeTurns === undefined ? {} : { includeTurns }) } });
                const complete = await read();
                expect(complete.statusCode, complete.body).toBe(200);
                expect(SessionReadBatchResponseV1Schema.parse(complete.json()).results[0]).toMatchObject({
                    turns: { status: 200, body: { turns: [{ turnId: 'required-turn' }] } },
                });
                expect(turnReads).toBeGreaterThan(0);
                turnReads = 0;
                const context = await read(false);
                expect(context.statusCode, context.body).toBe(200);
                const { results } = SessionReadBatchResponseV1Schema.parse(context.json());
                expect(results[0]?.detail).toEqual(complete.json().results[0].detail);
                expect(results[0]?.turns).toBeUndefined();
                expect(results[0]?.messages).toBeUndefined();
                expect(results[1]).toMatchObject({ sessionId: 'unreadable', detail: { status: 404 } });
                expect(results[1]?.turns).toBeUndefined();
                expect(turnReads).toBe(0);
            });
        } finally { stopObserving(); }
    });

    it('returns the existing admitted snapshot and first message page independently for mixed ids and modes', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const plain = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const encrypted = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: 'sealed-metadata', encryptionMode: 'e2ee' } });
        const denied = await db.session.create({ data: { accountId: foreign.id, tag: crypto.randomUUID(), metadata: 'private' } });
        const corrupt = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionMessage.createMany({ data: Array.from({ length: 151 }, (_, index) => ({
            sessionId: plain.id, seq: index + 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `input ${index}` } } },
        })) });
        await db.sessionMessage.createMany({ data: [
            { sessionId: plain.id, seq: 152, messageRole: 'event', sidechainId: 'child', content: { t: 'plain', v: { type: 'event' } } },
            { sessionId: plain.id, seq: 153, messageRole: 'unknown', content: { t: 'plain', v: { type: 'excluded row' } } },
            { sessionId: encrypted.id, seq: 1, messageRole: 'agent', content: { t: 'encrypted', c: 'sealed-content' } },
            { sessionId: corrupt.id, seq: 1, messageRole: 'user', content: { t: 'plain', v: null } },
        ] });
        // Corrupt retained storage is a database boundary fixture, not a current writer shape.
        await db.$executeRaw`UPDATE "SessionMessage" SET "content" = ${JSON.stringify({ t: 'unexpected' })} WHERE "sessionId" = ${corrupt.id}`;
        await db.sessionTurn.create({ data: { sessionId: plain.id, turnId: 'completed-turn', status: 'completed',
            startedAt: 10n, updatedAt: 20n, terminalAt: 20n } });
        const ids = [plain.id, encrypted.id, denied.id, 'missing-session', corrupt.id];
        await withAuthenticatedTestApp(registerSessionReadRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: ids, accessProjectionVersion: 1, includeSnapshot: true, includeMessages: true } });
            expect(response.statusCode).toBe(200);
            const { results } = response.json();
            expect(SessionReadBatchResponseV1Schema.safeParse(response.json()).success).toBe(true);
            expect(results.map((result: { sessionId: string }) => result.sessionId)).toEqual(ids);
            for (const result of results) {
                const detail = await app.inject({ method: 'GET', url: `/v2/sessions/${result.sessionId}?accessProjectionVersion=1`, headers });
                expect(result.detail).toEqual({ status: detail.statusCode, body: detail.json() });
                if (detail.statusCode !== 200) {
                    expect(result.turns).toBeUndefined();
                } else {
                    const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${result.sessionId}/turns`, headers });
                    expect(result.turns).toEqual({ status: turns.statusCode, body: turns.json() });
                }
                const messages = await app.inject({ method: 'GET', url: `/v1/sessions/${result.sessionId}/messages?scope=all&roles=user,agent,event`, headers });
                expect(result.messages).toEqual({ status: messages.statusCode, body: messages.json() });
            }
            expect(results[0].messages.body).toMatchObject({ hasMore: true, nextBeforeSeq: 3, nextAfterSeq: null });
            expect(results[0].turns.body.turns).toMatchObject([{ turnId: 'completed-turn', status: 'completed' }]);
            expect(results[0].messages.body.messages).toHaveLength(150);
            expect(results[0].messages.body.messages[0]).toMatchObject({ seq: 152, messageRole: 'event', sidechainId: 'child' });
            expect(results[1].messages.body.messages[0].content).toEqual({ t: 'encrypted', c: 'sealed-content' });
            expect(results[4]).toMatchObject({ detail: { status: 200 }, messages: { status: 503, body: { error: 'session_transcript_stored_content_unavailable' } } });

            const snapshot = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [plain.id], accessProjectionVersion: 1 } });
            expect(snapshot.json().results[0]).toMatchObject({ detail: { status: 200 }, turns: { status: 200 } });
            expect(snapshot.json().results[0].messages).toBeUndefined();
            const transcript = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [plain.id], accessProjectionVersion: 1, includeSnapshot: false, includeMessages: true } });
            expect(transcript.json().results[0].detail).toBeUndefined();
            expect(transcript.json().results[0].turns).toBeUndefined();
            expect(transcript.json().results[0].messages).toEqual(results[0].messages);
            const invalid = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [plain.id], includeSnapshot: false, includeMessages: false } });
            expect(invalid.statusCode).toBe(400);
            const restricted = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { ...headers, 'x-test-auth-token-kind': 'api_token' }, payload: { sessionIds: [plain.id] } });
            expect(restricted.statusCode).toBe(403);
        });
    });

    it('keeps Team continuation, unavailable authentication and revoked access local to their Session', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const binding = createSignedAccountContentBinding();
        const reader = await db.account.create({ data: { publicKey: binding.publicKey, encryptionMode: 'e2ee',
            contentPublicKey: Buffer.from(binding.contentPublicKey), contentPublicKeySig: Buffer.from(binding.contentPublicKeySig) } });
        const team = await db.team.create({ data: { name: 'Restricted', authenticationPolicy: {
            v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: reader.id, role: 'member' },
        ] });
        const protectedSession = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }), currentStorageState: 'hosted' } });
        await db.sessionTeamGrant.create({ data: { sessionId: protectedSession.id, teamId: team.id, accessLevel: 'view', effectiveAt: new Date() } });
        const own = await db.session.create({ data: { accountId: reader.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await withAuthenticatedTestApp(registerSessionReadRoutes, async app => {
            const read = async (qualified = false) => {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                    headers: { 'x-test-user-id': reader.id, 'x-happier-account-stored-content-protocol': '4',
                        ...(qualified ? { 'x-test-authentication-evidence': JSON.stringify([{ kind: 'home_method', methodId: 'key_challenge' }]) } : {}) },
                    payload: { sessionIds: [own.id, protectedSession.id], accessProjectionVersion: 1, includeMessages: true } });
                expect(response.statusCode, response.body).toBe(200);
                return SessionReadBatchResponseV1Schema.parse(response.json()).results;
            };
            const required = await read();
            expect(required[0]).toMatchObject({ detail: { status: 200 }, turns: { status: 200 }, messages: { status: 200 } });
            expect(required[1]).toMatchObject({ detail: { status: 403, body: { error: 'team_authentication_required' } },
                messages: { status: 403, body: { error: 'team_authentication_required' } } });
            vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '0');
            try {
                const unavailable = await read();
                expect(unavailable[0]?.detail?.status).toBe(200);
                expect(unavailable[1]).toMatchObject({ detail: { status: 503, body: { error: 'team_authentication_unavailable' } },
                    messages: { status: 503, body: { error: 'team_authentication_unavailable' } } });
            } finally { vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '1'); }
            const admitted = (await read(true))[1];
            expect(admitted).toMatchObject({ detail: { status: 200 }, turns: { status: 200 }, messages: { status: 200 } });
            const qualifiedHeaders = { 'x-test-user-id': reader.id, 'x-happier-account-stored-content-protocol': '4',
                'x-test-authentication-evidence': JSON.stringify([{ kind: 'home_method', methodId: 'key_challenge' }]) };
            const currentDetail = await app.inject({ method: 'GET', url: `/v2/sessions/${protectedSession.id}?accessProjectionVersion=1`, headers: qualifiedHeaders });
            expect(currentDetail.statusCode, currentDetail.body).toBe(200);
            expect(admitted?.detail).toEqual({ status: currentDetail.statusCode, body: currentDetail.json() });
            const legacyDetail = await app.inject({ method: 'GET', url: `/v2/sessions/${protectedSession.id}`, headers: qualifiedHeaders });
            expect(legacyDetail.statusCode, legacyDetail.body).toBe(404);
            const legacyBatch = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers: qualifiedHeaders,
                payload: { sessionIds: [protectedSession.id] } });
            expect(legacyBatch.statusCode, legacyBatch.body).toBe(200);
            expect(legacyBatch.json().results[0].detail).toEqual({ status: legacyDetail.statusCode, body: legacyDetail.json() });
            await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: reader.id } });
            expect((await read(true))[1]).toMatchObject({ detail: { status: 404, body: { error: 'Session not found' } },
                messages: { status: 404, body: { error: 'Session not found' } } });
        });
    });

    it('quarantines malformed retained component output without discarding another Session', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const healthy = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const malformed = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionMessage.create({ data: { id: '', sessionId: malformed.id, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained row without usable identity' } } } } });
        await withAuthenticatedTestApp(registerSessionReadRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' },
                payload: { sessionIds: [malformed.id, healthy.id], accessProjectionVersion: 1, includeMessages: true } });
            expect(response.statusCode, response.body).toBe(200);
            expect(SessionReadBatchResponseV1Schema.parse(response.json()).results).toMatchObject([
                { sessionId: malformed.id, detail: { status: 200 }, messages: { status: 503, body: { error: 'session_read_unavailable' } } },
                { sessionId: healthy.id, detail: { status: 200 }, messages: { status: 200, body: { messages: [] } } },
            ]);
        });
    });
});
