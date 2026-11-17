import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { formatSharedSavedSecretRefV1, SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol';

import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { createSavedSecretResourceInTx, setSavedSecretResourceGrantsInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { hashPasswordMaterial } from '@/app/auth/password/passwordMaterialVerifier';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import { registerSavedSecretResourceRoutes } from './registerSavedSecretResourceRoutes';

const listPath = homeDomainActionPathForMethod('secrets.shared.list', 'GET');
const EMAIL_PASSWORD = { kind: 'home_method' as const, methodId: 'email_password' };
const PASSWORD_HOME = {
    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
};

async function createSecret(accountId: string, resourceId: string, audience: Partial<Pick<
    Parameters<typeof createSavedSecretResourceInTx>[1], 'accountGrants' | 'teamGrants' | 'groupGrants' | 'authentication'
>> = {}): Promise<void> {
    expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
        accountId, resourceId, displayName: resourceId, kind: 'token', encryptionMode: 'plain',
        storedContent: { t: 'plain', v: { v: 1, name: resourceId, kind: 'token', value: 'private-native-sentinel' } },
        ...audience,
    }))).toMatchObject({ ok: true });
}

describe('Saved Secret selected-Team catalog HTTP (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'saved-secret-team-catalog-',
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' }, initAuth: false, initEncrypt: true });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(), () => db.savedSecretResourceKeyEnvelope.deleteMany(),
            () => db.savedSecretGroupGrant.deleteMany(), () => db.savedSecretTeamGrant.deleteMany(),
            () => db.savedSecretAccountGrant.deleteMany(), () => db.savedSecretResource.deleteMany(),
            () => db.teamGroupMembership.deleteMany(), () => db.teamGroup.deleteMany(),
            () => db.teamMembership.deleteMany(), () => db.team.deleteMany(),
            () => db.accountPasswordCredential.deleteMany(), () => db.accountIdentity.deleteMany(),
            () => db.userRelationship.deleteMany(), () => db.account.deleteMany(),
        ]);
    });

    it('pages only selected-Team metadata, excludes foreign Groups from an administrator, and preserves the ordinary catalog', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Selected Team' } });
        const other = await db.team.create({ data: { name: 'Other Team' } });
        const custodianMembership = await db.teamMembership.create({
            data: { accountId: custodian.id, teamId: team.id, role: 'owner' } });
        const viewerMembership = await db.teamMembership.create({
            data: { accountId: viewer.id, teamId: team.id, role: 'owner' } });
        await db.teamMembership.createMany({ data: [
            { accountId: custodian.id, teamId: other.id, role: 'owner' },
            { accountId: viewer.id, teamId: other.id, role: 'member' },
        ] });
        const ownGroup = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Own Group') } });
        const foreignGroup = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Foreign Group') } });
        await db.teamGroupMembership.createMany({ data: [
            { teamId: team.id, teamGroupId: ownGroup.id, teamMembershipId: custodianMembership.id },
            { teamId: team.id, teamGroupId: ownGroup.id, teamMembershipId: viewerMembership.id },
            { teamId: team.id, teamGroupId: foreignGroup.id, teamMembershipId: custodianMembership.id },
        ] });
        await createSecret(custodian.id, 'ss-a-team', { teamGrants: [team.id] });
        await createSecret(custodian.id, 'ss-b-group', { groupGrants: [ownGroup.id] });
        await createSecret(custodian.id, 'ss-c-both', { teamGrants: [team.id], groupGrants: [ownGroup.id] });
        await createSecret(custodian.id, 'ss-d-foreign', { groupGrants: [foreignGroup.id] });
        await createSecret(custodian.id, 'ss-e-other-team', { teamGrants: [other.id] });
        await createSecret(viewer.id, 'ss-f-personal');
        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': viewer.id };
        const expectedGlobal = ['ss-a-team', 'ss-b-group', 'ss-c-both', 'ss-e-other-team', 'ss-f-personal']
            .map(formatSharedSavedSecretRefV1).sort();
        const read = async (query = '') => {
            const response = await app.inject({ method: 'GET', url: `${listPath}${query}`, headers });
            expect(response.statusCode).toBe(200);
            expect(response.body).not.toContain('private-native-sentinel');
            expect(response.body).not.toContain('storedContent');
            expect(response.body).not.toContain('encryptedDataKey');
            return SharedSavedSecretListOutputV1Schema.parse(response.json());
        };
        try {
            // This control reaches the incumbent native owner before testing its new filter.
            const global = await read();
            expect(global.resources.map(row => 'ref' in row ? row.ref : null).sort()).toEqual(expectedGlobal);
            expect(global).not.toHaveProperty('nextCursor');
            const selected = `?sharedWithTeamId=${team.id}&limit=1`;
            const first = await read(selected);
            expect(first.resources).toMatchObject([{ ref: formatSharedSavedSecretRefV1('ss-a-team'), sharedWithTeamScope: 'team' }]);
            expect(first.resources).toHaveLength(1);
            expect(first.nextCursor).toBe('ss-a-team');
            const second = await read(`${selected}&cursor=${first.nextCursor}`);
            expect(second.resources).toMatchObject([{ ref: formatSharedSavedSecretRefV1('ss-b-group'), sharedWithTeamScope: 'group' }]);
            expect(second.resources).toHaveLength(1);
            expect(second.nextCursor).toBe('ss-b-group');
            const third = await read(`${selected}&cursor=${second.nextCursor}`);
            expect(third.resources).toMatchObject([{ ref: formatSharedSavedSecretRefV1('ss-c-both'), sharedWithTeamScope: 'team_and_group' }]);
            expect(third.resources).toHaveLength(1);
            expect(third.nextCursor).toBeNull();
            expect((await read(`?sharedWithTeamId=${team.id}&cursor=ss-c-both&limit=1`)).resources).toEqual([]);
            expect((await read()).resources.map(row => 'ref' in row ? row.ref : null).sort()).toEqual(expectedGlobal);
            // An independent direct grant admits this retained Team audience,
            // without making the private Group's identity visible to its recipient.
            await db.userRelationship.create({ data: { fromUserId: custodian.id, toUserId: viewer.id, status: 'friend' } });
            expect(await inTx(tx => setSavedSecretResourceGrantsInTx(tx, {
                accountId: custodian.id, resourceId: 'ss-d-foreign', expectedRevision: 1,
                accountGrants: [viewer.id], teamGrants: [], groupGrants: [foreignGroup.id],
            }))).toMatchObject({ ok: true });
            const independent = await read(`?sharedWithTeamId=${team.id}&cursor=ss-c-both&limit=1`);
            expect(independent.resources).toMatchObject([{ ref: formatSharedSavedSecretRefV1('ss-d-foreign'),
                sharedWithTeamScope: 'group', accessSources: [{ kind: 'account' }], audience: null }]);
            expect(JSON.stringify(independent)).not.toContain(foreignGroup.id);
            expect(JSON.stringify(independent)).not.toContain('Foreign Group');
        } finally { await app.close(); }
    });

    it('qualifies the native selected-Team request credential and refuses unqualified or withdrawn membership', async () => {
        harness.resetEnv(PASSWORD_HOME);
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Restricted Team',
            authenticationPolicy: { v: 1, mode: 'restricted', accepted: [EMAIL_PASSWORD] } } });
        await db.teamMembership.createMany({ data: [
            { accountId: owner.id, teamId: team.id, role: 'owner' },
            { accountId: viewer.id, teamId: team.id, role: 'member' },
        ] });
        const hash = await hashPasswordMaterial(new TextEncoder().encode('fixture-password'));
        for (const accountId of [owner.id, viewer.id]) {
            await db.accountIdentity.create({ data: { accountId, provider: 'email', providerUserId: `${accountId}@example.test`, profile: {} } });
            await db.accountPasswordCredential.create({ data: { accountId,
                credential: { v: 1, kind: 'plain_password_hash', hash } } });
        }
        const authentication = { env: process.env, authenticationAuthority: 'present_user' as const,
            authenticationEvidence: [EMAIL_PASSWORD] };
        await createSecret(owner.id, 'restricted-team-secret', { teamGrants: [team.id], authentication });
        await createSecret(viewer.id, 'personal-secret');
        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': viewer.id };
        const url = `${listPath}?sharedWithTeamId=${team.id}&limit=1`;
        try {
            const global = await app.inject({ method: 'GET', url: listPath, headers });
            expect(global.statusCode).toBe(200);
            expect(SharedSavedSecretListOutputV1Schema.parse(global.json()).resources.map(row => 'ref' in row ? row.ref : null))
                .toEqual([formatSharedSavedSecretRefV1('personal-secret')]);
            const unqualified = await app.inject({ method: 'GET', url, headers });
            expect({ status: unqualified.statusCode, body: unqualified.json() })
                .toEqual({ status: 403, body: { error: 'team_authentication_required' } });
            const qualifiedHeaders = { ...headers, 'x-test-authentication-evidence': JSON.stringify([EMAIL_PASSWORD]) };
            const qualified = await app.inject({ method: 'GET', url, headers: qualifiedHeaders });
            expect(qualified.statusCode).toBe(200);
            expect(SharedSavedSecretListOutputV1Schema.parse(qualified.json()).resources)
                .toMatchObject([{ ref: formatSharedSavedSecretRefV1('restricted-team-secret'), sharedWithTeamScope: 'team' }]);
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: viewer.id } },
                data: { status: 'suspended' } });
            const withdrawn = await app.inject({ method: 'GET', url, headers: qualifiedHeaders });
            expect({ status: withdrawn.statusCode, body: withdrawn.json() })
                .toEqual({ status: 403, body: { error: 'forbidden' } });
        } finally { await app.close(); }
    });
});
