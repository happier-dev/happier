import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@/storage/inTx";
import * as catalog from "./resourceRead";
import { readTeamCredentialCustodianResourcePageInTx } from './resourceCustodianRead';
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Account credential discovery (PostgreSQL)", () => {
    let client: PrismaClientType;
    let selects = 0;
    let maxBindings = 0;
    let projectedMembershipRows = 0;
    const observeMembershipRows = (base: PrismaClientType) => base.$extends({ query: { teamMembership: {
        async findMany({ args, query }) {
            const rows = await query(args);
            if (args.select?.groupMemberships) projectedMembershipRows += rows.length;
            return rows;
        },
    } } });
    let observedClient: ReturnType<typeof observeMembershipRows>;
    beforeAll(async () => {
        client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        onDbClientQuery(client, event => {
            if (/^SELECT\b/i.test(event.query)) selects++;
            // Prisma's parameter display is not JSON for quoted stored-source data.
            // This PostgreSQL suite counts the actual numbered SQL bind positions.
            const bindings = [...event.query.matchAll(/\$(\d+)\b/g)].reduce((maximum, match) => Math.max(maximum, Number(match[1])), 0);
            maxBindings = Math.max(maxBindings, bindings);
        });
        observedClient = observeMembershipRows(client);
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); });

    it("reads exactly one authorized resource in a large Team and observes withdrawal", async () => {
        const actor = await client.account.create({ data: { encryptionMode: "plain" } });
        const owner = await client.account.create({ data: { encryptionMode: "plain" } });
        const team = await client.team.create({ data: { name: "Exact catalog" } });
        const ids = Array.from({ length: 351 }, () => randomUUID());
        let candidates = 0;
        let usageIdentityRows = 0;
        const observed = client.$extends({ query: { teamCredentialResource: {
            async findMany({ args, query }) {
                const rows = await query(args);
                // Count the candidate window separately from the narrow usage
                // identity projection.
                if (args.select) {
                    expect(rows.map(row => row.id)).toEqual([ids[350]]);
                    usageIdentityRows += rows.length;
                } else candidates += rows.length;
                return rows;
            },
        } } });
        try {
            await client.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: owner.id, role: "owner" },
                { teamId: team.id, accountId: actor.id, role: "member" },
            ] });
            await client.teamCredentialResource.createMany({ data: ids.map((id, index) => ({
                id, teamId: team.id, custodianAccountId: owner.id, displayName: `Resource ${String(index).padStart(3, "0")}`,
                sourceBindingJson: "{}", disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
                allMembersDeliveryMode: "brokered",
            })) });
            const input = { teamId: team.id, resourceId: ids[350]!, actorAccountId: actor.id,
                authentication: { authenticationAuthority: "present_user" as const } };
            const read = () => observed.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx as unknown as Tx, input));
            const result = await read();
            expect(candidates).toBe(1);
            expect(usageIdentityRows).toBe(1);
            expect(result.ok && result.page.resources.map(row => row.id)).toEqual([ids[350]]);
            expect(result.ok && result.page.nextCursor).toBeNull();
            await client.teamCredentialResource.update({ where: { id: ids[350] }, data: { allMembersDeliveryMode: null } });
            const withdrawn = await read();
            expect(withdrawn.ok && withdrawn.page.resources).toEqual([]);
            expect(candidates).toBe(1);
            expect(usageIdentityRows).toBe(1);
            await client.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: actor.id } },
                data: { status: "suspended" } });
            expect(await read()).toEqual({ ok: false, error: "not_found_or_not_visible" });
            expect(candidates).toBe(1);
            console.info("EXACT_TEAM_CATALOG", { inventory: ids.length, candidatesPerRead: candidates / 2, usageIdentityRows });
        } finally {
            await client.team.delete({ where: { id: team.id } });
            await client.account.deleteMany({ where: { id: { in: [actor.id, owner.id] } } });
        }
    });

    it('excludes self-custody before recipient pagination on PostgreSQL', async () => {
        const owner = await client.account.create({ data: { encryptionMode: 'plain' } });
        const member = await client.account.create({ data: { encryptionMode: 'plain' } });
        const team = await client.team.create({ data: { name: 'Recipient custody' } });
        const ownId = `aa-${randomUUID()}`;
        const foreignId = `zz-${randomUUID()}`;
        try {
            await client.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: owner.id, role: 'owner' },
                { teamId: team.id, accountId: member.id, role: 'member' },
            ] });
            const base = { teamId: team.id, sourceBindingJson: '{}', disclosureCeiling: 'brokered_only',
                sessionUsePolicy: 'personal_allowed', allMembersDeliveryMode: 'brokered' };
            await client.teamCredentialResource.createMany({ data: [
                { ...base, id: ownId, custodianAccountId: owner.id, displayName: 'Own source' },
                { ...base, id: foreignId, custodianAccountId: member.id, displayName: 'Member source' },
            ] });
            const input = { actorAccountId: owner.id, limit: 1,
                authentication: { authenticationAuthority: 'present_user' as const } };
            const page = await client.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx as unknown as Tx,
                { ...input, teamId: team.id }));
            const discovery = await client.$transaction(tx => catalog.readTeamCredentialDiscoveryInTx(tx as unknown as Tx,
                { ...input, teamIds: [team.id] }));
            for (const result of [page, discovery]) {
                expect(result.ok && result.page.resources.map(row => row.id)).toEqual([foreignId]);
                expect(result.ok && result.page.nextCursor).toBeNull();
            }
            const memberPage = await client.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx as unknown as Tx,
                { ...input, actorAccountId: member.id, teamId: team.id }));
            expect(memberPage.ok && memberPage.page.resources.map(row => row.id)).toEqual([ownId]);
        } finally {
            await client.team.delete({ where: { id: team.id } });
            await client.account.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
        }
    });

    it('selects one owned direct source across 101 Teams and 351 resources on PostgreSQL', async () => {
        const actor = await client.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await client.account.create({ data: { encryptionMode: 'plain' } });
        const teamIds = Array.from({ length: 101 }, () => randomUUID());
        const ownedId = randomUUID();
        let candidates = 0;
        const observed = client.$extends({ query: { teamCredentialResource: {
            async findMany({ args, query }) { const rows = await query(args); candidates += rows.length; return rows; },
        } } });
        try {
            await client.team.createMany({ data: teamIds.map(id => ({ id, name: 'Custodian count' })) });
            await client.teamMembership.createMany({ data: teamIds.map(teamId => ({ teamId, accountId: actor.id, role: 'owner' })) });
            const sourceBindingJson = JSON.stringify({ v: 1, kind: 'provider_connection', connectionId: 'pc_source',
                connectionSecurityFingerprint: 'connection-security:v1:test', credentialSlotId: 'apiKey' });
            const base = { sourceBindingJson, displayName: 'Direct source', disclosureCeiling: 'direct_allowed',
                sessionUsePolicy: 'personal_allowed', allMembersDeliveryMode: 'direct' };
            await client.teamCredentialResource.createMany({ data: [
                ...Array.from({ length: 350 }, (_, index) => ({ ...base, id: randomUUID(), teamId: teamIds[index % 101]!, custodianAccountId: foreign.id })),
                { ...base, id: ownedId, teamId: teamIds[100]!, custodianAccountId: actor.id },
            ] });
            const read = () => observed.$transaction(tx => readTeamCredentialCustodianResourcePageInTx(tx as unknown as Tx, {
                actorAccountId: actor.id, authentication: { authenticationAuthority: 'present_user' },
            }));
            const result = await read();
            expect(result.ok && result.page.resources.map(row => row.id)).toEqual([ownedId]);
            expect(candidates).toBe(1);
            await client.teamCredentialResource.update({ where: { id: ownedId }, data: { custodianAccountId: foreign.id } });
            const withdrawn = await read();
            expect(withdrawn.ok && withdrawn.page.resources).toEqual([]);
            expect(candidates).toBe(1);
            console.info('EXACT_CUSTODIAN_CATALOG', { teams: 101, resources: 351, selectedCandidates: candidates });
        } finally {
            await client.team.deleteMany({ where: { id: { in: teamIds } } });
            await client.account.deleteMany({ where: { id: { in: [actor.id, foreign.id] } } });
        }
    });

    it("keeps catalog SQL independent of Team count, chunks inventory binds, and preserves current refusals", async () => {
        const actor = await client.account.create({ data: { encryptionMode: "plain" } });
        const custodian = await client.account.create({ data: { encryptionMode: "plain" } });
        const otherCustodians = await Promise.all(Array.from({ length: 5 }, () => client.account.create({
            data: { encryptionMode: "plain" },
        })));
        const custodians = [custodian, ...otherCustodians];
        const teamIds = Array.from({ length: 1001 }, () => randomUUID());
        const authentication = { authenticationAuthority: "present_user" as const };
        try {
            await client.team.createMany({ data: teamIds.map((id, index) => ({ id, name: `Catalog ${index}` })) });
            // Seed in portable chunks too: test setup must not hide a production bind failure.
            for (let index = 0; index < teamIds.length; index += 100) {
                await client.teamMembership.createMany({ data: teamIds.slice(index, index + 100).flatMap(teamId => [
                    { teamId, accountId: actor.id, role: "member" },
                    { teamId, accountId: custodian.id, role: "owner" },
                ]) });
            }
            await client.teamMembership.createMany({ data: teamIds.slice(0, 6).flatMap(teamId => otherCustodians.map(account => ({
                teamId, accountId: account.id, role: "member",
            }))) });
            const resources = await Promise.all(teamIds.slice(0, 6).map((teamId, index) => client.teamCredentialResource.create({ data: {
                teamId, custodianAccountId: custodians[index]!.id, displayName: `Resource ${index}`,
                sourceBindingJson: "{}", disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
                allMembersDeliveryMode: "brokered",
            } })));
            const read = async (ids: string[], cursor?: string) => {
                selects = 0;
                maxBindings = 0;
                projectedMembershipRows = 0;
                // Prisma's query-extension transaction type differs from the client transaction type.
                const result = await observedClient.$transaction(tx => catalog.readTeamCredentialDiscoveryInTx(tx as unknown as Tx, {
                    teamIds: ids, actorAccountId: actor.id, authentication, limit: 100, ...(cursor ? { cursor } : {}),
                }), { isolationLevel: "RepeatableRead" });
                return { result, selects, maxBindings, projectedMembershipRows };
            };
            const single = await read([teamIds[0]!]);
            const six = await read(teamIds.slice(0, 6));
            expect(six.result.ok).toBe(true);
            if (!six.result.ok) throw new Error("Discovery must succeed");
            expect(six.result.page.resources.map(row => row.id).sort()).toEqual(resources.map(row => row.id).sort());
            expect(six.selects).toBe(single.selects);
            expect(six.projectedMembershipRows).toBe(12);
            const inventory = await read(teamIds);
            expect(inventory.result).toEqual(six.result);
            expect(inventory.maxBindings).toBeLessThanOrEqual(999);
            expect(inventory.selects).toBeLessThan(six.selects * 3);
            expect(inventory.projectedMembershipRows).toBe(12);
            selects = 0;
            for (const teamId of teamIds.slice(0, 6)) {
                await client.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx, {
                    teamId, actorAccountId: actor.id, authentication,
                }));
            }
            console.info("TEAM_CREDENTIAL_DISCOVERY_SQL", { oneTeam: single.selects, sixTeams: six.selects,
                teams1001: inventory.selects, maxBindings: inventory.maxBindings, oldSixTeamReads: selects,
                projectedMembershipRows: six.projectedMembershipRows });

            const old = await client.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx, {
                teamId: teamIds[0]!, actorAccountId: actor.id, authentication,
            }));
            expect(single.result.ok && single.result.page.resources).toEqual(old.ok && old.page.resources.map(
                ({ sharedWithTeamScope, ...resource }) => {
                    expect(sharedWithTeamScope).toBe('team');
                    return resource;
                },
            ));
            await client.teamMembership.update({ where: { teamId_accountId: { teamId: teamIds[0]!, accountId: actor.id } },
                data: { status: "suspended" } });
            await client.teamMembership.delete({ where: { teamId_accountId: { teamId: teamIds[1]!, accountId: actor.id } } });
            await client.teamCredentialResource.update({ where: { id: resources[2]!.id }, data: { allMembersDeliveryMode: null } });
            const missing = randomUUID();
            const refused = await read([...teamIds.slice(0, 6), missing]);
            expect(refused.result.ok).toBe(true);
            if (!refused.result.ok) throw new Error("Discovery must retain admitted siblings");
            expect(refused.result.page.failures).toEqual([
                { teamId: teamIds[0], error: "not_found_or_not_visible" },
                { teamId: teamIds[1], error: "not_found_or_not_visible" },
                { teamId: missing, error: "not_found_or_not_visible" },
            ]);
            expect(refused.result.page.resources.map(row => row.id).sort()).toEqual(resources.slice(3).map(row => row.id).sort());
            expect((await read([])).result).toMatchObject({ ok: true, page: { resources: [], nextCursor: null, failures: [] } });
            const page = await client.$transaction(tx => catalog.readTeamCredentialDiscoveryInTx(tx, {
                teamIds: teamIds.slice(3, 6), actorAccountId: actor.id, authentication, limit: 1,
            }));
            expect(page.ok && page.page.nextCursor).toBeTypeOf("string");
            if (!page.ok || !page.page.nextCursor) throw new Error("Discovery must page");
            const next = await read(teamIds.slice(3, 6).reverse(), page.page.nextCursor);
            expect(next.result.ok && next.result.page.resources.map(row => row.id)).toEqual(resources.slice(4).map(row => row.id));
            expect((await read([teamIds[4]!], page.page.nextCursor)).result).toEqual({ ok: false, error: "invalid_resource_input" });
            await client.team.update({ where: { id: teamIds[3]! }, data: { authenticationPolicy: {
                v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "email_password" }],
            } } });
            const restrictedOld = await client.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx, {
                teamId: teamIds[3]!, actorAccountId: actor.id, authentication,
            }));
            expect(restrictedOld.ok).toBe(false);
            const restricted = await read(teamIds.slice(3, 6));
            expect(restricted.result.ok && restricted.result.page.failures).toEqual(restrictedOld.ok ? [] : [
                { teamId: teamIds[3], error: restrictedOld.error },
            ]);
            await client.account.update({ where: { id: actor.id }, data: { status: "disabled" } });
            expect((await read([teamIds[4]!])).result).toMatchObject({ ok: true,
                page: { resources: [], failures: [{ teamId: teamIds[4], error: "not_found_or_not_visible" }] } });
        } finally {
            for (let index = 0; index < teamIds.length; index += 100) {
                await client.team.deleteMany({ where: { id: { in: teamIds.slice(index, index + 100) } } });
            }
            await client.account.deleteMany({ where: { id: { in: [actor.id, ...custodians.map(account => account.id)] } } });
        }
    });
});
