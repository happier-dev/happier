import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { BOT_TEMPLATE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { inTx } from '@/storage/inTx';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { listArtifactAccessGrantsInTx } from './artifactAccessService';

describe('Template accepted versions through Artifact sharing (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'template-accepted-versions-', initEncrypt: true, initAuth: true });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(mode: 'plain' | 'e2ee' = 'plain') {
        const account = () => db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const owner = await account();
        const recipient = await account();
        const other = await account();
        const header = { kind: BOT_TEMPLATE_ARTIFACT_KIND_V1 };
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: deriveArtifactStoredKindV1(header), header: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(header))
                : new TextEncoder().encode('encrypted template header'),
            body: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ opaque: true }))
                : new TextEncoder().encode('encrypted release'),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                    recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes })), headerVersion: 1, bodyVersion: 1 } });
        await db.artifactAccountGrant.createMany({ data: [recipient, other].map(account => ({ artifactId: artifact.id,
            accountId: account.id, accessLevel: 'view' as const, createdByAccountId: owner.id })) });
        return { owner, recipient, other, artifact };
    }

    it.each(['plain', 'e2ee'] as const)('projects %s last-reported versions only to the owner, preserving several copies and no-report rows', async mode => {
        const f = await fixture(mode);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const report = (copyId: string, acceptedVersion: string) => app.inject({ method: 'PUT',
                url: `/v1/artifacts/${f.artifact.id}/access/accepted-version`, headers: { 'x-test-user-id': f.recipient.id },
                payload: { artifactId: f.artifact.id, copyId, acceptedVersion } });
            expect((await report('private-copy-a', '1.0.0')).statusCode).toBe(200);
            expect((await report('private-copy-b', '1.0.0')).statusCode).toBe(200);
            const copies = await app.inject({ method: 'GET', url: `/v1/artifacts/${f.artifact.id}/access/grants`,
                headers: { 'x-test-user-id': f.owner.id } });
            expect(copies.json().grants.find((row: { principal: { accountId?: string } }) => row.principal.accountId === f.recipient.id))
                .toMatchObject({ acceptedVersions: [{ version: '1.0.0', copies: 2 }] });
            expect((await report('private-copy-a', '1.1.0')).statusCode).toBe(200);
            const owner = await app.inject({ method: 'GET', url: `/v1/artifacts/${f.artifact.id}/access/grants`,
                headers: { 'x-test-user-id': f.owner.id } });
            expect(owner.statusCode).toBe(200);
            const listed = ArtifactAccessGrantsListResponseV1Schema.parse(owner.json());
            expect(listed.grants.find(row => row.principal.kind === 'account' && row.principal.accountId === f.recipient.id))
                .toMatchObject({ acceptedVersions: [{ version: '1.0.0', copies: 1, reportedAt: expect.any(Number) },
                    { version: '1.1.0', copies: 1, reportedAt: expect.any(Number) }] });
            expect(listed.grants.find(row => row.principal.kind === 'account' && row.principal.accountId === f.other.id))
                .toMatchObject({ acceptedVersions: [] });
            expect(JSON.stringify(listed)).not.toContain('private-copy');
            const recipient = await app.inject({ method: 'GET', url: `/v1/artifacts/${f.artifact.id}/access/grants`,
                headers: { 'x-test-user-id': f.recipient.id } });
            expect(recipient.statusCode).toBe(200);
            expect(recipient.json().grants).toHaveLength(1);
            expect(recipient.json().grants[0]).not.toHaveProperty('acceptedVersions');
            await db.artifactAccountGrant.update({ where: { artifactId_accountId: { artifactId: f.artifact.id,
                accountId: f.recipient.id } }, data: { accessLevel: 'admin' } });
            const admin = await app.inject({ method: 'GET', url: `/v1/artifacts/${f.artifact.id}/access/grants`,
                headers: { 'x-test-user-id': f.recipient.id } });
            expect(admin.json().grants).toHaveLength(1);
            expect(admin.json().grants[0]).not.toHaveProperty('acceptedVersions');
        });
    });

    it('does no write or wake for an unchanged report and never reads recipient Sessions', async () => {
        const f = await fixture();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const report = () => app.inject({ method: 'PUT', url: `/v1/artifacts/${f.artifact.id}/access/accepted-version`,
                headers: { 'x-test-user-id': f.recipient.id },
                payload: { artifactId: f.artifact.id, copyId: 'existing-session-routing', acceptedVersion: '1.0.0' } });
            expect((await report()).json()).toEqual({ changed: true });
            const before = await db.accountChange.findMany({ where: { entityId: f.artifact.id }, select: { accountId: true, cursor: true } });
            expect(before.map(row => row.accountId)).toEqual([f.owner.id]);
            const storedBefore = await db.artifactTemplateAcceptedVersion.findMany({ where: { artifactId: f.artifact.id } });
            expect((await report()).json()).toEqual({ changed: false });
            expect(await db.accountChange.findMany({ where: { entityId: f.artifact.id }, select: { accountId: true, cursor: true } })).toEqual(before);
            expect(await db.artifactTemplateAcceptedVersion.findMany({ where: { artifactId: f.artifact.id } })).toEqual(storedBefore);
            const inspected = await inTx(async tx => {
                const observed = observePrismaReads(tx, ['session', 'artifact']);
                const result = await listArtifactAccessGrantsInTx(observed.tx, { actorAccountId: f.owner.id, artifactId: f.artifact.id });
                return { result, reads: observed.reads };
            });
            expect(inspected.result.ok).toBe(true);
            expect(inspected.reads).toEqual(['artifact.findFirst']);
        });
    });

    it('accepts the current Team grant without inventing an aggregate on the Team row', async () => {
        const f = await fixture();
        await db.artifactAccountGrant.deleteMany({ where: { artifactId: f.artifact.id } });
        const team = await db.team.create({ data: { name: 'Recipient Team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: f.recipient.id, role: 'member' } });
        await db.artifactTeamGrant.create({ data: { artifactId: f.artifact.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: f.owner.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const report = await app.inject({ method: 'PUT', url: `/v1/artifacts/${f.artifact.id}/access/accepted-version`,
                headers: { 'x-test-user-id': f.recipient.id },
                payload: { artifactId: f.artifact.id, copyId: 'team-member-copy', acceptedVersion: '1.0.0' } });
            expect(report.statusCode, report.body).toBe(200);
            const owner = await app.inject({ method: 'GET', url: `/v1/artifacts/${f.artifact.id}/access/grants`,
                headers: { 'x-test-user-id': f.owner.id } });
            expect(owner.json().grants).toHaveLength(1);
            expect(owner.json().grants[0]).toMatchObject({ principal: { kind: 'team', teamId: team.id } });
            expect(owner.json().grants[0]).not.toHaveProperty('acceptedVersions');
        });
    });

    it('refuses forged Account attribution, malformed versions and reports after grant withdrawal', async () => {
        const f = await fixture();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const send = (payload: object) => app.inject({ method: 'PUT',
                url: `/v1/artifacts/${f.artifact.id}/access/accepted-version`, headers: { 'x-test-user-id': f.recipient.id }, payload });
            const input = { artifactId: f.artifact.id, copyId: 'same-copy', acceptedVersion: '1.0.0' };
            expect((await send({ ...input, recipientAccountId: f.other.id })).statusCode).toBe(400);
            expect((await send({ ...input, acceptedVersion: 'not a version' })).statusCode).toBe(400);
            expect((await send(input)).statusCode).toBe(200);
            await db.artifactAccountGrant.delete({ where: { artifactId_accountId: { artifactId: f.artifact.id, accountId: f.recipient.id } } });
            expect((await send({ ...input, acceptedVersion: '2.0.0' })).statusCode).toBe(404);
            const listed = await app.inject({ method: 'GET', url: `/v1/artifacts/${f.artifact.id}/access/grants`,
                headers: { 'x-test-user-id': f.owner.id } });
            expect(listed.json().grants).toHaveLength(1);
        });
    });
});
