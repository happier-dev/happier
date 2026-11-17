import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import type { Tx } from "@/storage/inTx";
import type { TeamRecord } from "../projections";

const persistence = vi.hoisted(() => ({
    team: { findUnique: vi.fn() },
    account: { findUnique: vi.fn() },
    teamMembership: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    teamDirectorySource: { findFirst: vi.fn() },
    teamProvisionedIdentity: { findMany: vi.fn() },
    teamDirectoryGroup: { findMany: vi.fn() },
    teamExternalGroupBinding: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
}));

// Prisma is the persistent-database boundary. Authority, transactions, readiness,
// and projections remain real; aggregate SQL executes against in-memory SQLite.
vi.mock("@/storage/db", () => ({
    db: {
        $transaction: async <T>(operation: (tx: Tx) => Promise<T>): Promise<T> =>
            operation(persistence as unknown as Tx),
    },
}));

import { listDirectoryGroupsForActor, listDirectoryPeopleForActor } from "./directorySourceAdministration";

const team = {
    id: "team-1",
    name: "Directory Team",
    description: null,
    logo: null,
    sessionCreationPolicy: "private_default", reviewCreationPolicy: "private_default",
    externalSharingPolicy: "allowed",
    defaultSessionHistoryAccess: "all_existing",
    admissionMode: "invite_only",
    authenticationPolicy: null,
    archivedAt: null,
} satisfies TeamRecord;

const source = {
    id: "source-1",
    displayName: "Directory",
    state: "active" as const,
    activeReconcileRunId: null,
    lastFullReconcileAt: new Date("2026-09-06T10:00:00.000Z"),
};

const input = { v: 1 as const, teamId: team.id, sourceId: source.id, actorAccountId: "owner" };

describe("directory administration read projections", () => {
    let database: DatabaseSync;

    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubEnv("HAPPIER_DB_PROVIDER", "sqlite");
        persistence.team.findUnique.mockResolvedValue(team);
        persistence.account.findUnique.mockResolvedValue({ id: "owner", homeRole: "member", status: "active" });
        persistence.teamMembership.findUnique.mockResolvedValue({ id: "owner-membership", role: "owner", status: "active" });
        persistence.teamMembership.count.mockResolvedValue(1);
        persistence.teamDirectorySource.findFirst.mockResolvedValue(source);
        persistence.teamExternalGroupBinding.findMany.mockResolvedValue([]);
        database = new DatabaseSync(":memory:");
        database.exec(`
            CREATE TABLE TeamProvisionedIdentity (
                directorySourceId TEXT NOT NULL, externalUserId TEXT NOT NULL, boundAccountId TEXT,
                PRIMARY KEY (directorySourceId, externalUserId)
            );
            CREATE TABLE TeamDirectoryGroupMember (
                directorySourceId TEXT NOT NULL, externalGroupId TEXT NOT NULL, externalUserId TEXT NOT NULL,
                PRIMARY KEY (directorySourceId, externalGroupId, externalUserId)
            );
        `);
        persistence.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
            // The SQLite system boundary accepts only concrete scalar bindings;
            // do not let the Prisma fixture silently coerce an unsupported value.
            const values: SQLInputValue[] = query.values.map((value) => {
                if (value === null || typeof value === "string" || typeof value === "number"
                    || typeof value === "bigint" || value instanceof Uint8Array) return value;
                throw new TypeError("Unsupported directory query fixture binding");
            });
            return database.prepare(query.sql).all(...values);
        });
    });

    afterEach(() => {
        database.close();
        vi.unstubAllEnvs();
    });

    it("projects distinct bound Accounts and unbound people only from the complete requested Group page", async () => {
        const person = database.prepare("INSERT INTO TeamProvisionedIdentity VALUES (?, ?, ?)");
        const member = database.prepare("INSERT INTO TeamDirectoryGroupMember VALUES (?, ?, ?)");
        for (const [sourceId, groupId, userId, accountId] of [
            [source.id, "group-1", "person-1", "account-1"],
            [source.id, "group-1", "person-2", "account-1"],
            [source.id, "group-1", "person-3", null],
            [source.id, "group-2", "person-4", "account-2"],
            ["other-source", "group-1", "person-5", "account-3"],
        ] satisfies Array<[string, string, string, string | null]>) {
            person.run(sourceId, userId, accountId);
            member.run(sourceId, groupId, userId);
        }
        persistence.teamDirectoryGroup.findMany.mockResolvedValue([
            { id: "group-row-1", externalGroupId: "group-1", externalDisplayName: "Engineering", state: "active", _count: { members: 3 } },
            { id: "group-row-2", externalGroupId: "group-2", externalDisplayName: "Support", state: "active", _count: { members: 1 } },
        ]);

        await expect(listDirectoryGroupsForActor({ ...input, limit: 1 })).resolves.toMatchObject({
            ok: true,
            value: {
                items: [{ id: "group-row-1", memberCount: 3, boundAccountCount: 1, unboundPeopleCount: 1 }],
                nextCursor: expect.any(String),
            },
        });

        persistence.teamDirectorySource.findFirst.mockResolvedValue({
            ...source, state: "initializing", activeReconcileRunId: "partial-attempt",
        });
        await expect(listDirectoryGroupsForActor({ ...input, limit: 1 })).resolves.toMatchObject({
            ok: true,
            value: { items: [{ memberCount: null, boundAccountCount: null, unboundPeopleCount: null }] },
        });

        persistence.teamDirectoryGroup.findMany.mockResolvedValue([
            { id: "empty-group-row", externalGroupId: "empty-group", externalDisplayName: "Empty", state: "active", _count: { members: 0 } },
        ]);
        persistence.teamDirectorySource.findFirst.mockResolvedValue(source);
        await expect(listDirectoryGroupsForActor(input)).resolves.toMatchObject({
            ok: true,
            value: { items: [{ memberCount: 0, boundAccountCount: 0, unboundPeopleCount: 0 }], nextCursor: null },
        });
        persistence.teamDirectorySource.findFirst.mockResolvedValue({ ...source, lastFullReconcileAt: null });
        await expect(listDirectoryGroupsForActor(input)).resolves.toMatchObject({
            ok: true,
            value: { items: [{ memberCount: null, boundAccountCount: null, unboundPeopleCount: null }] },
        });
    });

    it("projects same-Team membership for bound native people without taking management", async () => {
        const people = ["native-account", "other-team-account", "suspended-account"].map((accountId, index) => ({
            id: `person-${index}`,
            externalUserId: `external-person-${index}`,
            displayName: null,
            normalizedEmail: null,
            externalLogin: null,
            state: "active" as const,
            boundAccountId: accountId,
            teamMembershipId: null,
            createdAt: new Date("2026-09-06T10:00:00.000Z"),
        }));
        persistence.teamProvisionedIdentity.findMany.mockResolvedValue(people);
        const memberships = [
            { id: "native-membership", teamId: team.id, accountId: "native-account", status: "active" },
            { id: "foreign-membership", teamId: "other-team", accountId: "other-team-account", status: "active" },
            { id: "suspended-membership", teamId: team.id, accountId: "suspended-account", status: "suspended" },
        ];
        persistence.teamMembership.findMany.mockImplementation(async (args: Prisma.TeamMembershipFindManyArgs) =>
            memberships.filter((membership) => membership.teamId === args.where?.teamId
                && (args.where?.status === undefined || membership.status === args.where.status)),
        );

        await expect(listDirectoryPeopleForActor(input)).resolves.toMatchObject({
            ok: true,
            value: { items: [
                { accountBinding: { state: "bound", accountId: "native-account", teamMembershipId: "native-membership" } },
                { accountBinding: { state: "bound", accountId: "other-team-account", teamMembershipId: null } },
                { accountBinding: { state: "bound", accountId: "suspended-account", teamMembershipId: "suspended-membership" } },
            ] },
        });
        expect(people.map((row) => row.teamMembershipId)).toEqual([null, null, null]);
    });

    it("names a mapped Group independently of a client page and withholds a foreign Team's name", async () => {
        persistence.teamDirectoryGroup.findMany.mockResolvedValue([
            { id: "group-row-1", externalGroupId: "engineering", externalDisplayName: "Engineering", state: "active" },
            { id: "group-row-2", externalGroupId: "foreign", externalDisplayName: "Foreign", state: "active" },
        ]);
        persistence.teamExternalGroupBinding.findMany.mockResolvedValue([
            { id: "binding-1", externalGroupId: "engineering", bindingMode: "native_target", teamGroupId: "target-1", group: { teamId: team.id, name: "Platform Engineering" } },
            { id: "binding-2", externalGroupId: "foreign", bindingMode: "native_target", teamGroupId: "target-2", group: { teamId: "another-team", name: "Private Group" } },
        ]);
        await expect(listDirectoryGroupsForActor(input)).resolves.toMatchObject({
            ok: true,
            value: { items: [
                { mapping: { state: "bound", teamGroupName: "Platform Engineering" } },
                { mapping: { state: "bound", teamGroupName: null } },
            ] },
        });
        expect(persistence.teamExternalGroupBinding.findMany.mock.calls[0]?.[0].select.group)
            .toEqual({ select: { teamId: true, name: true } });
    });
});
