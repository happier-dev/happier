import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { TeamGroupV1Schema } from '@happier-dev/protocol/teams';
import type { PrivateLabelStoredV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { openCliPrivateLabel } from '../../../../../cli/src/api/privateLabels';

import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { plainPrivateLabel, prepareE2eePrivateLabelForAccount } from '@/testkit/privateLabelFixture';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { admitTeamMemberInTx } from '../memberships/membershipService';
import { registerTeamGroupRoutes } from './registerTeamGroupRoutes';

describe('Team Group description privacy through HTTP and storage', () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-group-description-', initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' } });
        app = createAuthenticatedTestApp();
        registerTeamGroupRoutes(app);
        await app.ready();
    }, 180_000);
    afterAll(async () => { if (app) await app.close(); if (harness) await harness.close(); });

    async function owner(mode: 'plain' | 'e2ee') {
        const signing = mode === 'e2ee' ? tweetnacl.sign.keyPair() : null;
        const content = mode === 'e2ee' ? tweetnacl.box.keyPair() : null;
        const account = await db.account.create({ data: { encryptionMode: mode,
            publicKey: signing ? Buffer.from(signing.publicKey).toString('hex') : crypto.randomUUID(),
            ...(content && signing ? { contentPublicKey: new Uint8Array(content.publicKey),
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey,
                    contentPublicKey: content.publicKey }) } : {}) } });
        const team = await db.team.create({ data: { name: 'Description privacy' } });
        const admitted = await inTx(tx => admitTeamMemberInTx(tx, { teamId: team.id, accountId: account.id,
            role: 'owner', historyAccess: 'all_existing' }));
        if (!admitted.ok) throw new Error('Owner fixture admission failed');
        const groupId = crypto.randomUUID();
        const seal = async (field: 'name' | 'description', value: string): Promise<PrivateLabelStoredV1> =>
            mode === 'plain' ? plainPrivateLabel(value) : await prepareE2eePrivateLabelForAccount(account.id,
                { entity: 'team_group', field, id: groupId }, value, { teamIds: [team.id] });
        const post = (operation: string, payload: Record<string, unknown>) => app.inject({ method: 'POST',
            url: `/v1/teams/groups/${operation}`, headers: { 'x-test-user-id': account.id },
            payload: { v: 1, teamId: team.id, ...(operation === 'list' ? {} : { groupId }), ...payload } });
        const openDescription = (body: unknown, field = 'description') => {
            const group = TeamGroupV1Schema.parse(body);
            if (group.description === null || group.description.kind !== 'available') return null;
            return openCliPrivateLabel({ binding: { entity: 'team_group', field, id: groupId },
                label: group.description.label, readPolicy: { kind: 'team-resource' },
                ...(content ? { accountKey: content.secretKey } : {}) });
        };
        return { account, team, groupId, seal, post, openDescription, content };
    }

    it('delivers saved encrypted descriptions after a join without editing and refuses departed recipients', async () => {
        const a = await owner('e2ee');
        const b = await owner('e2ee');
        const description = await a.seal('description', 'Saved before join');
        expect((await a.post('create', { name: await a.seal('name', 'Private'), description,
            requestKey: crypto.randomUUID() })).statusCode).toBe(200);
        const joined = await inTx(tx => admitTeamMemberInTx(tx, { teamId: a.team.id, accountId: b.account.id,
            role: 'member', historyAccess: 'all_existing' }));
        expect(joined.ok).toBe(true);
        const pending = await app.inject({ method: 'GET', url: '/v2/teams/groups/label-envelopes',
            headers: { 'x-test-user-id': a.account.id } });
        expect(pending.statusCode).toBe(200);
        expect(pending.json().teams.flatMap((team: { labels: { groupId: string }[] }) => team.labels)
            .some((label: { groupId: string }) => label.groupId === a.groupId)).toBe(true);
        const dataKey = openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(description.recipients[0]!.envelope.encryptedDataKey, 'base64'),
            recipientSecretKeyOrSeed: a.content!.secretKey,
        });
        if (!dataKey) throw new Error('Fixture key unavailable');
        const recipients = [a, b].map(f => ({ accountId: f.account.id, envelope: {
            encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: f.content!.publicKey, randomBytes: tweetnacl.randomBytes }), 'base64'),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(f.content!.publicKey),
        } }));
        const publish = (actor = a.account.id) => app.inject({ method: 'PATCH', url: '/v2/teams/groups/label-envelopes',
            headers: { 'x-test-user-id': actor }, payload: { teamId: a.team.id,
                labels: [{ groupId: a.groupId, field: 'description', label: { ...description, recipients } }] } });
        expect((await publish()).statusCode).toBe(200);
        const read = await app.inject({ method: 'POST', url: '/v1/teams/groups/get',
            headers: { 'x-test-user-id': b.account.id }, payload: { v: 1, teamId: a.team.id, groupId: a.groupId } });
        const group = TeamGroupV1Schema.parse(read.json());
        expect(group.description?.kind === 'available' ? openCliPrivateLabel({
            binding: { entity: 'team_group', field: 'description', id: a.groupId }, label: group.description.label,
            readPolicy: { kind: 'team-resource' }, accountKey: b.content!.secretKey,
        }) : null).toBe('Saved before join');
        const stored = await db.teamGroup.findUniqueOrThrow({ where: { id: a.groupId } });
        expect(JSON.parse(stored.description!).content).toEqual(description.content);
        // The newly eligible member can help distribute existing keys, but cannot reauthor the label through repair.
        expect((await publish(b.account.id)).statusCode).toBe(200);
        const changed = await app.inject({ method: 'PATCH', url: '/v2/teams/groups/label-envelopes',
            headers: { 'x-test-user-id': a.account.id }, payload: { teamId: a.team.id,
                labels: [{ groupId: a.groupId, field: 'description', label: {
                    ...description, content: (await a.seal('description', 'Changed content')).content, recipients,
                } }] } });
        expect(changed.statusCode).toBe(409);
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: a.team.id, accountId: b.account.id } } });
        expect((await publish()).statusCode).toBe(400);
        expect((await publish(b.account.id)).statusCode).toBe(403);
        expect((await app.inject({ method: 'PATCH', url: '/v2/teams/groups/label-envelopes',
            headers: { 'x-test-user-id': a.account.id }, payload: { teamId: a.team.id,
                labels: [{ groupId: a.groupId, field: 'description', label: {
                    ...description, recipients: recipients.filter(row => row.accountId === a.account.id),
                } }] } })).statusCode).toBe(200);
        const afterRemoval = await db.teamGroup.findUniqueOrThrow({ where: { id: a.groupId } });
        expect(JSON.parse(afterRemoval.description!).recipients.map((row: { accountId: string }) => row.accountId)).toEqual([a.account.id]);
        expect(JSON.parse(afterRemoval.description!).content).toEqual(description.content);
    });

    it('refuses raw E2EE descriptions before plaintext reaches the stored Group', async () => {
        const fixture = await owner('e2ee');
        const raw = 'Private operational instructions';
        const created = await fixture.post('create', { name: await fixture.seal('name', 'Encrypted Group'),
            description: raw, requestKey: crypto.randomUUID() });
        const stored = await db.teamGroup.findUnique({ where: { id: fixture.groupId } });
        expect(stored?.description, 'A raw E2EE description must never reach persistence').not.toBe(raw);
        expect(created.statusCode, created.body).toBe(400);
    });

    it.each(['plain', 'e2ee'] as const)('round-trips %s descriptions while preserving omit, clear and empty creation', async mode => {
        const fixture = await owner(mode);
        const value = 'Private Group context';
        const description = await fixture.seal('description', value);
        const created = await fixture.post('create', { name: await fixture.seal('name', 'Group'), description,
            requestKey: crypto.randomUUID() });
        expect(created.statusCode, created.body).toBe(200);
        expect(fixture.openDescription(created.json())).toBe(value);
        if (mode === 'e2ee') {
            expect(created.body).not.toContain(value);
            expect(fixture.openDescription(created.json(), 'name')).toBeNull();
        } else {
            expect(fixture.account.contentPublicKey).toBeNull();
            expect(created.json().description).toMatchObject({ kind: 'available',
                label: { content: { t: 'plain', v: value }, recipientEnvelope: null } });
        }
        const stored = await db.teamGroup.findUniqueOrThrow({ where: { id: fixture.groupId } });
        expect(JSON.parse(stored.description!)).toEqual(description);
        if (mode === 'e2ee') expect(stored.description).not.toContain(value);
        const get = await fixture.post('get', {});
        expect(get.statusCode, get.body).toBe(200);
        expect(fixture.openDescription(get.json())).toBe(value);
        const list = await fixture.post('list', { archived: 'active' });
        expect(list.statusCode, list.body).toBe(200);
        expect(fixture.openDescription(list.json().items[0])).toBe(value);
        const renamed = await fixture.post('update', { name: await fixture.seal('name', 'Renamed') });
        expect(renamed.statusCode, renamed.body).toBe(200);
        expect(fixture.openDescription(renamed.json())).toBe(value);
        expect((await db.teamGroup.findUniqueOrThrow({ where: { id: fixture.groupId } })).description).toBe(stored.description);
        const cleared = await fixture.post('update', { description: null });
        expect(cleared.statusCode, cleared.body).toBe(200);
        expect(cleared.json().description).toBeNull();
        expect((await db.teamGroup.findUniqueOrThrow({ where: { id: fixture.groupId } })).description).toBeNull();
        const absent = await owner(mode);
        const empty = await absent.post('create', { name: await absent.seal('name', 'No description'), requestKey: crypto.randomUUID() });
        expect(empty.statusCode, empty.body).toBe(200);
        expect(empty.json().description).toBeNull();
        const changed = await fixture.post('update', { description: await fixture.seal('description', 'Updated context') });
        expect(changed.statusCode, changed.body).toBe(200);
        expect(fixture.openDescription(changed.json())).toBe('Updated context');
    });

    it('reads retained raw descriptions until normal save and refuses current mode mismatches and legacy write markers', async () => {
        const fixture = await owner('e2ee');
        const created = await fixture.post('create', { name: await fixture.seal('name', 'Retained Group'), requestKey: crypto.randomUUID() });
        expect(created.statusCode, created.body).toBe(200);
        await db.teamGroup.update({ where: { id: fixture.groupId }, data: { description: 'Retained context' } });
        const read = await fixture.post('get', {});
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json().description).toMatchObject({ kind: 'available', label: {
            content: { t: 'plain', v: 'Retained context' }, recipientEnvelope: null, legacyPlaintext: true } });
        expect(fixture.openDescription(read.json())).toBe('Retained context');
        expect((await db.teamGroup.findUniqueOrThrow({ where: { id: fixture.groupId } })).description).toBe('Retained context');
        for (const description of ['Raw new text', plainPrivateLabel('Plain current content'),
            { ...plainPrivateLabel('Forged legacy write'), legacyPlaintext: true }]) {
            const refused = await fixture.post('update', { description });
            expect(refused.statusCode, refused.body).toBe(400);
        }
        expect((await db.teamGroup.findUniqueOrThrow({ where: { id: fixture.groupId } })).description).toBe('Retained context');
        const saved = await fixture.post('update', { description: await fixture.seal('description', 'Retained context') });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json().description.label.legacyPlaintext).toBeUndefined();
        expect(fixture.openDescription(saved.json())).toBe('Retained context');
        expect((await db.teamGroup.findUniqueOrThrow({ where: { id: fixture.groupId } })).description).not.toContain('Retained context');
        await db.teamGroup.update({ where: { id: fixture.groupId }, data: { description: '{"content":{"t":"encrypted","c":"broken"}}' } });
        const malformed = await fixture.post('get', {});
        expect(malformed.statusCode, malformed.body).toBe(200);
        expect(malformed.json().description).toEqual({ kind: 'unavailable' });
    });
});
