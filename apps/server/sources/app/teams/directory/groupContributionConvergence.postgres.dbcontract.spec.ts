import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { withAccountPublicationBeforeTransactionSql } from "@/app/changes/accountPublicationContention.testkit";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { type Tx } from "@/storage/inTx";
import { acquireTeamMutationLockInTx } from "../actorContext";
import { registerTeamGroupRoutes } from "../groups/registerTeamGroupRoutes";
import { completeDirectoryProjection, commitActiveWorkosProjectionEvent } from "./directoryProjectionRepository";
import { removeDirectorySourceForObservedDeletion } from "./directorySourceService";
import { removeDirectorySourceForActor } from "./directorySourceAdministration";
import { removeExternalGroupBindingForActor, setExternalGroupBindingForActor } from "./externalGroupBindingAdministration";

const operations = ["native_add", "native_remove", "binding_remove", "source_remove", "actor_source_remove", "complete", "event", "mapping"] as const;
type Operation = typeof operations[number];

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Group contribution convergence (PostgreSQL)", () => {
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    const previousEnv = new Map<string, string | undefined>();
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        for (const [key, value] of Object.entries({ HAPPIER_FEATURE_TEAMS__ENABLED: "1",
            WORKOS_API_KEY: "sk_test_contribution", WORKOS_CLIENT_ID: "client_contribution" })) {
            previousEnv.set(key, process.env[key]);
            process.env[key] = value;
        }
        initDbPostgres();
        await db.$connect();
        await db.homeGovernancePolicy.upsert({ where: { id: "home" },
            create: { id: "home", teamProviderPolicy: { v: 1, allowedTeamProviderKinds: ["workos_sso"],
                teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [] } },
            update: { teamProviderPolicy: { v: 1, allowedTeamProviderKinds: ["workos_sso"],
                teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [] } },
        });
        app = createAuthenticatedTestApp();
        registerTeamGroupRoutes(app);
        await app.ready();
    });
    afterAll(async () => {
        if (app) await app.close();
        await db.$disconnect();
        for (const [key, value] of previousEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    async function fixture(operation: Operation) {
        const actor = await db.account.create({ data: { encryptionMode: "plain" } });
        const person = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Contributions ${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "owner" } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: person.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Engineering")} });
        const provider = await db.identityProviderInstance.create({ data: { ownerTeamId: team.id, kind: "workos_sso",
            enabled: true, displayName: "Company", config: { v: 1, kind: "workos_sso" } } });
        const connection = await db.teamIdentityConnection.create({ data: { teamId: team.id, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_contributions", connectionId: null },
            settings: { v: 1, kind: "workos_sso" } } });
        const source = await db.teamDirectorySource.create({ data: { teamId: team.id, kind: "workos_directory",
            displayName: "Directory", externalSourceKey: randomUUID(), teamIdentityConnectionId: connection.id,
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_contributions" },
            state: operation === "complete" ? "initializing" : "active", eventCursor: "before",
            activeReconcileRunId: operation === "complete" ? "run" : null,
            activeReconcileStartedAt: operation === "complete" ? new Date() : null,
        } });
        await db.teamProvisionedIdentity.create({ data: { teamId: team.id, directorySourceId: source.id,
            externalUserId: "person", state: "active", boundAccountId: person.id, lastSeenReconcileRunId: "run" } });
        await db.teamDirectoryGroup.create({ data: { directorySourceId: source.id, externalGroupId: "engineering",
            externalDisplayName: "Engineering", state: "active", lastSeenReconcileRunId: "run" } });
        await db.teamDirectoryGroupMember.create({ data: { directorySourceId: source.id, externalGroupId: "engineering",
            externalUserId: "person", lastSeenReconcileRunId: "run" } });
        const membership = await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: member.id, nativeContribution: operation !== "native_add" } });
        const binding = operation === "mapping" ? null : await db.teamExternalGroupBinding.create({ data: {
            teamId: team.id, directorySourceId: source.id, teamGroupId: group.id,
            externalGroupId: "engineering", bindingMode: "native_target",
        } });
        if (binding) await db.teamGroupMembershipExternalContribution.create({ data: {
            teamGroupId: group.id, teamMembershipId: member.id, externalGroupBindingId: binding.id,
        } });
        const actorInput = { teamId: team.id, actorAccountId: actor.id, authenticationAuthority: "present_user" as const };
        async function run() {
            if (operation === "native_remove" || operation === "native_add") {
                const response = await app.inject({ method: "POST", url: `/v1/teams/groups/members/${operation === "native_add" ? "add" : "remove"}`,
                    headers: { "x-test-user-id": actor.id }, payload: { v: 1, teamId: team.id, groupId: group.id, accountId: person.id,
                        ...(operation === "native_add" ? { historyAccess: "from_membership" } : {}) } });
                expect(response.statusCode).toBe(200);
                return;
            }
            if (operation === "binding_remove") {
                expect(await removeExternalGroupBindingForActor({ ...actorInput, v: 1, bindingId: binding!.id }))
                    .toMatchObject({ ok: true, value: { outcome: "removed" } });
            } else if (operation === "mapping") {
                expect(await setExternalGroupBindingForActor({ ...actorInput, v: 1,
                    owner: { kind: "directory_source", directorySourceId: source.id }, externalGroupId: "engineering",
                    target: { kind: "native_target", teamGroupId: group.id } })).toMatchObject({ ok: true });
            } else if (operation === "actor_source_remove") {
                expect(await removeDirectorySourceForActor({ ...actorInput, sourceId: source.id }))
                    .toMatchObject({ ok: true, value: { status: "removed" } });
            } else if (operation === "source_remove") {
                expect(await removeDirectorySourceForObservedDeletion({ teamId: team.id, sourceId: source.id,
                    expectedState: "active", reconcileRunId: null, expectedPosition: { eventCursor: "before" } }))
                    .toEqual({ applied: true });
            } else if (operation === "complete") {
                expect(await completeDirectoryProjection({ sourceId: source.id, reconcileRunId: "run",
                    observedManualSyncRequestedAt: null })).toEqual({ applied: true });
            } else {
                expect(await commitActiveWorkosProjectionEvent({ sourceId: source.id, expectedPosition: { eventCursor: "before" },
                    eventId: "after", people: [{ externalUserId: "person", active: false }] })).toEqual({ applied: true });
            }
        }
        async function removeNative() {
            const response = await app.inject({ method: "POST", url: "/v1/teams/groups/members/remove",
                headers: { "x-test-user-id": actor.id }, payload: { v: 1, teamId: team.id, groupId: group.id, accountId: person.id } });
            expect(response.statusCode).toBe(200);
        }
        return { actor, team, group, person, membership, source, run, removeNative, operation };
    }

    it.each(operations)("%s commits under a concurrent Account cursor advance and preserves the union", async operation => {
        const f = await fixture(operation);
        const { advances } = await withAccountPublicationBeforeTransactionSql(f.actor.id,
            sql => sql.includes('FROM "Account"') && sql.endsWith("FOR NO KEY UPDATE"), f.run);
        expect(advances).toBeGreaterThan(0);
        const retained = await db.teamGroupMembership.findUniqueOrThrow({ where: {
            teamGroupId_teamMembershipId: { teamGroupId: f.group.id, teamMembershipId: f.membership.teamMembershipId },
        }, include: { externalContributions: true } });
        expect(retained.nativeContribution).toBe(operation !== "native_remove");
        expect(retained.externalContributions).toHaveLength(
            operation === "binding_remove" || operation === "source_remove" || operation === "actor_source_remove" || operation === "event" ? 0 : 1);
    });

    it.each(["binding_remove", "source_remove", "actor_source_remove", "complete", "event"] as const)(
        "%s and native withdrawal cannot leave an empty effective membership", async operation => {
        const f = await fixture(operation);
        if (operation === "complete") await db.teamDirectoryGroupMember.updateMany({
            where: { directorySourceId: f.source.id }, data: { lastSeenReconcileRunId: "obsolete" },
        });
        await Promise.all([f.run(), f.removeNative()]);
        expect(await db.teamGroupMembership.count({ where: { teamGroupId: f.group.id } })).toBe(0);
        expect(await db.teamGroupMembershipExternalContribution.count({ where: { teamGroupId: f.group.id } })).toBe(0);
    });

    it("mapping and an active roster event agree on the committed directory evidence", async () => {
        const f = await fixture("mapping");
        await Promise.all([f.run(), commitActiveWorkosProjectionEvent({ sourceId: f.source.id,
            expectedPosition: { eventCursor: "before" }, eventId: "after",
            people: [{ externalUserId: "person", active: false }],
        }).then(result => { expect(result).toEqual({ applied: true }); })]);
        expect(await db.teamExternalGroupBinding.count({ where: { directorySourceId: f.source.id } })).toBe(1);
        expect(await db.teamGroupMembershipExternalContribution.count({ where: { teamGroupId: f.group.id } })).toBe(0);
        expect(await db.teamGroupMembership.findUniqueOrThrow({ where: {
            teamGroupId_teamMembershipId: { teamGroupId: f.group.id, teamMembershipId: f.membership.teamMembershipId },
        } })).toMatchObject({ nativeContribution: true });
    });

    it("a native add committed during external withdrawal remains an effective membership", async () => {
        const f = await fixture("binding_remove");
        await db.teamGroupMembership.update({ where: { teamGroupId_teamMembershipId: {
            teamGroupId: f.group.id, teamMembershipId: f.membership.teamMembershipId,
        } }, data: { nativeContribution: false } });
        const original = db.$transaction;
        let interleaved = false;
        let peerStarted = false;
        let peerAtGuard!: () => void;
        const atGuard = new Promise<void>(resolve => { peerAtGuard = resolve; });
        let nativeAdd: Promise<Readonly<{ statusCode: number }>> | undefined;
        // Interleave at the actual Prisma read of the contribution union. A
        // guarded add queues behind withdrawal; an unguarded add can commit
        // while withdrawal still holds its old native=false observation.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const find = tx.teamGroupMembership.findUnique.bind(tx.teamGroupMembership);
                // Prisma is the system boundary; both real owners and queries execute unchanged.
                tx.teamGroupMembership.findUnique = (async (input: Parameters<typeof find>[0]) => {
                    const row = await find(input);
                    if (!interleaved && input.where.teamGroupId_teamMembershipId?.teamGroupId === f.group.id) {
                        interleaved = true;
                        peerStarted = true;
                        nativeAdd = Promise.resolve(app.inject({ method: "POST", url: "/v1/teams/groups/members/add",
                            headers: { "x-test-user-id": f.actor.id }, payload: { v: 1, teamId: f.team.id,
                                groupId: f.group.id, accountId: f.person.id, historyAccess: "from_membership" } }));
                        await Promise.race([atGuard, nativeAdd.then(response => { expect(response.statusCode).toBe(200); })]);
                    }
                    return row;
                }) as unknown as typeof tx.teamGroupMembership.findUnique;
                return callback(new Proxy(tx, { get(owner, property, proxyReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, proxyReceiver);
                    const query = tx.$queryRawUnsafe.bind(tx);
                    return (...values: Parameters<typeof query>) => {
                        if (peerStarted && values[0] === 'SELECT "id" FROM "Team" WHERE "id" = $1 FOR NO KEY UPDATE') peerAtGuard();
                        return query(...values);
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            await f.run();
            expect(interleaved).toBe(true);
            if (!nativeAdd) throw new Error("Native add did not reach the contribution boundary");
            expect((await nativeAdd).statusCode).toBe(200);
        } finally { db.$transaction = original; }
        expect(await db.teamGroupMembership.findUnique({ where: { teamGroupId_teamMembershipId: {
            teamGroupId: f.group.id, teamMembershipId: f.membership.teamMembershipId,
        } } })).toMatchObject({ nativeContribution: true });
        expect(await db.teamGroupMembershipExternalContribution.count({ where: { teamGroupId: f.group.id } })).toBe(0);
    });

    it.each(operations)("%s waits for the existing Team guard before consuming the contribution census", async operation => {
        const f = await fixture(operation);
        let releaseGuard!: () => void;
        let guardHeld!: () => void;
        const held = new Promise<void>(resolve => { guardHeld = resolve; });
        const release = new Promise<void>(resolve => { releaseGuard = resolve; });
        // A real opposing Team writer holds the production guard. Only Prisma's
        // SQL boundary is observed; all authority, union and effect code is real.
        const blocker = db.$transaction(async tx => {
            await acquireTeamMutationLockInTx(tx, f.team.id);
            guardHeld();
            await release;
        });
        await held;
        const original = db.$transaction;
        let attempted!: () => void;
        const atGuard = new Promise<"guard"> (resolve => { attempted = () => resolve("guard"); });
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(owner, property, proxyReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, proxyReceiver);
                    const query = tx.$queryRawUnsafe.bind(tx);
                    return (...values: Parameters<typeof query>) => {
                        if (values[0] === 'SELECT "id" FROM "Team" WHERE "id" = $1 FOR NO KEY UPDATE') attempted();
                        return query(...values);
                    };
                },
            })), ...args.slice(1)]);
        } });
        const running = f.run();
        try {
            expect(await Promise.race([atGuard, running.then(() => "committed" as const)])).toBe("guard");
        } finally {
            releaseGuard();
            db.$transaction = original;
            await blocker;
            await running;
        }
    });
});
