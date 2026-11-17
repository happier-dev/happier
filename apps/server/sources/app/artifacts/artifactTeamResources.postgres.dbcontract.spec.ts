import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { captureReadSnapshot } from '@/storage/captureReadSnapshot';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Team Artifact PostgreSQL inventory', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('retains an admitted encrypted row without a recipient envelope as typed locked metadata without private content', async () => {
        const account = () => db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const owner = await account();
        const member = await account();
        const stranger = await account();
        const team = await db.team.create({ data: { name: 'Retained encrypted resources' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const retained = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: 'v1:other:contributed.v1', header: new TextEncoder().encode('private encrypted header'),
            body: new TextEncoder().encode('private encrypted body'), headerVersion: 1, bodyVersion: 1,
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes }),
        } });
        await db.artifactGrant.create({ data: { artifactId: retained.id, principalKind: 'team', teamId: team.id,
            createdByAccountId: owner.id, accessLevel: 'view' } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const read = (actorId: string) => app.inject({ method: 'GET',
                url: `/v1/artifacts?sharedWithTeamId=${team.id}&teamResourceKind=otherArtifacts&limit=1`,
                headers: { 'x-test-user-id': actorId,
                    'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) } });
            const response = await read(member.id);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ items: [{ id: retained.id,
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }] });
            const row = response.json<{ items: Array<Record<string, unknown>> }>().items[0]!;
            for (const field of ['header', 'dataEncryptionKey', 'body', 'provenance', 'provenanceDataEncryptionKey']) {
                expect(row).not.toHaveProperty(field);
            }
            const denied = await read(stranger.id);
            expect(denied.statusCode, denied.body).toBe(200);
            expect(denied.json()).toMatchObject({ items: [] });
        });
    });

    it('selects the requested Team before paging, retains legacy Other and excludes private Group resources from an administrator', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const admin = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Artifact query Team' } });
        const otherTeam = await db.team.create({ data: { name: 'Other Artifact Team' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: admin.id, role: 'admin' },
            { teamId: otherTeam.id, accountId: member.id, role: 'member' },
        ] });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Readers') } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: membership.id, nativeContribution: true } });
        const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        const template = { accountId: owner.id, header: bytes({ title: 'Retained ordinary document' }),
            body: bytes('Private body'), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1 };
        // Unrelated rows are deliberately newer than the demanded legacy page.
        await db.artifact.createMany({ data: Array.from({ length: 1200 }, () => ({ ...template,
            id: randomUUID(), kind: 'v1:other:unrelated.v1' })) });
        const legacy = await db.artifact.create({ data: { ...template, id: randomUUID(), kind: null, updatedAt: new Date(0) } });
        const coarse = await db.artifact.create({ data: { ...template, id: randomUUID(), kind: 'prompt', updatedAt: new Date(1) } });
        const groupOnly = await db.artifact.create({ data: { ...template, id: randomUUID(), kind: 'v1:other:contributed.v1' } });
        const groupWithDirectReader = await db.artifact.create({ data: { ...template, id: randomUUID(), kind: 'v1:other:contributed.v1' } });
        const otherTeamOnly = await db.artifact.create({ data: { ...template, id: randomUUID(), kind: 'v1:other:contributed.v1' } });
        await db.artifactGrant.createMany({ data: [
            ...[legacy, coarse].map(artifact => ({ principalKind: 'team', artifactId: artifact.id, teamId: team.id,
                accessLevel: 'view' as const, createdByAccountId: owner.id })),
            { principalKind: 'group', artifactId: groupOnly.id, teamGroupId: group.id,
                accessLevel: 'view', createdByAccountId: owner.id },
            { principalKind: 'group', artifactId: legacy.id, teamGroupId: group.id,
                accessLevel: 'view', createdByAccountId: owner.id },
            { principalKind: 'group', artifactId: groupWithDirectReader.id, teamGroupId: group.id,
                accessLevel: 'view', createdByAccountId: owner.id },
            { principalKind: 'account', artifactId: groupWithDirectReader.id, accountId: admin.id,
                accessLevel: 'view', createdByAccountId: owner.id },
            { principalKind: 'team', artifactId: otherTeamOnly.id, teamId: otherTeam.id,
                accessLevel: 'view', createdByAccountId: owner.id },
        ] });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const selectedIds = new Set<string>();
            let selectedBodies = false;
            const stop = observePrismaRequests(db, { before(request) {
                if (request.model !== 'Artifact' || request.action !== 'findMany') return;
                const args = request.args as { select?: { body?: boolean } };
                selectedBodies ||= args.select?.body === true;
            }, after(request, result) {
                if (request.model !== 'Artifact' || request.action !== 'findMany' || !Array.isArray(result)) return;
                for (const row of result) if (row && typeof row === 'object' && 'id' in row && typeof row.id === 'string') selectedIds.add(row.id);
            } });
            try {
                const read = async (actorId: string, limit = 50, groupAdmitted = actorId !== admin.id) => {
                    const response = await app.inject({ method: 'GET',
                        url: `/v1/artifacts?sharedWithTeamId=${team.id}&teamResourceKind=otherArtifacts&limit=${limit}`,
                        headers: { 'x-test-user-id': actorId,
                            'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) } });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ items: expect.any(Array) });
                    const items = response.json<{ items: Array<{ id: string; sharedWithTeamScope?: string }> }>().items;
                    for (const row of items) {
                        const expected = row.id === groupOnly.id || row.id === groupWithDirectReader.id ? 'group'
                            : row.id === legacy.id && groupAdmitted ? 'team_and_group' : 'team';
                        expect(row.sharedWithTeamScope).toBe(expected);
                    }
                    return items.map(row => row.id);
                };
                expect(new Set(await read(member.id))).toEqual(new Set([legacy.id, coarse.id, groupOnly.id, groupWithDirectReader.id]));
                expect(new Set(await read(admin.id))).toEqual(new Set([legacy.id, coarse.id, groupWithDirectReader.id]));
                expect(new Set(await read(owner.id))).toEqual(new Set([legacy.id, coarse.id, groupOnly.id, groupWithDirectReader.id]));
                const { countTeamSharedArtifactsInTx } = await import('./artifactAccessService');
                for (const [actorAccountId, count] of [[member.id, 4], [admin.id, 3], [owner.id, 4]] as const) {
                    expect(await captureReadSnapshot(tx => countTeamSharedArtifactsInTx(tx, {
                        actorAccountId, sharedWithTeamId: team.id,
                    }))).toEqual({ ok: true, counts: { projectDocuments: 0, prompts: 0, workflows: 0, otherArtifacts: count } });
                }
                await db.teamGroupMembership.deleteMany({ where: { teamGroupId: group.id, teamMembershipId: membership.id } });
                expect(new Set(await read(member.id, 50, false))).toEqual(new Set([legacy.id, coarse.id]));
            } finally { stop(); }
            expect(selectedBodies).toBe(false);
            expect(selectedIds).toEqual(new Set([legacy.id, coarse.id, groupOnly.id, groupWithDirectReader.id]));
        });
    });
});
