import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { preflightDirectorySourceRemovalForActor } from "./directorySourceAdministration";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Directory removal impact cost (PostgreSQL)", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("counts source removal consequences without transferring membership or contribution inventories", async () => {
        const actor = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Removal cost ${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "workos_sso", enabled: true, displayName: "Directory provider",
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: randomUUID(), connectionId: null },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: team.id, kind: "workos_directory", state: "active", displayName: "Directory",
            teamIdentityConnectionId: connection.id,
            externalSourceKey: randomUUID(), bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: randomUUID() },
        } });
        const otherSource = await db.teamDirectorySource.create({ data: {
            teamId: team.id, kind: "workos_directory", state: "active", displayName: "Other directory",
            teamIdentityConnectionId: connection.id,
            externalSourceKey: randomUUID(), bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: randomUUID() },
        } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Engineering")} });
        const bindingData = [source.id, source.id, otherSource.id].map((directorySourceId) => ({
            id: randomUUID(), teamId: team.id, teamGroupId: group.id, directorySourceId,
            externalGroupId: randomUUID(), bindingMode: "native_target" as const,
        }));
        await db.teamExternalGroupBinding.createMany({ data: bindingData });
        const connectionBinding = await db.teamExternalGroupBinding.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamIdentityConnectionId: connection.id,
            externalGroupId: randomUUID(), bindingMode: "native_target",
        } });
        const accounts = Array.from({ length: 303 }, () => ({ id: randomUUID(), encryptionMode: "plain" as const }));
        await db.account.createMany({ data: accounts });
        const memberships = accounts.map((account) => ({ id: randomUUID(), teamId: team.id, accountId: account.id, role: "member" as const }));
        await db.teamMembership.createMany({ data: memberships });
        await db.teamProvisionedIdentity.createMany({ data: memberships.map((membership, index) => ({
            directorySourceId: source.id, teamId: team.id, externalUserId: randomUUID(), state: "active" as const,
            boundAccountId: membership.accountId,
            ...(index < 300 ? { teamMembershipId: membership.id, teamMembershipTeamId: team.id } : {}),
        })) });
        await db.teamGroupMembership.createMany({ data: memberships.map((membership, index) => ({
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            nativeContribution: index < 300 || index === 301,
        })) });
        await db.teamGroupMembershipExternalContribution.createMany({ data: memberships.flatMap((membership, index) => {
            // Owned parent memberships remove every contribution. For native
            // parents, distinguish source-only, native, other-directory and
            // connection-owned facts. A NULL directorySourceId is another owner.
            const bindings = index === 300 ? bindingData.slice(0, 2)
                : [bindingData[0]!, index === 302 ? connectionBinding : bindingData[2]!];
            return bindings.map((binding) => ({ teamGroupId: group.id, teamMembershipId: membership.id, externalGroupBindingId: binding.id }));
        }) });

        let inventoryRowsTransferred = 0;
        const transaction = db.$transaction;
        // Observe the persistent database boundary without replacing any query,
        // authority decision, relation filter, or transaction implementation.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(owner, property, proxyReceiver) {
                const delegate: unknown = Reflect.get(owner, property, proxyReceiver);
                if ((property !== "teamProvisionedIdentity" && property !== "teamGroupMembershipExternalContribution")
                    || !delegate || typeof delegate !== "object") return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const query: unknown = Reflect.get(model, method, modelReceiver);
                    if (method !== "findMany" || typeof query !== "function") return query;
                    return async (...queryArgs: unknown[]) => {
                        const rows: unknown = await Reflect.apply(query, model, queryArgs);
                        if (Array.isArray(rows)) inventoryRowsTransferred += rows.length;
                        return rows;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const result = await preflightDirectorySourceRemovalForActor({
                teamId: team.id, sourceId: source.id, actorAccountId: actor.id,
                authenticationAuthority: "present_user",
            });
            expect(result).toMatchObject({ ok: true, value: { impact: {
                teamMembershipsRemoved: 300, groupMembershipsRemoved: 301,
                groupContributionsRemoved: 604, directoryCreatedGroupsRetained: 0,
                nativeMembershipsPreserved: 3, nativeGroupContributionsPreserved: 1,
            } } });
            expect(inventoryRowsTransferred).toBe(0);
        } finally { db.$transaction = transaction; }
    });
});
