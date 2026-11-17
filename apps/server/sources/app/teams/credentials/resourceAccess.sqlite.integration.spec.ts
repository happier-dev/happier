import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { resolveTeamCredentialEntitlementInTx } from "./resourceAccess";
import { countTeamCredentialResourcesInTx, readTeamCredentialCatalogInTx } from './resourceRead';
import { PrismaClient } from '../../../../generated/sqlite-client';
import { readTeamCredentialResourceCandidatesInTx } from './resourceCandidateRead';

function createQueryClient() {
    return new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
}

describe("Team credential transactional entitlement", () => {
    let harness: LightSqliteHarness;
    let queryClient: ReturnType<typeof createQueryClient>;
    let originalTransaction: typeof db.$transaction;
    const queries: string[] = [];
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-resource-access-", initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' } });
        queryClient = createQueryClient();
        queryClient.$on('query', event => queries.push(event.query));
        await queryClient.$connect();
        originalTransaction = db.$transaction;
        // Trace the real persistent boundary; entitlement, feature and catalog owners remain real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(queryClient.$transaction, queryClient, args);
        } });
    }, 180_000);
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await queryClient?.$disconnect();
        await harness?.close();
    });

    it("re-reads Group, Account, custodian and Team lifecycle on an existing resource", async () => {
        const custodian = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Credential access" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "guest" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Developers") } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Shared connection",
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "pc_source", connectionSecurityFingerprint: "connection-security:v1:source", credentialSlotId: "apiKey" }),
            groupGrants: { create: { teamGroupId: group.id, deliveryMode: "brokered" } },
        } });
        const resolve = () => inTx(tx => resolveTeamCredentialEntitlementInTx(tx, { resourceId: resource.id, accountId: recipient.id }));
        await expect(resolve()).resolves.toMatchObject({ ok: true, mayBroker: true, mayReceiveDirect: false });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: null } });
        await db.account.update({ where: { id: recipient.id }, data: { status: "suspended" } });
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
        await db.account.update({ where: { id: recipient.id }, data: { status: "active" } });
        await db.account.update({ where: { id: custodian.id }, data: { status: "suspended" } });
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "source_owner_required" });
        await db.account.update({ where: { id: custodian.id }, data: { status: "active" } });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
    });

    it("excludes guests from Team-wide access and never transfers an exact grant to a new membership lifetime", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
        const guest = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Guest credential access" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const firstMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: "guest" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Guest-scoped connection",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            allMembersDeliveryMode: "brokered",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "pc_guest",
                connectionSecurityFingerprint: "connection-security:v1:guest",
                credentialSlotId: "apiKey",
            }),
        } });
        const resolve = () => inTx(tx => resolveTeamCredentialEntitlementInTx(tx, {
            resourceId: resource.id,
            accountId: guest.id,
        }));

        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
        await db.teamCredentialMemberGrant.create({ data: {
            resourceId: resource.id,
            teamMembershipId: firstMembership.id,
            deliveryMode: "brokered",
        } });
        await expect(resolve()).resolves.toMatchObject({
            ok: true,
            matchedGrants: [{ kind: "team_member", teamMembershipId: firstMembership.id }],
        });

        await db.teamMembership.delete({ where: { id: firstMembership.id } });
        const rejoinedMembership = await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: guest.id,
            role: "guest",
        } });
        expect(rejoinedMembership.id).not.toBe(firstMembership.id);
        expect(await db.teamCredentialMemberGrant.count({ where: { resourceId: resource.id } })).toBe(0);
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
    });

    it('selects a recipient page across 1001 Teams without expanding entitlement SQL per Team', async () => {
        const [actor, custodian] = await Promise.all(Array.from({ length: 2 }, () =>
            db.account.create({ data: { encryptionMode: 'plain' } })));
        const teamIds = Array.from({ length: 1001 }, () => crypto.randomUUID());
        await db.team.createMany({ data: teamIds.map(id => ({ id, name: 'Discovery query shape' })) });
        for (let offset = 0; offset < teamIds.length; offset += 100) {
            await db.teamMembership.createMany({ data: teamIds.slice(offset, offset + 100).flatMap(teamId => [
                { teamId, accountId: actor.id, role: 'member' },
                { teamId, accountId: custodian.id, role: 'owner' },
            ]) });
        }
        const base = { teamId: teamIds[0]!, displayName: storedPlainPrivateLabel('Connection'),
            sourceBindingJson: '{}', disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
            allMembersDeliveryMode: 'brokered' };
        const own = await db.teamCredentialResource.create({ data: { ...base, id: `aa-${crypto.randomUUID()}`,
            custodianAccountId: actor.id } });
        const received = await db.teamCredentialResource.create({ data: { ...base, id: `zz-${crypto.randomUUID()}`,
            custodianAccountId: custodian.id } });
        const read = () => inTx(tx => readTeamCredentialResourceCandidatesInTx(tx, {
            selection: { kind: 'recipient', accountId: actor.id, teamIds }, after: null, limit: 1,
        }));
        queries.length = 0;
        expect((await read()).map(row => row.id)).toEqual([received.id]);
        const pageQueries = queries.filter(query => query.includes('TeamCredentialResource'));
        // One portable Team-id chunk per SQL parameter window plus only the selected page hydration.
        expect(pageQueries.length).toBeLessThanOrEqual(3);
        expect(pageQueries.every(query => (query.match(/\?/g) ?? []).length <= 999)).toBe(true);
        await db.teamCredentialResource.update({ where: { id: received.id }, data: { allMembersDeliveryMode: null } });
        expect(await read()).toEqual([]);
        expect(await db.teamCredentialResource.findUnique({ where: { id: own.id } })).not.toBeNull();
    });

    it('counts the recipient catalog through Group withdrawal and retained unavailable source states', async () => {
        const [custodian, recipient, administrator] = await Promise.all(Array.from({ length: 3 }, () =>
            db.account.create({ data: { encryptionMode: 'plain' } })));
        const team = await db.team.create({ data: { name: 'Recipient count' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: custodian.id, role: 'owner' },
            { teamId: team.id, accountId: recipient.id, role: 'member' },
            { teamId: team.id, accountId: administrator.id, role: 'admin' },
        ] });
        const membership = await db.teamMembership.findUniqueOrThrow({ where: {
            teamId_accountId: { teamId: team.id, accountId: recipient.id },
        } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Readers') } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: membership.id, nativeContribution: true } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: storedPlainPrivateLabel('Connection'),
            disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify({ v: 1, kind: 'provider_connection', connectionId: 'missing-source',
                connectionSecurityFingerprint: 'connection-security:v1:missing', credentialSlotId: 'apiKey' }),
            groupGrants: { create: { teamGroupId: group.id, deliveryMode: 'brokered' } },
        } });
        const assertCatalog = async (actorAccountId: string, expected: number, scope = 'group') => inTx(async tx => {
            const input = { teamId: team.id, actorAccountId,
                authentication: { authenticationAuthority: 'present_user' as const } };
            queries.length = 0;
            const count = await countTeamCredentialResourcesInTx(tx, input);
            const resourceQueries = queries.filter(query => query.includes('TeamCredentialResource'));
            expect(resourceQueries).toHaveLength(1);
            expect(resourceQueries[0]).toMatch(/\bCOUNT\s*\(/i);
            expect(resourceQueries[0]).not.toContain('displayName');
            expect(resourceQueries[0]).not.toContain('sourceBindingJson');
            const page = await readTeamCredentialCatalogInTx(tx, input);
            expect(count).toEqual({ ok: true, count: expected });
            expect(page.ok).toBe(true);
            if (page.ok) {
                expect(page.page.resources).toHaveLength(expected);
                for (const entry of page.page.resources) expect(entry.sharedWithTeamScope).toBe(scope);
                return page.page.resources;
            }
        });
        await assertCatalog(recipient.id, 1);
        await assertCatalog(administrator.id, 0);
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { allMembersDeliveryMode: 'brokered' } });
        await assertCatalog(administrator.id, 1, 'team');
        await assertCatalog(recipient.id, 1, 'team_and_group');
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { enabled: false } });
        await assertCatalog(recipient.id, 0);
        await db.account.update({ where: { id: custodian.id }, data: { status: 'suspended' } });
        await assertCatalog(recipient.id, 1, 'team_and_group');
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: {
            displayName: '{"content":{"t":"encrypted","c":"bad"},"recipients":[]}',
        } });
        const malformedLabel = await assertCatalog(recipient.id, 1, 'team_and_group');
        expect(malformedLabel?.[0]).toMatchObject({
            id: resource.id, displayName: null, readiness: { kind: 'resource_corrupt' },
            recoveryAction: 'source_owner_action', mayBroker: false, mayReceiveDirect: false,
        });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { allMembersDeliveryMode: null } });
        await assertCatalog(administrator.id, 0);
        await assertCatalog(recipient.id, 1, 'group');
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { allMembersDeliveryMode: 'brokered' } });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { displayName: storedPlainPrivateLabel('Connection') } });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        await assertCatalog(recipient.id, 1, 'team');
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { allMembersDeliveryMode: null } });
        await assertCatalog(recipient.id, 0);
    });
});
