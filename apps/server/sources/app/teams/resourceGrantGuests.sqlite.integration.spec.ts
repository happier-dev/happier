import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    computeContentPublicKeyFingerprint, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0,
} from '@happier-dev/protocol';
import { DiscussionCreateRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import type { Fastify } from '@/app/api/types';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';

type ResourceKind = 'artifact' | 'discussion';

describe('Team guests at real resource routes (SQLite, real bearer authentication)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-resource-guests-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(app: Fastify, kind: ResourceKind, encrypted: boolean) {
        const account = async () => {
            const row = await db.account.create({ data: encrypted
                ? { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() }
                : { encryptionMode: 'plain' } });
            const token = await auth.createToken(row.id, undefined, { kind: 'account', authority: 'present_user' });
            return { ...row, headers: { authorization: `Bearer ${token}`,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) } };
        };
        const owner = await account();
        const teamGuest = await account();
        const groupGuest = await account();
        const member = await account();
        const directGuest = await account();
        const team = await db.team.create({ data: { name: 'Resource guest regression' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: teamGuest.id, role: 'guest' },
            { teamId: team.id, accountId: groupGuest.id, role: 'guest' },
            { teamId: team.id, accountId: directGuest.id, role: 'guest' },
            { teamId: team.id, accountId: member.id, role: 'member' },
        ] });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Explicit guest audience', nameKey: 'explicit-guest-audience' } });
        const groupMembership = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: team.id, accountId: groupGuest.id } } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: groupMembership.id,
            nativeContribution: true } });
        const dataKey = tweetnacl.randomBytes(32);
        const wrap = (recipient: typeof owner) => {
            if (!recipient.contentPublicKey) throw new Error('Encrypted fixture requires a verified content key');
            return privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: recipient.contentPublicKey, randomBytes: tweetnacl.randomBytes }));
        };
        const ownerEnvelope = encrypted ? wrap(owner) : ARTIFACT_PLAIN_DATA_KEY_MARKER;
        const artifactId = crypto.randomUUID();
        const create = await app.inject({ method: 'POST', url: kind === 'artifact' ? '/v1/artifacts' : '/v1/discussions',
            headers: owner.headers, payload: kind === 'artifact' ? {
                id: artifactId, header: encrypted ? privacyKit.encodeBase64(await sealSessionDataKeyBundleV0({ title: 'Guest boundary' }, dataKey))
                    : encodePlainArtifactStoredContent({ title: 'Guest boundary' }),
                body: encrypted ? privacyKit.encodeBase64(await sealSessionDataKeyBundleV0({ value: 'original' }, dataKey))
                    : encodePlainArtifactStoredContent({ value: 'original' }), dataEncryptionKey: ownerEnvelope,
            } : DiscussionCreateRequestV1Schema.parse(encrypted ? {
                creationLocalId: crypto.randomUUID(), creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) },
                titleContent: { t: 'encrypted', c: 'opaque-title' }, dataEncryptionKey: ownerEnvelope,
                expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(owner.contentPublicKey!),
                firstMessage: { localId: crypto.randomUUID(), content: { t: 'encrypted', c: 'opaque-message' },
                    requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'B'.repeat(43) }, mentionedAccountIds: [] },
            } : {
                creationLocalId: crypto.randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Guest boundary' } },
                firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Original' }] } },
                    mentionedAccountIds: [] },
            }) });
        expect(create.statusCode).toBe(200);
        const id: string = kind === 'artifact' ? artifactId : create.json().discussion.id;
        if (kind === 'artifact') {
            await db.artifactTeamGrant.create({ data: { artifactId: id, teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id } });
            await db.artifactGroupGrant.create({ data: { artifactId: id, teamGroupId: group.id, accessLevel: 'edit', createdByAccountId: owner.id } });
            await db.artifactAccountGrant.create({ data: { artifactId: id, accountId: directGuest.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        } else {
            await db.discussionTeamGrant.create({ data: { discussionId: id, teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id } });
            await db.discussionGroupGrant.create({ data: { discussionId: id, teamGroupId: group.id, accessLevel: 'edit', createdByAccountId: owner.id } });
            await db.discussionAccountGrant.create({ data: { discussionId: id, accountId: directGuest.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        }
        const resourceUrl = kind === 'artifact' ? `/v1/artifacts/${id}` : `/v1/discussions/${id}`;
        return { id, owner, teamGuest, groupGuest, member, directGuest, ownerEnvelope, wrap, resourceUrl,
            censusUrl: resourceUrl + (kind === 'artifact' ? '/access/recipients' : '/data-key/recipients'),
            envelopesUrl: resourceUrl + (kind === 'artifact' ? '/access/key-envelopes' : '/data-key/envelopes') };
    }

    describe.each(['artifact', 'discussion'] as const)('%s', kind => {
        const register = kind === 'artifact' ? artifactsRoutes : registerDiscussionRoutes;

        it('refuses Team-only guests read/edit while owner, member, explicit Group guest and direct guest retain access', async () => {
            await withAuthenticatedTestApp(register, async (app: Fastify) => {
                const f = await fixture(app, kind, false);
                let bodyVersion = 1;
                const edit = (headers: typeof f.owner.headers, text: string) => app.inject({
                    method: 'POST', url: kind === 'artifact' ? f.resourceUrl : `${f.resourceUrl}/messages`, headers,
                    payload: kind === 'artifact' ? { body: encodePlainArtifactStoredContent({ value: text }), expectedBodyVersion: bodyVersion }
                        : { localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text }] } }, mentionedAccountIds: [] },
                });
                for (const actor of [f.owner, f.member, f.groupGuest, f.directGuest]) {
                    expect((await app.inject({ method: 'GET', url: f.resourceUrl, headers: actor.headers })).statusCode).toBe(200);
                    expect((await edit(actor.headers, 'Authorized edit')).statusCode).toBe(200);
                    bodyVersion++;
                }
                const before = kind === 'artifact' ? await db.artifact.findUniqueOrThrow({ where: { id: f.id } })
                    : await db.discussion.findUniqueOrThrow({ where: { id: f.id } });
                const read = await app.inject({ method: 'GET', url: f.resourceUrl, headers: f.teamGuest.headers });
                expect.soft(read.statusCode).toBe(404);
                const write = await edit(f.teamGuest.headers, 'Forbidden guest edit');
                expect.soft(write.statusCode).toBe(kind === 'artifact' ? 404 : 400);
                if (kind === 'discussion') expect.soft(write.json()).toEqual({ error: 'discussion_publication_context_unavailable' });
                const after = kind === 'artifact' ? await db.artifact.findUniqueOrThrow({ where: { id: f.id } })
                    : await db.discussion.findUniqueOrThrow({ where: { id: f.id } });
                expect.soft(after).toEqual(before);
                const list = await app.inject({ method: 'GET', url: kind === 'artifact' ? '/v1/artifacts' : '/v1/discussions',
                    headers: f.teamGuest.headers });
                expect(list.statusCode).toBe(200);
                const rows: { id: string }[] = kind === 'artifact' ? list.json() : list.json().discussions;
                expect.soft(rows.map(row => row.id)).not.toContain(f.id);
            }, { authentication: 'real' });
        });

        it('excludes Team-only guests from key census and skips their key wrap without storing it', async () => {
            await withAuthenticatedTestApp(register, async (app: Fastify) => {
                const f = await fixture(app, kind, true);
                const census = await app.inject({ method: 'GET', url: f.censusUrl, headers: f.owner.headers });
                expect(census.statusCode).toBe(200);
                const recipients: { recipientAccountId: string }[] = census.json().recipients;
                expect.soft(recipients.map(row => row.recipientAccountId).sort())
                    .toEqual([f.owner.id, f.member.id, f.groupGuest.id, f.directGuest.id].sort());
                const actors = [f.teamGuest, f.member, f.groupGuest, f.directGuest];
                const commit = await app.inject({ method: kind === 'artifact' ? 'POST' : 'PUT', url: f.envelopesUrl,
                    headers: f.owner.headers, payload: {
                        ...(kind === 'artifact' ? { artifactId: f.id } : {}), expectedDataEncryptionKey: f.ownerEnvelope,
                        recipientKeyEnvelopes: actors.map(actor => ({ recipientAccountId: actor.id, encryptedDataKey: f.wrap(actor),
                            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(actor.contentPublicKey!) })),
                    } });
                expect(commit.statusCode).toBe(200);
                expect.soft(commit.json()).toEqual({ appliedRecipientAccountIds: [f.member.id, f.groupGuest.id, f.directGuest.id],
                    skippedRecipientAccountIds: [f.teamGuest.id] });
                const stored = kind === 'artifact'
                    ? await db.artifactKeyEnvelope.findMany({ where: { artifactId: f.id }, select: { recipientAccountId: true } })
                    : await db.discussionKeyEnvelope.findMany({ where: { discussionId: f.id }, select: { recipientAccountId: true } });
                expect.soft(stored.map(row => row.recipientAccountId).sort()).toEqual([f.member.id, f.groupGuest.id, f.directGuest.id].sort());
                for (const actor of [f.owner, f.member, f.groupGuest, f.directGuest]) {
                    expect((await app.inject({ method: 'GET', url: f.resourceUrl, headers: actor.headers })).statusCode).toBe(200);
                }
                expect.soft((await app.inject({ method: 'GET', url: f.resourceUrl, headers: f.teamGuest.headers })).statusCode).toBe(404);
                expect.soft((await app.inject({ method: 'GET', url: f.censusUrl, headers: f.teamGuest.headers })).statusCode).toBe(404);
                expect.soft((await app.inject({ method: kind === 'artifact' ? 'POST' : 'PUT', url: f.envelopesUrl,
                    headers: f.teamGuest.headers, payload: { ...(kind === 'artifact' ? { artifactId: f.id } : {}),
                        expectedDataEncryptionKey: f.ownerEnvelope, recipientKeyEnvelopes: [] } })).statusCode).toBe(404);
            }, { authentication: 'real' });
        });
    });
});
