import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Socket } from "socket.io";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, ArtifactPrivateRevisionMetadataV1Schema, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0, openSessionDataKeyBundleV0, computeContentPublicKeyFingerprint } from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";
import { eventRouter } from '@/app/events/connectionEventRouter';
import { publicShareRoutes } from "@/app/api/routes/share/publicShareRoutes";
import { auth } from "@/app/auth/auth";
import { artifactUpdateHandler } from "@/app/api/socket/artifactUpdateHandler";
import { createAuthenticatedFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { deleteArtifact, migrateArtifactAccountEncryptionInTx, updateArtifactTx } from "./artifactWriteService";
import { applyArtifactRecipientKeyEnvelopesInTx, readArtifactHeaderForCallerInTx,
    isArtifactAudienceContainedInTx, setArtifactAccessGrantInTx, removeArtifactAccessGrantInTx } from './artifactAccessService';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { withSqliteReadSnapshot } from '@/storage/prisma';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, readWidgetSurfaceArtifactHeaderV1 } from '@happier-dev/protocol/widgets';
import { ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';

describe("Artifact document grants (real SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-artifact-grants-", initEncrypt: true, initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: "server_sealed" } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function plainAccount() {
        return db.account.create({ data: { encryptionMode: "plain" } });
    }

    async function plainArtifact(ownerAccountId: string) {
        const id = crypto.randomUUID();
        return db.artifact.create({ data: {
            id, accountId: ownerAccountId,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: "original" })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1,
        } });
    }

    const protocolHeaders = { "x-happier-account-stored-content-protocol": String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };

    function observeArtifactReads(after: (operation: string,
        args: NonNullable<Parameters<typeof db.artifact.findMany>[0]>, result: unknown) => void | Promise<void>) {
        return observeSqliteRequests({ after: async (request, result) => {
            if (request.model !== 'Artifact') return;
            // Prisma's request-adapter boundary exposes untyped query arguments.
            await after(request.action, request.args as NonNullable<Parameters<typeof db.artifact.findMany>[0]>, result);
        } });
    }

    it('keeps required Review Team grants while ordinary Team grants remain removable', async () => {
        const owner = await plainAccount();
        const team = await db.team.create({ data: { name: 'Required Review audience' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const required = await plainArtifact(owner.id);
        const optional = await plainArtifact(owner.id);
        await db.artifactGrant.createMany({ data: [
            { artifactId: required.id, principalKind: 'team', teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id, requiredByTeamPolicy: true },
            { artifactId: optional.id, principalKind: 'team', teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id },
        ] });
        const input = { actorAccountId: owner.id, principal: { kind: 'team' as const, teamId: team.id } };
        expect(await inTx(tx => removeArtifactAccessGrantInTx(tx, { ...input, artifactId: required.id }))).toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { ...input, artifactId: required.id, accessLevel: 'view' }))).toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
        expect(await inTx(tx => removeArtifactAccessGrantInTx(tx, { ...input, artifactId: optional.id }))).toMatchObject({ ok: true });
        expect(await db.artifactGrant.findFirst({ where: { artifactId: required.id, teamId: team.id } })).toMatchObject({ accessLevel: 'edit', requiredByTeamPolicy: true });
    });

    it('reviews missing Workflow audience through effective Team and Group access without writing grants', async () => {
        const owner = await plainAccount();
        const covered = await plainAccount();
        const missing = await plainAccount();
        await makeShareEligibleForTest(owner.id, [covered.id, missing.id]);
        const team = await db.team.create({ data: { name: 'Automation audience' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const coveredMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: covered.id, role: 'member' } });
        const missingMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: missing.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Automation group') } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: coveredMembership.id, nativeContribution: true } });
        const workflow = await plainArtifact(owner.id);
        await db.artifactGrant.create({ data: { principalKind: 'group', artifactId: workflow.id, teamGroupId: group.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const audience = [{ kind: 'account', accountId: covered.id }, { kind: 'account', accountId: missing.id },
            { kind: 'team', teamId: team.id }, { kind: 'group', teamId: team.id, groupId: group.id }];
        const before = await db.artifactGrant.findMany({ where: { artifactId: workflow.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const read = (actorAccountId: string) => app.inject({ method: 'GET',
                url: `/v1/artifacts/${workflow.id}/access/grants?requestedAudience=${encodeURIComponent(JSON.stringify(audience))}`,
                headers: { 'x-test-user-id': actorAccountId, ...protocolHeaders } });
            const review = await read(owner.id);
            expect(review.statusCode).toBe(200);
            expect(review.json().missingAudience).toEqual([audience[1], audience[2]]);
            // A Team can cover a selected individual even when no individual grant exists.
            await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: workflow.id, teamId: team.id,
                accessLevel: 'view', createdByAccountId: owner.id } });
            expect((await read(owner.id)).json().missingAudience).toEqual([]);
            // Only effective memberships count; suspended members do not turn a covered Team into a missing audience.
            await db.artifactGrant.deleteMany({ where: { artifactId: workflow.id, principalKind: 'team' } });
            await db.teamMembership.update({ where: { id: missingMembership.id }, data: { status: 'suspended' } });
            expect((await read(owner.id)).json().missingAudience).toEqual([audience[1]]);
            const denied = await read(covered.id);
            expect(denied.statusCode).toBe(403);
        });
        expect(await db.artifactGrant.findMany({ where: { artifactId: workflow.id } })).toEqual(before);
    });

    it('projects each visible Artifact Team audience in the list without confusing personal shares', async () => {
        const owner = await plainAccount();
        const member = await plainAccount();
        const team = await db.team.create({ data: { name: 'Release team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const shared = await plainArtifact(owner.id);
        const personal = await plainArtifact(owner.id);
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: shared.id, teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        const hiddenTeam = await db.team.create({ data: { name: 'Another owner Team' } });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: shared.id, teamId: hiddenTeam.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: personal.id, accountId: member.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=500',
                headers: { 'x-test-user-id': member.id, ...protocolHeaders } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: shared.id, sharedTeamIds: [team.id] }),
                expect.objectContaining({ id: personal.id, sharedTeamIds: [] }),
            ]));
            const exact = await app.inject({ method: 'GET', url: `/v1/artifacts/${shared.id}`,
                headers: { 'x-test-user-id': member.id, ...protocolHeaders } });
            expect(exact.statusCode).toBe(200);
            expect(exact.json()).toMatchObject({ id: shared.id, sharedTeamIds: [team.id] });
            await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: shared.id, accountId: member.id, accessLevel: 'view', createdByAccountId: owner.id } });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            const archived = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=500',
                headers: { 'x-test-user-id': member.id, ...protocolHeaders } });
            expect(archived.statusCode).toBe(200);
            expect(archived.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: shared.id, sharedTeamIds: [] })]));
        });
    });

    it.each(['team', 'account', 'group'] as const)('refuses a stored %s grant outside exact publication custody even when current readers overlap', async kind => {
        const actor = await plainAccount();
        const member = await plainAccount();
        const current = await db.team.create({ data: { name: 'Current publication Team' } });
        const foreign = await db.team.create({ data: { name: 'Overlapping foreign Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: current.id, accountId: actor.id, role: 'owner' },
            { teamId: current.id, accountId: member.id, role: 'member' },
            { teamId: foreign.id, accountId: actor.id, role: 'owner' },
        ] });
        const artifact = await plainArtifact(actor.id);
        const principal = { kind: 'team' as const, teamId: current.id };
        const admitted = () => inTx(tx => isArtifactAudienceContainedInTx(tx, { actorAccountId: actor.id, artifactId: artifact.id, principals: [principal] }));
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: actor.id, artifactId: artifact.id,
            principal, accessLevel: 'admin' }))).toMatchObject({ ok: true });
        expect(await admitted()).toBe(true);
        const outside: Parameters<typeof setArtifactAccessGrantInTx>[1]['principal'] = kind === 'team'
            ? { kind: 'team', teamId: foreign.id }
            : kind === 'account' ? { kind: 'account', accountId: member.id }
            : { kind: 'group', teamId: foreign.id, groupId: (await db.teamGroup.create({ data: {
                teamId: foreign.id, name: storedPlainPrivateLabel('Empty foreign group'),
            } })).id };
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: actor.id, artifactId: artifact.id,
            principal: outside,
            accessLevel: 'view' }))).toMatchObject({ ok: true });
        expect(await admitted()).toBe(false);
    });

    it('wakes the exact owned Session approval inventory after committed create, settlement and deletion, never stale writes or foreign bindings', async () => {
        const owner = await plainAccount();
        const other = await plainAccount();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const foreign = await db.session.create({ data: { accountId: other.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        // Call through the real event router; only observe its network publication intent.
        const emitted = vi.spyOn(eventRouter, 'emitUpdate');
        const wakes = () => emitted.mock.calls.map(([value]) => value).filter(value =>
            value.recipientFilter?.type === 'all-interested-in-session');
        try {
            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
                const id = crypto.randomUUID();
                const header = (sessionId: string, approvalStatus: string) => encodePlainArtifactStoredContent({
                    kind: 'target_action_approval.v1', sessionId, approvalStatus, title: 'Approval',
                });
                const create = async (artifactId: string, sessionId: string) => app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                    id: artifactId, header: header(sessionId, 'open'), body: encodePlainArtifactStoredContent({ receipt: true }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                } });
                expect((await create(id, session.id)).statusCode).toBe(200);
                expect(await db.accountChange.findFirst({ where: { accountId: owner.id, kind: 'session', entityId: session.id } }))
                    .toMatchObject({ sessionId: session.id });
                expect(wakes()).toHaveLength(1);
                expect(wakes()[0]).toMatchObject({ userId: owner.id,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: session.id },
                    payload: { body: { t: 'account-change', changeKinds: ['session'], entityIds: [session.id] } } });
                const stale = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers,
                    payload: { header: header(session.id, 'executed'), expectedHeaderVersion: 0 } });
                expect(stale.json()).toMatchObject({ success: false, error: 'version-mismatch' });
                expect(wakes()).toHaveLength(1);
                const settled = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers,
                    payload: { header: header(session.id, 'executed'), expectedHeaderVersion: 1 } });
                expect(settled.json()).toMatchObject({ success: true });
                expect(wakes()).toHaveLength(2);
                expect((await deleteArtifact({ actorUserId: owner.id, artifactId: id })).ok).toBe(true);
                expect(wakes()).toHaveLength(3);
                expect((await create(crypto.randomUUID(), foreign.id)).statusCode).toBe(200);
                expect(wakes()).toHaveLength(3);
                expect(await db.accountChange.findFirst({ where: { accountId: owner.id, kind: 'session', entityId: foreign.id } })).toBeNull();
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
                    .toMatchObject({ updatedAt: session.updatedAt, seq: session.seq, metadataVersion: session.metadataVersion });
            });
        } finally { emitted.mockRestore(); }
    });

    it('derives Plain approval selectors at the header CAS and resolves retained unknown state without read repair', async () => {
        const owner = await plainAccount();
        const id = crypto.randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                id, header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1', approvalStatus: 'open', sessionId: 'session' }),
                body: encodePlainArtifactStoredContent({ receipt: true }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                approvalState: 'executed', approvalSessionId: 'forged-session',
            } });
            expect(created.statusCode, created.body).toBe(200);
            expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ approvalState: 'open', approvalSessionId: 'session' });
            const stale = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers, payload: {
                header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1', approvalStatus: 'executed', sessionId: 'session' }),
                expectedHeaderVersion: 0, approvalState: 'executed',
            } });
            expect(stale.json()).toMatchObject({ success: false, error: 'version-mismatch' });
            expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ approvalState: 'open', headerVersion: 1 });
            await db.artifact.update({ where: { id }, data: { approvalState: null, body: new Uint8Array([0xff]) } });
            const unknown = await app.inject({ method: 'GET', url: '/v1/artifacts?' + new URLSearchParams({
                kinds: '["approval_request.v1"]', approvalStates: '["open"]' }), headers });
            expect(unknown.json()).toMatchObject({ items: [], coverage: { status: 'partial', unclassifiedCount: 1 } });
            const legacy = await app.inject({ method: 'GET', url: '/v1/artifacts?unclassified=approval', headers });
            expect(legacy.json().items.map((row: { id: string }) => row.id)).toEqual([id]);
            const before = await db.artifact.findUniqueOrThrow({ where: { id } });
            for (let iteration = 0; iteration < 2; iteration++) {
                const classified = await app.inject({ method: 'POST', url: '/v1/artifacts/query-hints/batch', headers, payload: { items: [{
                    artifactId: id, kind: 'v1:other:approval_request.v1', approvalState: 'executed', approvalSessionId: 'forged-session', expectedHeaderVersion: 1,
                }] } });
                expect(classified.json()).toEqual({ items: [{ artifactId: id, success: true }] });
            }
            expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ approvalState: 'open', approvalSessionId: 'session',
                headerVersion: 1, bodyVersion: 1, body: before.body, updatedAt: before.updatedAt, seq: before.seq });
            const stateOnly = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers,
                payload: { approvalState: 'executed', expectedHeaderVersion: 1 } });
            expect(stateOnly.json()).toEqual({ success: true });
            expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ approvalState: 'open', approvalSessionId: 'session',
                updatedAt: before.updatedAt, seq: before.seq });
            const known = await app.inject({ method: 'GET', url: '/v1/artifacts?' + new URLSearchParams({
                kinds: '["approval_request.v1"]', approvalStates: '["open"]' }), headers });
            expect(known.json().items.map((row: { id: string }) => row.id)).toEqual([id]);
            expect(known.json().coverage).toEqual({ status: 'complete', unclassifiedCount: 0 });
        });
    });

    it('keeps opaque approval hints atomic with header CAS, preserves body-only writes and invalidates absent replacement hints', async () => {
        const ownerKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        const key = tweetnacl.randomBytes(32);
        const header = await sealSessionDataKeyBundleV0({ kind: 'approval_request.v1', approvalStatus: 'open', sessionId: 'session' }, key);
        const body = await sealSessionDataKeyBundleV0({ receipt: true }, key);
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            kind: 'v1:other:approval_request.v1', approvalState: 'open', approvalSessionId: 'session', header, body, headerVersion: 1, bodyVersion: 1,
            dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ recipientPublicKey: ownerKeys.publicKey, dataKey: key, randomBytes: tweetnacl.randomBytes })) } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const bodyOnly = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { body: privacyKit.encodeBase64(body), expectedBodyVersion: 1 } });
            expect(bodyOnly.json()).toMatchObject({ success: true });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ approvalState: 'open', approvalSessionId: 'session' });
            const next = { header: privacyKit.encodeBase64(header), expectedHeaderVersion: 1,
                kind: 'v1:other:approval_request.v1', approvalState: 'executed', approvalSessionId: 'session' };
            const changed = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers, payload: next });
            expect(changed.json()).toMatchObject({ success: true, headerVersion: 2 });
            const stale = await app.inject({ method: 'POST', url: '/v1/artifacts/query-hints/batch', headers,
                payload: { items: [{ artifactId: artifact.id, kind: next.kind, approvalState: 'open', expectedHeaderVersion: 1 }] } });
            expect(stale.json()).toMatchObject({ items: [{ success: false, error: 'version-mismatch' }] });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ approvalState: 'executed', approvalSessionId: 'session', headerVersion: 2 });
            const unknown = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { header: privacyKit.encodeBase64(header), expectedHeaderVersion: 2 } });
            expect(unknown.json()).toMatchObject({ success: true, headerVersion: 3 });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ kind: null, approvalState: null, approvalSessionId: null, bodyVersion: 2 });
        });
    });

    it.each(['create', 'update'] as const)('preserves private content with an oversized optional kind during plain %s', async operation => {
        const owner = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        const id = operation === 'create' ? crypto.randomUUID() : artifact.id;
        const exactKind = 'long.type.'.repeat(24);
        const header = encodePlainArtifactStoredContent({ kind: exactKind, title: 'retained private content' });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const response = await app.inject({ method: 'POST', url: operation === 'create' ? '/v1/artifacts' : `/v1/artifacts/${id}`,
                headers, payload: operation === 'create' ? { id, header, body: encodePlainArtifactStoredContent({ value: 'original' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } : { header, expectedHeaderVersion: 1 } });
            expect(response.statusCode, response.body).toBe(200);
            const read = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json().kind).toBeNull();
            expect(decodePlainArtifactStoredContent(read.json().header)).toEqual({ kind: exactKind, title: 'retained private content' });
            expect(decodePlainArtifactStoredContent(read.json().body)).toEqual({ value: 'original' });
            const refused = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers,
                payload: { kind: `v1:other:${exactKind}`, expectedHeaderVersion: read.json().headerVersion } });
            expect(refused.statusCode).toBe(400); // Explicit invalid public hints remain strict.
        });
        expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ kind: null,
            headerVersion: operation === 'create' ? 1 : 2, bodyVersion: 1 });
    });

    it('counts scoped legacy rows for empty exact demand without opening private bytes', async () => {
        const owner = await plainAccount();
        const foreign = await plainAccount();
        const own = await plainArtifact(owner.id);
        await db.artifact.update({ where: { id: own.id }, data: { header: new Uint8Array([0xff]), body: new Uint8Array([0xff]) } });
        const shared = await plainArtifact(foreign.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: shared.id, accountId: owner.id,
            accessLevel: 'view', createdByAccountId: foreign.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            for (const [suffix, count] of [['', 2], [`&ownerAccountId=${owner.id}`, 1]] as const) {
                const response = await app.inject({ method: 'GET', url: `/v1/artifacts?kinds=%5B%5D&includeBody=true${suffix}`, headers });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toEqual({ items: [], hasUnclassified: true,
                    coverage: { status: 'partial', unclassifiedCount: count, reason: 'unclassified_legacy_rows' } });
            }
        });
    });

    it('counts exact coverage across authorized legacy rows without opening unrelated content', async () => {
        const owner = await plainAccount();
        const foreign = await plainAccount();
        const nullKind = await plainArtifact(owner.id);
        const coarse = await plainArtifact(owner.id);
        await db.artifact.update({ where: { id: coarse.id }, data: { kind: 'other' } });
        const noExact = await plainArtifact(owner.id);
        await db.artifact.update({ where: { id: noExact.id }, data: { kind: 'v1:other:' } });
        const shared = await plainArtifact(foreign.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: shared.id, accountId: owner.id,
            accessLevel: 'view', createdByAccountId: foreign.id } });
        await plainArtifact(foreign.id);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const exact = () => app.inject({ method: 'GET', url: '/v1/artifacts?kinds=%5B%22account_notice.v1%22%5D', headers });
            const discovery = () => app.inject({ method: 'GET', url: `/v1/artifacts?unclassified=true&ownerAccountId=${owner.id}`, headers });
            const initial = await exact();
            expect(initial.statusCode, initial.body).toBe(200);
            const allAuthorized = await app.inject({ method: 'GET', url: '/v1/artifacts?unclassified=true', headers });
            expect(allAuthorized.statusCode, allAuthorized.body).toBe(200);
            expect(allAuthorized.json().items.map((row: { id: string }) => row.id).sort()).toEqual([nullKind.id, coarse.id, shared.id].sort());
            expect(allAuthorized.json()).toMatchObject({ coverage: { status: 'partial', unclassifiedCount: 3 } });
            expect(initial.json()).toEqual({ items: [], hasUnclassified: true,
                coverage: { status: 'partial', unclassifiedCount: 3, reason: 'unclassified_legacy_rows' } });
            expect((await discovery()).json()).toMatchObject({ coverage: { status: 'partial', unclassifiedCount: 2 } });
            // Completeness is an authorization/index fact even when private bytes are unreadable.
            await db.artifact.update({ where: { id: shared.id }, data: { header: new Uint8Array([0xff]) } });
            expect((await exact()).json()).toMatchObject({ coverage: { status: 'partial', unclassifiedCount: 3 } });
            const repaired = await app.inject({ method: 'POST', url: '/v1/artifacts/query-hints/batch', headers,
                payload: { items: [nullKind, coarse].map(row => ({ artifactId: row.id,
                    kind: 'v1:other:workflow-definition.v1', expectedHeaderVersion: row.headerVersion })) } });
            expect(repaired.statusCode, repaired.body).toBe(200);
            expect(repaired.json().items.every((item: { success: boolean }) => item.success)).toBe(true);
            expect((await discovery()).json()).toEqual({ items: [], hasUnclassified: false,
                coverage: { status: 'complete', unclassifiedCount: 0 } });
            expect((await exact()).json()).toMatchObject({ coverage: { status: 'partial', unclassifiedCount: 1 } });
            await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: shared.id } });
            expect((await exact()).json()).toEqual({ items: [], hasUnclassified: false,
                coverage: { status: 'complete', unclassifiedCount: 0 } });
        });
    });

    it('counts only effective direct Team and Group grants through access lifecycle changes', async () => {
        const owner = await plainAccount();
        const reader = await plainAccount();
        const rows = await Promise.all([plainArtifact(owner.id), plainArtifact(owner.id), plainArtifact(owner.id)]);
        const team = await db.team.create({ data: { name: 'Coverage Team' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
        const other = await plainAccount();
        const otherMember = await db.teamMembership.create({ data: { teamId: team.id, accountId: other.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Coverage Group') } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: member.id, nativeContribution: true } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: otherMember.id, nativeContribution: true } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: rows[0].id, accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: rows[1].id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactGrant.create({ data: { principalKind: 'group', artifactId: rows[2].id, teamGroupId: group.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const read = async () => {
                const response = await app.inject({ method: 'GET', url: '/v1/artifacts?kinds=%5B%22absent.v1%22%5D',
                    headers: { 'x-test-user-id': reader.id, ...protocolHeaders } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json().coverage;
            };
            expect(await read()).toMatchObject({ status: 'partial', unclassifiedCount: 3 });
            await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
            expect(await read()).toMatchObject({ unclassifiedCount: 2 });
            await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: null } });
            await db.teamMembership.update({ where: { id: member.id }, data: { status: 'suspended' } });
            expect(await read()).toMatchObject({ unclassifiedCount: 1 });
            await db.teamMembership.update({ where: { id: member.id }, data: { status: 'active' } });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            expect(await read()).toMatchObject({ unclassifiedCount: 1 });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
            await db.artifactGrant.deleteMany({ where: { principalKind: 'account', accountId: reader.id } });
            expect(await read()).toMatchObject({ unclassifiedCount: 2 });
            await db.account.update({ where: { id: reader.id }, data: { status: 'suspended' } });
            expect(await read()).toEqual({ status: 'complete', unclassifiedCount: 0 });
        });
    });

    it('negotiates query-hint support and refuses its batch transport under build denial', async () => {
        const owner = await plainAccount();
        await withAuthenticatedTestApp(app => { artifactsRoutes(app); featuresRoutes(app); }, async app => {
            const supported = await app.inject({ method: 'GET', url: '/v1/features' });
            expect(supported.statusCode, supported.body).toBe(200);
            const previous = process.env.HAPPIER_BUILD_FEATURES_DENY;
            try {
                process.env.HAPPIER_BUILD_FEATURES_DENY = 'artifacts.queryHints';
                const denied = await app.inject({ method: 'POST', url: '/v1/artifacts/query-hints/batch',
                    headers: { 'x-test-user-id': owner.id, ...protocolHeaders }, payload: { items: [] } });
                expect(denied.statusCode, denied.body).toBe(404);
                expect(denied.json()).toEqual({ error: 'not_found' });
            } finally {
                if (previous === undefined) delete process.env.HAPPIER_BUILD_FEATURES_DENY;
                else process.env.HAPPIER_BUILD_FEATURES_DENY = previous;
            }
            expect(readServerEnabledBit(FeaturesResponseSchema.parse(supported.json()), 'artifacts.queryHints')).toBe(true);
        });
    });

    it('classifies 1001 owner headers in one real HTTP batch without reading bodies', async () => {
        const owner = await plainAccount();
        const ids = Array.from({ length: 1001 }, () => crypto.randomUUID());
        const header = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'account_notice.v1' }));
        await db.artifact.createMany({ data: ids.map(id => ({ id, accountId: owner.id, header,
            body: new Uint8Array([0xff]), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1 })) });
        let bodyReads = 0;
        const transaction = db.$transaction;
        // Observe the genuine Prisma boundary without replacing any admission/query logic.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Parameters<typeof updateArtifactTx>[0]) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    const delegate = Reflect.get(inner, property, innerReceiver);
                    if (property !== 'artifact') return typeof delegate === 'function' ? delegate.bind(inner) : delegate;
                    return new Proxy(inner.artifact, { get(model, operation, modelReceiver) {
                        const method = Reflect.get(model, operation, modelReceiver);
                        if (typeof operation !== 'string' || !operation.startsWith('find')) return method;
                        return async (...queryArgs: Parameters<typeof inner.artifact.findMany>) => {
                            const result = await Reflect.apply(method, model, queryArgs);
                            if (!queryArgs[0]?.select || queryArgs[0].select.body) bodyReads += Array.isArray(result) ? result.length : result ? 1 : 0;
                            return result;
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const started = performance.now();
                const response = await app.inject({ method: 'POST', url: '/v1/artifacts/query-hints/batch',
                    headers: { 'x-test-user-id': owner.id, ...protocolHeaders }, payload: { items: ids.map(artifactId => ({
                        artifactId, kind: 'v1:other:account_notice.v1', expectedHeaderVersion: 1 })) } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json().items).toEqual(ids.map(artifactId => ({ artifactId, success: true })));
                console.info(JSON.stringify({ operation: 'artifact-kind-batch', items: ids.length, elapsedMs: Math.round(performance.now() - started), bodyReads }));
            }, { bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 });
            expect(bodyReads).toBe(0);
            expect(await db.artifact.count({ where: { accountId: owner.id, kind: 'v1:other:account_notice.v1' } })).toBe(1001);
        } finally { db.$transaction = transaction; }
    }, 180_000);

    it('labels an unclassified row without changing content recency or publishing a change no reader can see', async () => {
        const owner = await plainAccount();
        const old = await plainArtifact(owner.id);
        await db.artifact.update({ where: { id: old.id }, data: { updatedAt: new Date(0) } });
        const newer = await plainArtifact(owner.id);
        const before = await db.artifact.findUniqueOrThrow({ where: { id: old.id } });
        // Observe the real router's publication intent only.
        const emitted = vi.spyOn(eventRouter, 'emitUpdate');
        try {
            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
                const list = () => app.inject({ method: 'GET', url: '/v1/artifacts?limit=2', headers });
                expect((await list()).json().map((row: { id: string }) => row.id)).toEqual([newer.id, old.id]);
                emitted.mockClear();
                const repaired = await app.inject({ method: 'POST', url: `/v1/artifacts/${old.id}`, headers,
                    payload: { kind: 'v1:other:workflow-definition.v1', expectedHeaderVersion: 1 } });
                expect(repaired.statusCode, repaired.body).toBe(200);
                expect((await list()).json().map((row: { id: string }) => row.id)).toEqual([newer.id, old.id]);
            });
            // A label changes no header, body or recency, and kind-selected readers already reach
            // unclassified rows: no recipient update and no AccountChange wake (each one made every
            // connected client re-read headers, Discussions attention and Run windows per row).
            expect(emitted.mock.calls.map(([value]) => (value.payload.body as { t: string }).t)).toEqual([]);
        } finally { emitted.mockRestore(); }
        expect(await db.artifact.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
            updatedAt: before.updatedAt, seq: before.seq, headerVersion: before.headerVersion, bodyVersion: before.bodyVersion,
            header: before.header, body: before.body });
        expect(await db.accountChange.count({ where: { artifactId: old.id, accountId: owner.id } })).toBe(0);
        expect(await db.artifact.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ kind: 'v1:other:workflow-definition.v1' });
    });

    it('classifies metadata in ordered batches with per-item CAS and current authorization', async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const viewer = await plainAccount();
        const foreign = await plainAccount();
        const selected = await plainArtifact(owner.id);
        const stale = await plainArtifact(owner.id);
        const hidden = await plainArtifact(foreign.id);
        await db.artifactGrant.createMany({ data: [
            { principalKind: 'account', artifactId: selected.id, accountId: editor.id, accessLevel: 'edit', createdByAccountId: owner.id },
            { principalKind: 'account', artifactId: selected.id, accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id },
        ] });
        await db.artifact.update({ where: { id: selected.id }, data: { updatedAt: new Date(0), body: new Uint8Array([0xff]) } });
        const before = await db.artifact.findUniqueOrThrow({ where: { id: selected.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const items = [
                { artifactId: selected.id, kind: 'v1:other:workflow-definition.v1', expectedHeaderVersion: 1 },
                { artifactId: stale.id, kind: 'v1:other:workflow-definition.v1', expectedHeaderVersion: 0 },
                { artifactId: hidden.id, kind: 'v1:other:workflow-definition.v1', expectedHeaderVersion: 1 },
            ];
            const result = await app.inject({ method: 'POST', url: '/v1/artifacts/query-hints/batch', headers, payload: { items } });
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toEqual({ items: [
                { artifactId: selected.id, success: true },
                { artifactId: stale.id, success: false, error: 'version-mismatch' },
                { artifactId: hidden.id, success: false, error: 'Artifact not found' },
            ] });
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts/query-hints/batch', headers,
                payload: { items: [items[0]] } })).json()).toEqual({ items: [{ artifactId: selected.id, success: true }] });
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts/query-hints/batch', headers, payload: { items: [] } })).json())
                .toEqual({ items: [] });
            await db.artifact.create({ data: { id: 'kinds', accountId: owner.id, header: before.header, body: stale.body,
                dataEncryptionKey: before.dataEncryptionKey, headerVersion: 1, bodyVersion: 1 } });
            const retainedId = await app.inject({ method: 'POST', url: '/v1/artifacts/kinds', headers,
                payload: { kind: 'v1:other:workflow-definition.v1', expectedHeaderVersion: 1 } });
            expect(retainedId.statusCode, retainedId.body).toBe(200);
        });
        expect(await db.artifact.findUniqueOrThrow({ where: { id: selected.id } })).toMatchObject({
            kind: 'v1:other:workflow-definition.v1', updatedAt: before.updatedAt, seq: before.seq,
            headerVersion: before.headerVersion, bodyVersion: before.bodyVersion, header: before.header, body: before.body });
        // A label of an unclassified row publishes nothing; recipients' results are unchanged.
        expect(await db.accountChange.count({ where: { artifactId: selected.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { artifactId: { in: [stale.id, hidden.id] } } })).toBe(0);
    });

    it('classifies an opened header with CAS without loading a body at the write owner', async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const viewer = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifact.update({ where: { id: artifact.id }, data: { body: new Uint8Array([0xff]) } });
        await db.artifactGrant.createMany({ data: [
            { principalKind: 'account', artifactId: artifact.id, accountId: editor.id, accessLevel: 'edit', createdByAccountId: owner.id },
            { principalKind: 'account', artifactId: artifact.id, accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id },
        ] });
        let bodies = 0;
        const classify = (actorUserId: string, expectedHeaderVersion: number) => inTx(tx => {
            const observed = new Proxy(tx, { get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== 'artifact') return typeof value === 'function' ? value.bind(target) : value;
                return new Proxy(tx.artifact, { get(delegate, operation, delegateReceiver) {
                    const query = Reflect.get(delegate, operation, delegateReceiver);
                    if (typeof query !== 'function') return query;
                    return async (...args: unknown[]) => {
                        const selection = args[0];
                        if (typeof operation === 'string' && operation.startsWith('find') && selection && typeof selection === 'object'
                            && 'select' in selection && selection.select && typeof selection.select === 'object'
                            && 'body' in selection.select && selection.select.body === true) bodies++;
                        return Reflect.apply(query, delegate, args);
                    };
                } });
            } });
            return updateArtifactTx(observed, { actorUserId, artifactId: artifact.id,
                kind: 'v1:other:workflow-definition.v1', expectedHeaderVersion });
        });
        expect(await classify(viewer.id, 1)).toMatchObject({ ok: false, error: 'not-found' });
        const stale = await classify(owner.id, 0);
        expect(stale).toMatchObject({ ok: false, error: 'version-mismatch', current: { headerVersion: 1 } });
        if (!stale.ok && 'current' in stale) expect(stale.current).not.toHaveProperty('body');
        expect(await classify(editor.id, 1)).toMatchObject({ ok: true });
        expect(bodies).toBe(0);
        const after = await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
        expect(after).toMatchObject({ kind: 'v1:other:workflow-definition.v1', headerVersion: 1, bodyVersion: 1,
            header: artifact.header, body: new Uint8Array([0xff]), seq: artifact.seq });
        expect(await classify(owner.id, 1)).toMatchObject({ ok: true, didWrite: false, recipientUpdates: [] });
        expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toEqual(after);
        await db.artifact.update({ where: { id: artifact.id }, data: {
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'x'.repeat(183) })), headerVersion: 2, kind: null } });
        const oversized = await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
        expect(await classify(owner.id, 2)).toMatchObject({ ok: true });
        expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toEqual(oversized);
        expect(bodies).toBe(0);
    });

    it('projects every recipient publication from one bodyless read, whatever the audience size', async () => {
        const owner = await plainAccount();
        const update = async (recipientCount: number) => {
            const artifact = await plainArtifact(owner.id);
            const recipients = await Promise.all(Array.from({ length: recipientCount }, () => plainAccount()));
            await db.artifactGrant.createMany({ data: recipients.map(recipient => ({ principalKind: 'account', artifactId: artifact.id,
                accountId: recipient.id, accessLevel: 'view' as const, createdByAccountId: owner.id })) });
            const reads = { operations: 0, bodies: 0 };
            const result = await inTx(tx => {
                const observed = new Proxy(tx, { get(target, property, receiver) {
                    const value: unknown = Reflect.get(target, property, receiver);
                    if (typeof value === 'function') return value.bind(target);
                    if (value === null || typeof value !== 'object') return value;
                    return new Proxy(value, { get(delegate, operation, delegateReceiver) {
                        const query: unknown = Reflect.get(delegate, operation, delegateReceiver);
                        if (typeof query !== 'function' || typeof operation !== 'string' || !operation.startsWith('find')) return query;
                        return async (...args: unknown[]) => {
                            reads.operations++;
                            const selection = args[0];
                            if (property === 'artifact' && selection && typeof selection === 'object' && 'select' in selection
                                && selection.select && typeof selection.select === 'object'
                                && 'body' in selection.select && selection.select.body === true) reads.bodies++;
                            return Reflect.apply(query, delegate, args);
                        };
                    } });
                } });
                return updateArtifactTx(observed, { actorUserId: owner.id, artifactId: artifact.id,
                    body: { bytes: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'next' })), expectedVersion: 1 } });
            });
            if (!result.ok) throw new Error('update failed');
            expect(new Set(result.recipientUpdates.map(recipient => recipient.accountId)))
                .toEqual(new Set([owner.id, ...recipients.map(recipient => recipient.id)]));
            return reads;
        };
        const small = await update(2);
        const large = await update(8);
        // Only the writer's own current row carries a body; recipient custody adds no per-recipient reads.
        expect(large).toEqual(small);
        expect(small.bodies).toBe(1);
    });

    it('selects exact kinds before paging and repairs only owner legacy headers without selecting bodies', async () => {
        const owner = await plainAccount();
        const foreign = await plainAccount();
        const ownLegacy = await plainArtifact(owner.id);
        await db.artifact.update({ where: { id: ownLegacy.id }, data: { kind: 'other' } });
        const sharedLegacy = await plainArtifact(foreign.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: sharedLegacy.id, accountId: owner.id,
            accessLevel: 'edit', createdByAccountId: foreign.id } });
        const template = { accountId: owner.id, header: ownLegacy.header, body: new Uint8Array([0xff]),
            dataEncryptionKey: ownLegacy.dataEncryptionKey, headerVersion: 1, bodyVersion: 1 };
        await db.artifact.createMany({ data: Array.from({ length: 1100 }, () => ({ ...template,
            id: crypto.randomUUID(), kind: 'v1:other:unrelated.v1' })) });
        await db.artifact.create({ data: { ...template, id: crypto.randomUUID(), kind: 'v1:other:ACCOUNT_NOTICE.v1' } });
        const notice = await db.artifact.create({ data: { ...template, id: crypto.randomUUID(),
            kind: 'v1:other:account_notice.v1', updatedAt: new Date(0) } });
        const bundle = await db.artifact.create({ data: { ...template, id: crypto.randomUUID(),
            kind: 'v1:skill:prompt_bundle.v2', updatedAt: new Date(0) } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const reads: string[] = [];
            let bodies = 0;
            const stopObserving = observeArtifactReads((operation, args, result) => {
                if (operation !== 'findMany') return;
                // The real Artifact query selects ids alongside these projected bytes.
                const rows = result as Array<{ id: string }>;
                if (args.select?.header) reads.push(...rows.map(row => row.id));
                if (args.select?.body) bodies += rows.length;
            });
            try {
                // Eight coarse families per exact kind crosses SQLite's portable bind boundary.
                const query = encodeURIComponent(JSON.stringify(['account_notice.v1', 'prompt_bundle.v2',
                    ...Array.from({ length: 130 }, (_, index) => `absent.${index}.v1`)]));
                const selected = await app.inject({ method: 'GET', url: `/v1/artifacts?kinds=${query}&limit=2`, headers });
                expect(selected.statusCode, selected.body).toBe(200);
                expect(selected.json()).toMatchObject({ items: [
                    { kindHint: expect.any(String) }, { kindHint: expect.any(String) }], hasUnclassified: true });
                expect(selected.json().items.map((row: { id: string }) => row.id).sort()).toEqual([notice.id, bundle.id].sort());
                expect(new Set(reads)).toEqual(new Set([notice.id, bundle.id]));
                reads.length = 0;
                const legacy = await app.inject({ method: 'GET', url: `/v1/artifacts?unclassified=true&ownerAccountId=${owner.id}&limit=1`, headers });
                expect(legacy.statusCode, legacy.body).toBe(200);
                expect(legacy.json()).toMatchObject({ items: [{ id: ownLegacy.id }], hasUnclassified: true });
                expect(new Set(reads)).toEqual(new Set([ownLegacy.id]));
                expect(bodies).toBe(0);
                reads.length = 0;
                const coarseLegacy = await app.inject({ method: 'GET', url: `/v1/artifacts?unclassified=coarse&ownerAccountId=${owner.id}`, headers });
                expect(coarseLegacy.json()).toEqual({ items: [], hasUnclassified: false,
                    coverage: { status: 'complete', unclassifiedCount: 0 } });
                expect(reads).toEqual([]);
                const coarse = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=other&limit=1', headers });
                expect(coarse.json().hasUnclassified).toBe(true); // the authorized shared null row remains unknown
                for (const suffix of [`kind=other&kinds=${query}`, `unclassified=true&kinds=${query}`, 'unclassified=true&includeBody=true']) {
                    expect((await app.inject({ method: 'GET', url: `/v1/artifacts?${suffix}`, headers })).statusCode).toBe(400);
                }
            } finally {
                stopObserving();
            }
        });
    });

    it('projects selected headers with current audience and per-id revocation without opening bodies', async () => {
        const owner = await plainAccount();
        const reader = await plainAccount();
        const granted = await plainArtifact(owner.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: granted.id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.publicSessionShare.create({ data: { artifactId: granted.id, createdByUserId: owner.id,
            keyDerivation: 'fragment_v1', tokenHash: new Uint8Array(32) } });
        // Header acquisition must survive an unreadable body; full reads remain refused.
        await db.artifact.update({ where: { id: granted.id }, data: { body: new Uint8Array([0xff]) } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const read = () => app.inject({ method: 'POST', url: '/v1/artifacts/read',
                headers: { 'x-test-user-id': reader.id, ...protocolHeaders },
                payload: { artifactIds: [granted.id, 'missing-header'], projection: 'headers' } });
            const response = await read();
            expect(response.statusCode, response.body).toBe(200);
            expect(ArtifactReadHeadersBatchResponseV1Schema.parse(response.json())).toMatchObject({ projection: 'headers', items: [
                { artifactId: granted.id, ok: true, artifact: { access: 'view', publicAudience: 'retained', bodyVersion: 1 } },
                { artifactId: 'missing-header', ok: false, error: 'artifact_not_found', status: 404, retryable: false },
            ] });
            expect(response.json().items[0].artifact).not.toHaveProperty('body');
            expect(response.json().items[0]).not.toHaveProperty('recipientCensus');
            const full = await app.inject({ method: 'POST', url: '/v1/artifacts/read',
                headers: { 'x-test-user-id': reader.id, ...protocolHeaders }, payload: { artifactIds: [granted.id] } });
            expect(full.statusCode, full.body).toBe(200);
            expect(full.json().items).toEqual([{ artifactId: granted.id, ok: false,
                error: 'artifact_content_unavailable', status: 409, retryable: false }]);
            await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: granted.id } });
            expect((await read()).json().items[0]).toMatchObject({ artifactId: granted.id, ok: false, error: 'artifact_not_found' });
        });
    });

    it('finishes selected headers admitted before revocation without selecting bodies', async () => {
        const owner = await plainAccount();
        const reader = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let reads = 0;
            let bodyReads = 0;
            const stopObserving = observeArtifactReads(async (operation, args) => {
                if (operation !== 'findMany') return;
                if (args.select?.body === true) bodyReads++;
                reads++;
                if (reads === 1) { enter(); await release; }
            });
            const request = { method: 'POST' as const, url: '/v1/artifacts/read',
                headers: { 'x-test-user-id': reader.id, ...protocolHeaders },
                payload: { artifactIds: [artifact.id], projection: 'headers' } };
            const response = app.inject(request);
            try {
                expect(await Promise.race([reached.then(() => 'capture'), response.then(() => 'response')])).toBe('capture');
                await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: artifact.id, accountId: reader.id } });
                resume();
                const result = await response;
                expect(result.statusCode, result.body).toBe(200);
                expect(ArtifactReadHeadersBatchResponseV1Schema.parse(result.json()).items)
                    .toMatchObject([{ artifactId: artifact.id, ok: true, artifact: { id: artifact.id, access: 'view' } }]);
                expect(reads).toBe(1);
                const next = await app.inject(request);
                expect(ArtifactReadHeadersBatchResponseV1Schema.parse(next.json()).items)
                    .toEqual([{ artifactId: artifact.id, ok: false, error: 'artifact_not_found', status: 404, retryable: false }]);
                expect(bodyReads).toBe(0);
            } finally {
                resume(); await response;
                stopObserving();
            }
        });
    });

    it('reads selected identities beyond the provider bind boundary without widening access', async () => {
        const owner = await plainAccount();
        const reader = await plainAccount();
        const foreign = await plainAccount();
        const owned = await plainArtifact(reader.id);
        const granted = await plainArtifact(owner.id);
        const hidden = await plainArtifact(foreign.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: granted.id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const artifactIds = [owned.id, granted.id, hidden.id, ...Array.from({ length: 34997 }, (_, index) => `missing-${index}`)];
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v1/artifacts/read',
                headers: { 'x-test-user-id': reader.id, ...protocolHeaders }, payload: { artifactIds } });
            expect(response.statusCode, response.body).toBe(200);
            const items = response.json().items;
            expect(items.map((item: { artifactId: string }) => item.artifactId)).toEqual(artifactIds);
            expect(items.slice(0, 2)).toMatchObject([
                { ok: true, recipientCensus: null, artifact: { access: 'owner', body: encodePlainArtifactStoredContent({ value: 'original' }) } },
                { ok: true, recipientCensus: null, artifact: { access: 'view', body: encodePlainArtifactStoredContent({ value: 'original' }) } },
            ]);
            expect(items.slice(2).every((item: { ok: boolean; error: string }) => !item.ok && item.error === 'artifact_not_found')).toBe(true);
        });
    });

    it('keeps encrypted recipient census ordering across portable account-query chunks', async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const recipients = Array.from({ length: 1000 }, (_, index) => `${index < 500 ? 'z' : 'a'}-${owner.id}-${index}`);
        await db.account.createMany({ data: recipients.map(id => ({ id, encryptionMode: 'plain' as const })) });
        const dataKey = tweetnacl.randomBytes(32);
        const envelope = new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
            recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes }));
        const artifactIds = [`a-${owner.id}`, `z-${owner.id}`];
        const body = new TextEncoder().encode('opaque encrypted body');
        await db.artifact.createMany({ data: artifactIds.map(id => ({ id, accountId: owner.id,
            header: new TextEncoder().encode('opaque encrypted header'), body, dataEncryptionKey: envelope,
            headerVersion: 1, bodyVersion: 1 })) });
        await db.artifactGrant.createMany({ data: recipients.map((accountId, index) => ({ principalKind: 'account',
            artifactId: artifactIds[index < 500 ? 0 : 1], accountId, accessLevel: 'view' as const, createdByAccountId: owner.id,
        })) });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headersOnly = await app.inject({ method: 'POST', url: '/v1/artifacts/read',
                headers: { 'x-test-user-id': owner.id, ...protocolHeaders }, payload: { artifactIds, projection: 'headers' } });
            expect(headersOnly.statusCode, headersOnly.body).toBe(200);
            const headerItems = ArtifactReadHeadersBatchResponseV1Schema.parse(headersOnly.json()).items;
            expect(headerItems).toMatchObject(artifactIds.map(artifactId => ({ artifactId, ok: true,
                artifact: { encryptionMode: 'e2ee', dataEncryptionKey: privacyKit.encodeBase64(envelope) } })));
            const response = await app.inject({ method: 'POST', url: '/v1/artifacts/read',
                headers: { 'x-test-user-id': owner.id, ...protocolHeaders }, payload: { artifactIds } });
            expect(response.statusCode, response.body).toBe(200);
            const items = response.json().items;
            for (const [index, item] of items.entries()) {
                expect(item).toMatchObject({ artifactId: artifactIds[index], ok: true,
                    artifact: { body: privacyKit.encodeBase64(body), encryptionMode: 'e2ee' },
                    recipientCensus: { dataEncryptionKey: privacyKit.encodeBase64(envelope) } });
                expect(item.recipientCensus.recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId))
                    .toEqual([owner.id, ...recipients.slice(index * 500, (index + 1) * 500)].sort());
            }
            await db.artifactGrant.createMany({ data: recipients.slice(500).map(accountId => ({
                principalKind: 'account', artifactId: artifactIds[0]!, accountId,
                accessLevel: 'view' as const, createdByAccountId: owner.id,
            })) });
            const census = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactIds[0]}/access/recipients`,
                headers: { 'x-test-user-id': owner.id, ...protocolHeaders } });
            expect(census.statusCode, census.body).toBe(200);
            expect(census.json().dataEncryptionKey).toBe(privacyKit.encodeBase64(envelope));
            expect(census.json().recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId))
                .toEqual([owner.id, ...recipients].sort());
        });
    });

    it('serves only widget-area layouts through the existing kind filter and exact consumer schema', async () => {
        const owner = await plainAccount();
        const foreign = await plainAccount();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const createLayout = async (accountId: string, layoutId: string) => {
                const surface = { serverId: 'home', accountId, owner: { kind: 'project' as const, projectId: 'project', layoutId } };
                const layout = { v: 1 as const, surface, name: layoutId, items: [] };
                const id = buildWidgetSurfaceArtifactIdV1(surface);
                const result = await app.inject({ method: 'POST', url: '/v1/artifacts',
                    headers: { ...headers, 'x-test-user-id': accountId }, payload: { id, kind: 'widget_area_layout',
                        header: encodePlainArtifactStoredContent(buildWidgetSurfaceArtifactHeaderV1(layout)),
                        body: encodePlainArtifactStoredContent({ body: JSON.stringify(layout) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } });
                expect(result.statusCode, result.body).toBe(200);
                return id;
            };
            const id = await createLayout(owner.id, 'mine');
            await createLayout(foreign.id, 'foreign');
            const unrelated = await plainArtifact(owner.id);
            const result = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=widget_area_layout&limit=500&includeBody=true', headers });
            expect(result.statusCode, result.body).toBe(200);
            const page = result.json();
            expect(page).toMatchObject({ items: [{ id, kind: 'widget_area_layout' }], hasUnclassified: true });
            expect(page.items).toHaveLength(1);
            expect(readWidgetSurfaceArtifactHeaderV1({ artifactId: id, header: decodePlainArtifactStoredContent(page.items[0].header) }))
                .toMatchObject({ title: 'mine', surface: { accountId: owner.id } });
            expect(page.items.some((row: { id: string }) => row.id === unrelated.id)).toBe(false);
        });
    });

    it('filters coarse kinds, reports authorized unclassified rows, and backfills without changing content', async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const viewer = await plainAccount();
        const stranger = await plainAccount();
        const unknown = await plainArtifact(owner.id);
        await plainArtifact(stranger.id);
        await db.artifactGrant.createMany({ data: [
            { principalKind: 'account', artifactId: unknown.id, accountId: editor.id, accessLevel: 'edit', createdByAccountId: owner.id },
            { principalKind: 'account', artifactId: unknown.id, accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id },
        ] });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const id = crypto.randomUUID();
            const create = await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                id, kind: 'skill', header: encodePlainArtifactStoredContent({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }),
                body: encodePlainArtifactStoredContent({ value: 'skill' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            } });
            expect(create.statusCode, create.body).toBe(200);
            const list = async (accountId: string) => app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill&limit=1',
                headers: { 'x-test-user-id': accountId, ...protocolHeaders } });
            const filtered = await list(owner.id);
            expect(filtered.statusCode, filtered.body).toBe(200);
            expect(filtered.json()).toMatchObject({ items: [{ id, kind: 'skill' }], hasUnclassified: true });
            const denied = await app.inject({ method: 'POST', url: `/v1/artifacts/${unknown.id}`,
                headers: { 'x-test-user-id': viewer.id, ...protocolHeaders }, payload: { kind: 'other', expectedHeaderVersion: 1 } });
            expect(denied.statusCode, denied.body).toBe(404);
            const conflict = await app.inject({ method: 'POST', url: `/v1/artifacts/${unknown.id}`, headers,
                payload: { kind: 'other', expectedHeaderVersion: 0 } });
            expect(conflict.json()).toMatchObject({ success: false, error: 'version-mismatch', currentHeaderVersion: 1 });
            const set = await app.inject({ method: 'POST', url: `/v1/artifacts/${unknown.id}`,
                headers: { 'x-test-user-id': editor.id, ...protocolHeaders }, payload: { kind: 'other', expectedHeaderVersion: 1 } });
            expect(set.statusCode, set.body).toBe(200);
            expect(set.json()).toEqual({ success: true });
            const stored = await db.artifact.findUniqueOrThrow({ where: { id: unknown.id } });
            expect(stored).toMatchObject({ kind: 'v1:other:workflow-definition.v1', headerVersion: unknown.headerVersion, bodyVersion: unknown.bodyVersion,
                header: unknown.header, body: unknown.body, dataEncryptionKey: unknown.dataEncryptionKey });
            expect(stored.seq).toBe(unknown.seq);
            expect(await db.accountChange.count({ where: { artifactId: unknown.id } })).toBe(0);
            const changedAccount = await db.account.findUniqueOrThrow({ where: { id: owner.id } });
            const repeat = await app.inject({ method: 'POST', url: `/v1/artifacts/${unknown.id}`, headers,
                payload: { kind: 'skill', expectedHeaderVersion: 1 } });
            expect(repeat.json()).toEqual({ success: true });
            // Plain mode derives the hint from its actual header, even on a metadata-only call.
            expect(await db.artifact.findUniqueOrThrow({ where: { id: unknown.id } })).toEqual(stored);
            expect(await db.account.findUniqueOrThrow({ where: { id: owner.id } })).toEqual(changedAccount);
            const exact = await app.inject({ method: 'GET', url: `/v1/artifacts/${unknown.id}`, headers });
            expect(exact.json()).toMatchObject({ kind: 'other' });
            const batch = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers, payload: { artifactIds: [unknown.id] } });
            expect(batch.json()).toMatchObject({ items: [{ ok: true, artifact: { kind: 'other' } }] });
            expect((await list(owner.id)).json()).toMatchObject({ items: [{ id }], hasUnclassified: false });
            expect((await list(viewer.id)).json()).toEqual({ items: [], hasUnclassified: false });
            const legacy = await app.inject({ method: 'GET', url: '/v1/artifacts', headers });
            expect(Array.isArray(legacy.json())).toBe(true);
            expect(legacy.json()).toHaveLength(2);
        });
    });

    it('keeps filtered items and the unclassified flag in one snapshot during backfill', async () => {
        const owner = await plainAccount();
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'Skill' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            // Pause the real first filtered DB query, then classify through the canonical transaction owner.
            const stopObserving = observeArtifactReads(async (operation, args) => {
                if (operation !== 'findMany') return;
                if (!paused && args.where?.OR?.some(predicate => predicate.kind === 'skill')) { paused = true; enter(); await release; }
            });
            const response = app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill', headers });
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                const classified = await inTx(tx => updateArtifactTx(tx, { actorUserId: owner.id,
                    artifactId: artifact.id, kind: 'skill', expectedHeaderVersion: 1 }));
                expect(classified).toMatchObject({ ok: true });
                resume();
                const result = await response;
                expect(result.statusCode, result.body).toBe(200);
                const page = result.json();
                expect(page.hasUnclassified || page.items.some((row: { id: string }) => row.id === artifact.id)).toBe(true);
            } finally {
                resume(); await response;
                stopObserving();
            }
        });
    });

    it.each(['revoked', 'classified'] as const)('captures an empty exact page and legacy count until the next request when its last witness is %s', async transition => {
        const owner = await plainAccount();
        const reader = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            const stopObserving = observeArtifactReads(async operation => {
                if (operation !== 'aggregate') return;
                if (!paused) { paused = true; enter(); await release; }
            });
            const request = { method: 'GET' as const, url: '/v1/artifacts?kinds=%5B%22workflow-definition.v1%22%5D',
                headers: { 'x-test-user-id': reader.id, ...protocolHeaders } };
            const response = app.inject(request);
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                if (transition === 'revoked') {
                    await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: artifact.id, accountId: reader.id } });
                } else {
                    expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: owner.id, artifactId: artifact.id,
                        kind: 'v1:other:workflow-definition.v1', expectedHeaderVersion: 1 }))).toMatchObject({ ok: true });
                }
                resume();
                const result = await response;
                expect(result.statusCode, result.body).toBe(200);
                expect(result.json()).toMatchObject({ items: [], hasUnclassified: true,
                    coverage: { status: 'partial', unclassifiedCount: 1 } });
                const next = await app.inject(request);
                expect(next.statusCode, next.body).toBe(200);
                expect(next.json()).toMatchObject({ hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } });
                expect(next.json().items.map((row: { id: string }) => row.id)).toEqual(transition === 'revoked' ? [] : [artifact.id]);
            } finally {
                resume(); await response;
                stopObserving();
            }
        });
    });

    it('keeps completeness conservative when the first unclassified grant is revoked and another remains', async () => {
        const owner = await plainAccount();
        const recipient = await plainAccount();
        const first = await plainArtifact(owner.id);
        const second = await plainArtifact(owner.id);
        await db.artifactGrant.createMany({ data: [first, second].map(artifact => ({ principalKind: 'account', artifactId: artifact.id,
            accountId: recipient.id, accessLevel: 'view' as const, createdByAccountId: owner.id })) });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            // Revoke a grant after the real aggregate snapshot, preserving a second live grant.
            const stopObserving = observeArtifactReads(async (operation, args) => {
                if (operation !== 'aggregate') return;
                if (!paused && args.where?.kind === null) {
                    paused = true; enter(); await release;
                }
            });
            const response = app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill',
                headers: { 'x-test-user-id': recipient.id, ...protocolHeaders } });
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: first.id, accountId: recipient.id } });
                resume();
                const result = await response;
                expect(result.statusCode, result.body).toBe(200);
                expect(result.json()).toEqual({ items: [], hasUnclassified: true });
            } finally {
                resume(); await response;
                stopObserving();
            }
        });
    });

    it.each(['prompt', 'v1:prompt:prompt_doc.v2'])('invalidates an opaque stored kind %s when its header changes without an optional hint', async storedKind => {
        const ownerKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        const key = tweetnacl.randomBytes(32);
        const header = await sealSessionDataKeyBundleV0({ kind: 'prompt_doc.v2', title: 'Old prompt' }, key);
        const body = await sealSessionDataKeyBundleV0({ body: 'Old body' }, key);
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id, kind: storedKind,
            header, body, headerVersion: 1, bodyVersion: 1,
            dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ recipientPublicKey: ownerKeys.publicKey, dataKey: key, randomBytes: tweetnacl.randomBytes })) } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const unsafeHint = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { kind: 'skill', body: privacyKit.encodeBase64(body), expectedBodyVersion: 1 } });
            expect(unsafeHint.statusCode, unsafeHint.body).toBe(400);
            const staleHint = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { kind: 'skill', expectedHeaderVersion: 0, body: privacyKit.encodeBase64(body), expectedBodyVersion: 1 } });
            expect(staleHint.json()).toMatchObject({ success: false, error: 'version-mismatch' });
            const bodyOnly = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { body: privacyKit.encodeBase64(await sealSessionDataKeyBundleV0({ body: 'Edited body' }, key)), expectedBodyVersion: 1 } });
            expect(bodyOnly.json()).toMatchObject({ success: true, bodyVersion: 2 });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ kind: storedKind });
            const response = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { header: privacyKit.encodeBase64(await sealSessionDataKeyBundleV0({ kind: 'long.type.'.repeat(24) }, key)), expectedHeaderVersion: 1 } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ success: true, headerVersion: 2 });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ kind: null, bodyVersion: 2 });
            const filtered = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill', headers });
            expect(filtered.json()).toEqual({ items: [], hasUnclassified: true });
        });
    });

    it.each(['owner', 'grantee'] as const)('qualifies an exact admitted header from one Artifact row (%s)', async caller => {
        const owner = await plainAccount();
        const grantee = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: grantee.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await withSqliteReadSnapshot(async tx => {
            const delegate = tx.artifact;
            const original = delegate.findFirst.bind(delegate);
            let reads = 0;
            // Preserve Prisma's bound delegate; instrument only the database boundary.
            Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    reads += 1;
                    return await original(...args);
                } });
            try {
                const result = await readArtifactHeaderForCallerInTx(tx, { artifactId: artifact.id,
                    actorAccountId: caller === 'owner' ? owner.id : grantee.id });
                expect(result).toMatchObject({ ok: true, artifact: { id: artifact.id, encryptionMode: 'plain', access: caller === 'owner' ? 'owner' : 'view' } });
                if (!result.ok) throw new Error('Expected an admitted Artifact header');
                expect(decodePlainArtifactStoredContent(privacyKit.encodeBase64(result.artifact.header))).toEqual({ kind: 'workflow-definition.v1' });
                // One row captures both the admitted header and its access.
                expect(reads).toBe(1);
            } finally {
                Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true, value: original });
            }
        });
    });

    it('finishes an admitted Artifact body and denies the next request after grant revocation', async () => {
        const owner = await plainAccount();
        const recipient = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: recipient.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const url = `/v1/artifacts/${artifact.id}`;
            const headers = { 'x-test-user-id': recipient.id, ...protocolHeaders };
            expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            // Pause after the genuine DB row capture; all policy and bytes stay real.
            const stopObserving = observeArtifactReads(async (operation, args) => {
                if (operation !== 'findFirst') return;
                if (!paused && args.select?.body === true) {
                    paused = true; enter(); await release;
                }
            });
            const response = app.inject({ method: 'GET', url, headers });
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: artifact.id, accountId: recipient.id } });
                resume();
                const result = await response;
                expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
                expect(result.statusCode, result.body).toBe(200);
                expect(decodePlainArtifactStoredContent(result.json().body)).toEqual({ value: 'original' });
            } finally {
                resume(); await response;
                stopObserving();
            }
        });
    });

    it('projects retained public audience on authenticated reads with public sharing disabled, until expiry or deletion', async () => {
        const owner = await plainAccount();
        const stranger = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        const publication = await db.publicSessionShare.create({ data: {
            artifactId: artifact.id, createdByUserId: owner.id, keyDerivation: 'fragment_v1',
            tokenHash: createHash('sha256').update(crypto.randomUUID()).digest(),
            maxUses: 1, useCount: 1,
        } });
        const previous = process.env.HAPPIER_BUILD_FEATURES_DENY;
        process.env.HAPPIER_BUILD_FEATURES_DENY = 'sharing.public';
        try {
            await withAuthenticatedTestApp(app => { artifactsRoutes(app); publicShareRoutes(app); }, async app => {
                const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
                const detailUrl = `/v1/artifacts/${artifact.id}`;
                const readAudience = async (expected: 'retained' | 'none') => {
                    const list = await app.inject({ method: 'GET', url: '/v1/artifacts', headers });
                    expect(list.statusCode, list.body).toBe(200);
                    expect(list.json()).toMatchObject([{ id: artifact.id, publicAudience: expected,
                        headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion }]);
                    const response = await app.inject({ method: 'GET', url: detailUrl, headers });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ publicAudience: expected });
                    const batch = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                        payload: { artifactIds: [artifact.id] } });
                    expect(batch.statusCode, batch.body).toBe(200);
                    expect(batch.json().items).toMatchObject([{ artifactId: artifact.id, ok: true,
                        artifact: { publicAudience: expected } }]);
                };
                expect((await app.inject({ method: 'GET',
                    url: `/v1/public-shares?subjectKind=artifact&subjectId=${artifact.id}`, headers })).statusCode).toBe(404);
                await readAudience('retained');
                for (const url of [detailUrl, `${detailUrl}/access/grants`]) {
                    expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': stranger.id } })).statusCode).toBe(404);
                    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
                }
                await db.publicSessionShare.update({ where: { id: publication.id }, data: { expiresAt: new Date(0) } });
                await readAudience('none');
                await db.publicSessionShare.update({ where: { id: publication.id }, data: { expiresAt: null } });
                await readAudience('retained');
                await db.publicSessionShare.delete({ where: { id: publication.id } });
                await readAudience('none');
            });
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_BUILD_FEATURES_DENY;
            else process.env.HAPPIER_BUILD_FEATURES_DENY = previous;
        }
    });

    it.each(['plain', 'e2ee'] as const)('publishes revision-bound private attribution in the real %s header-only HTTP inventory', async mode => {
        const ownerKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(ownerKeys.publicKey) : {}) } });
        const artifactId = crypto.randomUUID();
        const contentKey = tweetnacl.randomBytes(32);
        const privateKey = tweetnacl.randomBytes(32);
        const source = { sessionId: 'source-session', runId: 'source-run', machineId: 'source-machine', path: 'private/output.ts', sha: 'a'.repeat(64) };
        const provenance = { savedBy: { kind: 'agent' as const, accountId: owner.id, sessionId: source.sessionId }, source };
        const metadata = ArtifactPrivateRevisionMetadataV1Schema.parse({ v: 1, artifactId, bodyVersion: 2, provenance });
        const seal = async (value: unknown, key: Uint8Array) => new Uint8Array(mode === 'plain'
            ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)) : await sealSessionDataKeyBundleV0(value, key));
        const wrap = (key: Uint8Array, publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes }));
        await db.artifact.create({ data: { id: artifactId, accountId: owner.id,
            header: await seal({ title: 'Published output' }, contentKey),
            body: await seal({ body: 'export const output = 1;' }, contentKey),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) : wrap(contentKey, ownerKeys.publicKey),
            provenance: await seal(metadata, privateKey),
            provenanceDataEncryptionKey: mode === 'plain' ? null : wrap(privateKey, ownerKeys.publicKey), headerVersion: 1, bodyVersion: 2,
        } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/artifacts', headers: { 'x-test-user-id': owner.id, ...protocolHeaders } });
            expect(response.statusCode, response.body).toBe(200);
            const rows = response.json();
            const wire = rows.find((row: { id: string }) => row.id === artifactId);
            expect(wire).not.toHaveProperty('body');
            expect(wire).toMatchObject({ bodyVersion: 2, provenance: expect.any(String) });
            if (mode === 'plain') {
                expect(ArtifactPrivateRevisionMetadataV1Schema.parse(decodePlainArtifactStoredContent(wire.provenance))).toEqual(metadata);
                expect(decodePlainArtifactStoredContent(wire.header)).toEqual({ title: 'Published output' });
            }
            if (mode === 'e2ee') {
                const ownerPrivateKey = openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(wire.provenanceDataEncryptionKey), recipientSecretKeyOrSeed: ownerKeys.secretKey });
                expect(ownerPrivateKey).toEqual(privateKey);
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(wire.provenance), ownerPrivateKey!)).toMatchObject({ status: 'authenticated', value: metadata });
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(wire.header), contentKey)).toMatchObject({ status: 'authenticated', value: { title: 'Published output' } });
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(wire.provenance), contentKey)).toEqual({ status: 'authentication_failed' });
                const viewerKeys = tweetnacl.box.keyPair();
                const viewer = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(viewerKeys.publicKey) } });
                await db.artifactGrant.create({ data: { principalKind: 'account', artifactId, accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id } });
                await db.artifactKeyEnvelope.create({ data: { artifactId, recipientAccountId: viewer.id,
                    encryptedDataKey: wrap(contentKey, viewerKeys.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(viewerKeys.publicKey) } });
                const contentOnly = await app.inject({ method: 'GET', url: '/v1/artifacts', headers: { 'x-test-user-id': viewer.id, ...protocolHeaders } });
                expect(contentOnly.statusCode).toBe(200);
                expect(contentOnly.json()[0]).toMatchObject({ id: artifactId, bodyVersion: 2, provenance: null, provenanceDataEncryptionKey: null });
                expect(contentOnly.json()[0]).not.toHaveProperty('body');
                const viewerContentKey = openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(contentOnly.json()[0].dataEncryptionKey), recipientSecretKeyOrSeed: viewerKeys.secretKey });
                expect(viewerContentKey).toEqual(contentKey);
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(contentOnly.json()[0].header), viewerContentKey!)).toMatchObject({ status: 'authenticated', value: { title: 'Published output' } });
                await db.artifactKeyEnvelope.update({ where: { artifactId_recipientAccountId: { artifactId, recipientAccountId: viewer.id } },
                    data: { encryptedProvenanceDataKey: wrap(privateKey, viewerKeys.publicKey) } });
                const granted = await app.inject({ method: 'GET', url: '/v1/artifacts', headers: { 'x-test-user-id': viewer.id, ...protocolHeaders } });
                expect(granted.statusCode).toBe(200);
                expect(granted.json()[0].provenanceDataEncryptionKey).not.toBe(wire.provenanceDataEncryptionKey);
                expect(granted.json()[0]).not.toHaveProperty('body');
                const viewerPrivateKey = openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(granted.json()[0].provenanceDataEncryptionKey), recipientSecretKeyOrSeed: viewerKeys.secretKey });
                expect(viewerPrivateKey).toEqual(privateKey);
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(granted.json()[0].provenance), viewerPrivateKey!)).toMatchObject({ status: 'authenticated', value: metadata });
            }
        });
    });

    it.each(["account", "team", "group"] as const)("reports committed %s self-revocation without disclosing the remaining grants", async kind => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const admin = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const remaining = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const dataKey = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const artifact = await db.artifact.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, header: new Uint8Array([1]), body: new Uint8Array([2]),
            dataEncryptionKey: wrap(owner.contentPublicKey!), headerVersion: 1, bodyVersion: 1,
        } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: remaining.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        await makeShareEligibleForTest(owner.id, admin.id);
        const team = await db.team.create({ data: { name: "Self-revocation team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "member" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: admin.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Administrators") } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            nativeContribution: true } });
        const principal = kind === "account" ? { kind, accountId: admin.id }
            : kind === "team" ? { kind, teamId: team.id } : { kind, teamId: team.id, groupId: group.id };
        const { readArtifactRecipientCensusInTx, resolveArtifactAccessInTx, setArtifactAccessGrantInTx } = await import("./artifactAccessService");
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, {
            actorAccountId: owner.id, artifactId: artifact.id, principal, accessLevel: "admin",
        }))).toMatchObject({ ok: true });
        const census = await inTx(tx => readArtifactRecipientCensusInTx(tx, { actorAccountId: owner.id, artifactId: artifact.id }));
        if (!census.ok) throw new Error(census.error);
        for (const recipient of [admin, remaining]) {
            const fingerprint = census.value.recipients.find(row => row.recipientAccountId === recipient.id)!.contentPublicKeyFingerprint!;
            await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: recipient.id,
                encryptedDataKey: wrap(recipient.contentPublicKey!), recipientContentPublicKeyFingerprint: fingerprint } });
        }
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const revoked = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal } });
            expect(await inTx(tx => resolveArtifactAccessInTx(tx, { actorAccountId: admin.id, artifactId: artifact.id }))).toBeNull();
            expect(await db.artifactKeyEnvelope.findMany({ where: { artifactId: artifact.id }, select: { recipientAccountId: true } }))
                .toEqual([{ recipientAccountId: remaining.id }]);
            expect(revoked.statusCode).toBe(200);
            expect(revoked.json()).toEqual({ artifactId: artifact.id, ownerAccountId: owner.id, access: null, grants: [], changed: true });
            for (const url of [grantsUrl, `/v1/artifacts/${artifact.id}`, `/v1/artifacts/${artifact.id}/access/recipients`]) {
                expect((await app.inject({ method: "GET", url, headers: { "x-test-user-id": admin.id } })).statusCode).toBe(404);
            }
            const ownerList = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": owner.id } });
            expect(ownerList.json()).toMatchObject({ access: "owner", grants: [
                { principal: { kind: "account", accountId: remaining.id }, accessLevel: "view" },
            ] });
        });
    });

    it("projects remaining Team access after self-revocation and refuses further grant writes", async () => {
        const owner = await plainAccount();
        const admin = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        const team = await db.team.create({ data: { name: "Remaining access" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: admin.id, role: "member" } });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: artifact.id, teamId: team.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: admin.id,
            accessLevel: "admin", createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const payload = { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id } };
            const removed = await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": admin.id }, payload });
            expect(removed.statusCode).toBe(200);
            expect(removed.json()).toMatchObject({ access: "view", changed: true, grants: [
                { principal: { kind: "team", teamId: team.id }, accessLevel: "view" },
            ] });
            expect((await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": admin.id }, payload })).statusCode).toBe(403);
            const repeated = await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": owner.id }, payload });
            expect(repeated.statusCode).toBe(200);
            expect(repeated.json()).toMatchObject({ access: "owner", changed: false });
        });
    });

    it("rotates a shared Artifact key and retains only prepared recipients with live access and current keys", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const recipients = await Promise.all([0, 1, 2].map(() => db.account.create({
            data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() },
        })));
        const oldKey = tweetnacl.randomBytes(32);
        const replacementKey = tweetnacl.randomBytes(32);
        const wrap = (key: Uint8Array, publicKey: Uint8Array) => Buffer.from(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        })).toString('base64');
        const sourceOwnerEnvelope = wrap(oldKey, owner.contentPublicKey!);
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new Uint8Array([1, 2, 3]), body: new Uint8Array([4, 5, 6]),
            dataEncryptionKey: Buffer.from(sourceOwnerEnvelope, 'base64'), headerVersion: 1, bodyVersion: 1,
        } });
        for (const recipient of recipients) {
            await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: recipient.id,
                accessLevel: "view", createdByAccountId: owner.id } });
        }
        const { readArtifactRecipientCensusInTx } = await import("./artifactAccessService");
        const census = await inTx(tx => readArtifactRecipientCensusInTx(tx, { actorAccountId: owner.id, artifactId: artifact.id }));
        if (!census.ok) throw new Error(census.error);
        const prepared = recipients.map(recipient => ({ recipientAccountId: recipient.id,
            recipientContentPublicKeyFingerprint: census.value.recipients.find(row => row.recipientAccountId === recipient.id)!.contentPublicKeyFingerprint!,
            encryptedDataKey: wrap(replacementKey, recipient.contentPublicKey!),
        }));
        for (const envelope of prepared) {
            await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: envelope.recipientAccountId,
                encryptedDataKey: privacyKit.decodeBase64(wrap(oldKey, recipients.find(row => row.id === envelope.recipientAccountId)!.contentPublicKey!)),
                recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } });
        }
        await db.account.update({ where: { id: recipients[1]!.id }, data: createSignedAccountContentBinding() });
        await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: artifact.id, accountId: recipients[2]!.id } });
        const directive = { action: "migrate" as const, items: [{ artifactId: artifact.id,
            expectedHeaderVersion: 1, expectedBodyVersion: 1,
            expectedDataEncryptionKey: sourceOwnerEnvelope,
            header: privacyKit.encodeBase64(new Uint8Array([7, 8, 9])), body: privacyKit.encodeBase64(new Uint8Array([10, 11, 12])),
            dataEncryptionKey: wrap(replacementKey, owner.contentPublicKey!), recipientKeyEnvelopes: prepared, revisions: [], blobs: [],
        }] };
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee",
            directive: { ...directive, items: [{ ...directive.items[0]!, expectedDataEncryptionKey: wrap(oldKey, owner.contentPublicKey!) }] } })))
            .toEqual({ status: "migration_incomplete" });
        const invalidEnvelope = Buffer.from(prepared[0]!.encryptedDataKey, 'base64');
        invalidEnvelope[0] = 255; // An unsupported format, not a well-sized legacy V0 envelope.
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee",
            directive: { ...directive, items: [{ ...directive.items[0]!, recipientKeyEnvelopes: [{ ...prepared[0]!,
                encryptedDataKey: invalidEnvelope.toString('base64') }] }] } })))
            .toEqual({ status: "invalid_content" });
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee", directive })))
            .toEqual({ status: "applied" });
        const envelopes = await db.artifactKeyEnvelope.findMany({ where: { artifactId: artifact.id } });
        expect(envelopes.map(row => row.recipientAccountId)).toEqual([recipients[0]!.id]);
        expect(privacyKit.encodeBase64(new Uint8Array(envelopes[0]!.encryptedDataKey))).toBe(prepared[0]!.encryptedDataKey);
        expect(await db.accountChange.count({ where: { accountId: recipients[1]!.id, kind: 'artifact', entityId: artifact.id } })).toBe(1);
        expect(await db.accountChange.count({ where: { accountId: recipients[2]!.id, kind: 'artifact', entityId: artifact.id } })).toBe(0);
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "plain", directive: {
            action: "migrate", items: [{ artifactId: artifact.id, expectedHeaderVersion: 2, expectedBodyVersion: 2,
                expectedDataEncryptionKey: directive.items[0]!.dataEncryptionKey,
                header: encodePlainArtifactStoredContent({ title: 'Shared' }), body: encodePlainArtifactStoredContent({ body: 'Content' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, recipientKeyEnvelopes: [], revisions: [], blobs: [] }],
        } }))).toEqual({ status: "applied" });
        expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
    });

    it("socket reads and writes resolve the same live grants as HTTP", async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: editor.id,
            accessLevel: "edit", createdByAccountId: owner.id } });
        const token = await auth.createToken(editor.id, undefined, { kind: "account", authority: "present_user" });
        const socket = Object.assign(createAuthenticatedFakeSocket({ data: {
            userId: editor.id, authTokenKind: "account", clientType: "user-scoped", accountStoredContentCompatibility: {
                supportsCurrentProtocol: true, outcome: "accepted", declaration: null, upgradeRequired: null,
            },
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        artifactUpdateHandler(editor.id, socket as unknown as Socket);
        const read = vi.fn();
        await getSocketHandler(socket, "artifact-read")({ artifactId: artifact.id }, read);
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ result: "success", artifact: expect.objectContaining({
            ownerAccountId: owner.id, access: "edit", header: privacyKit.encodeBase64(artifact.header),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) }));
        const write = vi.fn();
        await getSocketHandler(socket, "artifact-update")({ artifactId: artifact.id, body: {
            data: encodePlainArtifactStoredContent({ value: "socket edit" }), expectedVersion: 1,
        } }, write);
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ result: "success", body: { version: 2,
            data: encodePlainArtifactStoredContent({ value: "socket edit" }) } }));
        await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: artifact.id, accountId: editor.id } });
        const revoked = vi.fn();
        await getSocketHandler(socket, "artifact-read")({ artifactId: artifact.id }, revoked);
        expect(revoked).toHaveBeenCalledWith({ result: "error", message: "Artifact not found" });
    });

    it("owner and admin grant routes expose shared plain headers and revoke reads without key material", async () => {
        const owner = await plainAccount();
        const admin = await plainAccount();
        const outsider = await plainAccount();
        await makeShareEligibleForTest(owner.id, admin.id);
        await makeShareEligibleForTest(admin.id, outsider.id);
        const artifact = await plainArtifact(owner.id);
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const set = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id }, accessLevel: "admin" } });
            expect(set.statusCode).toBe(200);
            expect(set.json()).toMatchObject({ access: "owner", changed: true });
            const list = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": admin.id } });
            expect(list.statusCode).toBe(200);
            expect(list.json()).toMatchObject({ ownerAccountId: owner.id, access: "admin", grants: [
                { principal: { kind: "account", accountId: admin.id }, accessLevel: "admin", display: { name: null, username: null } },
            ] });
            const delegated = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id }, accessLevel: "view" } });
            expect(delegated.statusCode).toBe(200);
            const refused = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id }, accessLevel: "admin" } });
            expect(refused.statusCode).toBe(403);
            const removed = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id } } });
            expect(removed.statusCode).toBe(200);
            const read = await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toMatchObject({ ownerAccountId: owner.id, access: "admin", encryptionMode: "plain",
                header: privacyKit.encodeBase64(artifact.header), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
            const shared = await app.inject({ method: "GET", url: "/v1/artifacts",
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } });
            expect(shared.statusCode).toBe(200);
            expect(shared.json()).toMatchObject([{ id: artifact.id, ownerAccountId: owner.id, access: "admin" }]);
            const absent = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": outsider.id } });
            expect(absent.statusCode).toBe(404);
            const keyless = await app.inject({ method: "POST", url: `/v1/artifacts/${artifact.id}/access/key-envelopes`,
                headers: { "x-test-user-id": owner.id }, payload: { artifactId: artifact.id,
                    expectedDataEncryptionKey: privacyKit.encodeBase64(new Uint8Array(105)), recipientKeyEnvelopes: [] } });
            expect(keyless.statusCode).toBe(400);
            expect(keyless.json()).toEqual({ error: "data_key_not_required" });
            const revoked = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id } } });
            expect(revoked.statusCode).toBe(200);
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } })).statusCode).toBe(404);
        });
        expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
    });

    it("Team and Group grants use live membership and highest access, including removal and archival", async () => {
        const owner = await plainAccount();
        const member = await plainAccount();
        const team = await db.team.create({ data: { name: "Document team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "member" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Editors") } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            nativeContribution: true } });
        const artifact = await plainArtifact(owner.id);
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            for (const grant of [
                { principal: { kind: "team", teamId: team.id }, accessLevel: "view" },
                { principal: { kind: "group", teamId: team.id, groupId: group.id }, accessLevel: "edit" },
            ]) {
                const set = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                    payload: { artifactId: artifact.id, ...grant } });
                expect(set.statusCode).toBe(200);
            }
            const read = () => app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": member.id, ...protocolHeaders } });
            expect((await read()).json()).toMatchObject({ access: "edit" });
            await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
            expect((await read()).json()).toMatchObject({ access: "view" });
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
            expect((await read()).statusCode).toBe(404);
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "active" } });
            expect((await read()).json()).toMatchObject({ access: "view" });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            expect((await read()).statusCode).toBe(404);
        });
    });

    it('set-acquires Resource recipients and grants while preserving current-binding skips and input order', async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const recipients = await Promise.all(Array.from({ length: 3 }, () => db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' },
        })));
        const plain = await plainAccount();
        const key = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new TextEncoder().encode('opaque header'), body: new TextEncoder().encode('opaque body'),
            dataEncryptionKey: wrap(owner.contentPublicKey!) } });
        const team = await db.team.create({ data: { name: 'Recipient acquisition' } });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: artifact.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.teamMembership.createMany({ data: recipients.map(recipient => ({ teamId: team.id, accountId: recipient.id, role: 'member' })) });
        // Overlapping direct/Team grants must keep the valid recipient admitted once.
        await db.artifactGrant.createMany({ data: [recipients[0], plain].map(recipient => ({ principalKind: 'account',
            artifactId: artifact.id, accountId: recipient.id, accessLevel: 'edit', createdByAccountId: owner.id,
        })) });
        const entries = [...recipients, plain, owner].map(recipient => ({ recipientAccountId: recipient.id,
            encryptedDataKey: privacyKit.encodeBase64(wrap(recipient.contentPublicKey ?? owner.contentPublicKey!)),
            recipientContentPublicKeyFingerprint: recipient.contentPublicKey ? computeContentPublicKeyFingerprint(recipient.contentPublicKey) : 'unavailable' }));
        await db.account.update({ where: { id: recipients[1].id }, data: createSignedAccountContentBinding() });
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: recipients[2].id } });
        const apply = (recipientKeyEnvelopes: typeof entries) => inTx(async tx => {
            const observed = observePrismaReads(tx, ['account', 'artifact']);
            const value = await applyArtifactRecipientKeyEnvelopesInTx(observed.tx, { artifactId: artifact.id, recipientKeyEnvelopes });
            return { value, reads: observed.reads };
        });
        const single = await apply(entries.slice(0, 1));
        const multiple = await apply(entries);
        expect(single.value).toEqual({ appliedRecipientAccountIds: [recipients[0].id], skippedRecipientAccountIds: [] });
        expect(multiple.value).toEqual({ appliedRecipientAccountIds: [recipients[0].id],
            skippedRecipientAccountIds: [recipients[1].id, recipients[2].id, plain.id, owner.id] });
        expect(await db.artifactKeyEnvelope.findMany({ where: { artifactId: artifact.id }, select: { recipientAccountId: true } }))
            .toEqual([{ recipientAccountId: recipients[0].id }]);
        expect(single.reads).toHaveLength(2);
        expect(multiple.reads).toHaveLength(single.reads.length);
    });

    it("recipient preparation rechecks keys and memberships and never projects the owner's envelope to a grantee", async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const editor = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const late = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const plain = await plainAccount();
        const team = await db.team.create({ data: { name: "Encrypted documents" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: editor.id, role: "member" } });
        const dataKey = tweetnacl.randomBytes(32);
        const ownerKey = new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes }));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new TextEncoder().encode("opaque header"), body: new TextEncoder().encode("opaque body"), dataEncryptionKey: ownerKey,
            headerVersion: 1, bodyVersion: 1 } });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: artifact.id, teamId: team.id, accessLevel: "edit", createdByAccountId: owner.id } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: plain.id, accessLevel: "view", createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const headers = { "x-test-user-id": owner.id };
            const censusUrl = `/v1/artifacts/${artifact.id}/access/recipients`;
            const commitUrl = `/v1/artifacts/${artifact.id}/access/key-envelopes`;
            const census = () => app.inject({ method: "GET", url: censusUrl, headers });
            const before = (await census()).json();
            expect(before.recipients).toContainEqual(expect.objectContaining({ recipientAccountId: plain.id,
                contentKey: { status: "unavailable", reason: "plain_account" } }));
            const editorRow = before.recipients.find((row: { recipientAccountId: string }) => row.recipientAccountId === editor.id);
            const editorKey = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: editor.contentPublicKey!, randomBytes: tweetnacl.randomBytes })));
            const commit = await app.inject({ method: "POST", url: commitUrl, headers, payload: { artifactId: artifact.id,
                expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [{ recipientAccountId: editor.id,
                    encryptedDataKey: editorKey, recipientContentPublicKeyFingerprint: editorRow.contentPublicKeyFingerprint }] } });
            expect(commit.statusCode).toBe(200);
            expect(commit.json()).toEqual({ appliedRecipientAccountIds: [editor.id], skippedRecipientAccountIds: [] });
            const opened = await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": editor.id } });
            expect(opened.json()).toMatchObject({ dataEncryptionKey: editorKey, ownerAccountId: owner.id, access: "edit" });
            const editedCiphertext = new TextEncoder().encode("opaque edited body");
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: editor.id, artifactId: artifact.id,
                body: { bytes: editedCiphertext, expectedVersion: 1 } })))
                .toMatchObject({ ok: true, body: { version: 2 } });
            expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).body)
                .toEqual(editedCiphertext);
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": plain.id } })).statusCode).toBe(409);
            const lateMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: late.id, role: "member" } });
            const editorCensus = await app.inject({ method: "GET", url: censusUrl, headers: { "x-test-user-id": editor.id } });
            expect(editorCensus.statusCode).toBe(200);
            const lateRow = editorCensus.json().recipients.find((row: { recipientAccountId: string }) => row.recipientAccountId === late.id);
            expect(lateRow.encryptedDataKey).toBeNull();
            await db.teamMembership.delete({ where: { id: lateMembership.id } });
            const lateEnvelope = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: late.contentPublicKey!, randomBytes: tweetnacl.randomBytes })));
            const removed = await app.inject({ method: "POST", url: commitUrl, headers: { "x-test-user-id": editor.id }, payload: {
                artifactId: artifact.id, expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [{
                    recipientAccountId: late.id, encryptedDataKey: lateEnvelope, recipientContentPublicKeyFingerprint: lateRow.contentPublicKeyFingerprint,
                }],
            } });
            expect(removed.json()).toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [late.id] });
            expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id, recipientAccountId: late.id } })).toBe(0);
            await db.account.update({ where: { id: editor.id }, data: { ...createSignedAccountContentBinding() } });
            const rebound = await app.inject({ method: 'POST', url: commitUrl, headers, payload: {
                artifactId: artifact.id, expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [{
                    recipientAccountId: editor.id, encryptedDataKey: editorKey,
                    recipientContentPublicKeyFingerprint: editorRow.contentPublicKeyFingerprint,
                }],
            } });
            expect(rebound.statusCode, rebound.body).toBe(200);
            expect(rebound.json()).toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [editor.id] });
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": editor.id } })).statusCode).toBe(409);
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: editor.id, artifactId: artifact.id,
                body: { bytes: editedCiphertext, expectedVersion: 2 } })))
                .toMatchObject({ ok: false, error: "not-found" });
            const transition = await inTx(async tx => migrateArtifactAccountEncryptionInTx({
                tx, accountId: owner.id, fromMode: "e2ee", toMode: "plain", directive: { action: "migrate", items: [{
                    artifactId: artifact.id, expectedHeaderVersion: 1, expectedBodyVersion: 2,
                    expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [],
                    header: encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }),
                    body: encodePlainArtifactStoredContent({ value: "plain replacement" }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    blobs: [],
                    revisions: (await tx.artifactRevision.findMany({ where: { artifactId: artifact.id } })).map(revision => ({
                        bodyVersion: revision.bodyVersion, expectedBody: privacyKit.encodeBase64(new Uint8Array(revision.body)),
                        body: encodePlainArtifactStoredContent({ body: "Retained content" }),
                    })),
                }] },
            }));
            expect(transition).toEqual({ status: "applied" });
            expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
        });
    });

    it("an editor CAS uses the owner's plain storage path and notifies every current recipient", async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const viewer = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactGrant.createMany({ data: [
            { principalKind: 'account', artifactId: artifact.id, accountId: editor.id, accessLevel: "edit", createdByAccountId: owner.id },
            { principalKind: 'account', artifactId: artifact.id, accountId: viewer.id, accessLevel: "view", createdByAccountId: owner.id },
        ] });
        const body = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: "edited" }));
        const write = await inTx(tx => updateArtifactTx(tx, {
            actorUserId: editor.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 },
        }));
        expect(write).toMatchObject({ ok: true, body: { version: 2 } });
        expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).body).not.toEqual(body);
        const notices = await db.accountChange.findMany({ where: { artifactId: artifact.id }, select: { accountId: true } });
        expect(notices.map(row => row.accountId).sort()).toEqual([owner.id, editor.id, viewer.id].sort());
        await expect(inTx(tx => updateArtifactTx(tx, {
            actorUserId: editor.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 },
        }))).resolves.toMatchObject({ ok: false, error: "version-mismatch", current: { bodyVersion: 2, body } });
        await expect(inTx(tx => updateArtifactTx(tx, {
            actorUserId: viewer.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 2 },
        }))).resolves.toMatchObject({ ok: false, error: "not-found" });
        await expect(deleteArtifact({ actorUserId: editor.id, artifactId: artifact.id }))
            .resolves.toMatchObject({ ok: false, error: "not-found" });
        expect(await db.artifact.count({ where: { id: artifact.id } })).toBe(1);
        const beforeDelete = await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } });
        await expect(deleteArtifact({ actorUserId: owner.id, artifactId: artifact.id,
            expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
            .resolves.toMatchObject({ ok: false, error: "version-mismatch" });
        expect(await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } })).toEqual(beforeDelete);
        await expect(deleteArtifact({ actorUserId: owner.id, artifactId: artifact.id }))
            .resolves.toMatchObject({ ok: true });
        const deletedNotices = await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } });
        expect(deletedNotices.map(row => row.accountId).sort()).toEqual([owner.id, editor.id, viewer.id].sort());
        for (const notice of deletedNotices) {
            expect(notice.cursor).toBeGreaterThan(beforeDelete.find(row => row.accountId === notice.accountId)!.cursor);
        }
    });
});
