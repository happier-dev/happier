import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import { decodeBase64 } from "privacy-kit";
import {
    openEncryptedDataKeyEnvelopeV1,
    sealEncryptedDataKeyEnvelopeV1,
    signAccountContentKeyBindingV1,
} from "@happier-dev/protocol";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerTeamGroupRoutes } from "../groups/registerTeamGroupRoutes";
import { listTeamsForActorInTx } from "../queries";
import { admitTeamMemberInTx } from "./membershipService";
import { registerTeamMemberRoutes } from "./registerTeamMemberRoutes";

describe("Team member and Group routes (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-member-routes-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
        app = createAuthenticatedTestApp();
        registerTeamMemberRoutes(app);
        registerTeamGroupRoutes(app);
        await app.ready();
    }, 180_000);

    afterAll(async () => {
        if (app) await app.close();
        if (harness) await harness.close();
    });

    async function account() {
        return db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
    }

    async function encryptedAccount() {
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const contentPublicKey = new Uint8Array(content.publicKey);
        const account = await db.account.create({ data: {
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            encryptionMode: "e2ee",
            contentPublicKey: Buffer.from(contentPublicKey),
            contentPublicKeySig: Buffer.from(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey,
            })),
        } });
        return { account, contentPublicKey, contentSecretKey: new Uint8Array(content.secretKey) };
    }

    function seal(dataKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
        return new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey,
            recipientPublicKey,
            randomBytes: (length) => tweetnacl.randomBytes(length),
        }));
    }

    async function post(url: string, actorAccountId: string | null, payload: unknown) {
        return app.inject({
            method: "POST",
            url,
            headers: actorAccountId === null ? {} : { "x-test-user-id": actorAccountId },
            payload,
        });
    }

    async function request(
        method: "GET" | "PATCH",
        url: string,
        actorAccountId: string | null,
        payload?: unknown,
    ) {
        return app.inject({
            method,
            url,
            headers: actorAccountId === null ? {} : { "x-test-user-id": actorAccountId },
            ...(payload === undefined ? {} : { payload }),
        });
    }

    async function teamWithOwner(name: string) {
        const owner = await account();
        const team = await db.team.create({ data: { name } });
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: team.id, accountId: owner.id, role: "owner", historyAccess: "all_existing",
        }));
        if (!admitted.ok) throw new Error("owner admission failed");
        return { teamId: team.id, ownerAccountId: owner.id };
    }

    it("requires authentication on every membership and Group route", async () => {
        const { teamId } = await teamWithOwner("Auth");
        // Bodies are valid so the refusal can only come from authentication;
        // an invalid body would be rejected first and prove nothing.
        for (const [url, payload] of [
            ["/v1/teams/members/leave", { v: 1, teamId }],
            ["/v1/teams/members/list", { v: 1, teamId, filter: "all" }],
            ["/v1/teams/members/add", {
                v: 1, teamId, accountId: "someone", role: "member", historyAccess: "all_existing",
            }],
            ["/v1/teams/members/groups/list", { v: 1, teamId, membershipId: "membership" }],
            ["/v1/teams/groups/list", { v: 1, teamId, archived: "active" }],
            ["/v1/teams/groups/members/add", {
                v: 1, teamId, groupId: "g", accountId: "someone", historyAccess: "all_existing",
            }],
        ] as const) {
            const response = await post(url, null, payload);
            expect(response.statusCode).toBe(401);
        }
    });

    it("leaves the acting membership via the Team-only action route and withdraws directory membership", async () => {
        const { teamId, ownerAccountId } = await teamWithOwner("Leave route");
        const person = await account();
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, { teamId, accountId: person.id, role: "member", historyAccess: "from_membership" }));
        if (!admitted.ok) throw new Error("member admission failed");
        const before = await inTx((tx) => listTeamsForActorInTx(tx, { v: 1, actorAccountId: person.id, scope: "member", archived: "active" }));
        expect(before.ok && before.page.items.find((item) => item.id === teamId)?.capabilities.leave).toBe(true);
        const badInput = await post("/v1/teams/members/leave", person.id, { v: 1, teamId, membershipId: "other" });
        expect(badInput.statusCode).toBe(400);
        const owner = await post("/v1/teams/members/leave", ownerAccountId, { v: 1, teamId });
        expect(owner.statusCode).toBe(409);
        expect(owner.json()).toEqual({ error: "team_owner_transfer_required" });
        const outsider = await account();
        for (const hiddenTeamId of [teamId, crypto.randomUUID()]) {
            const hidden = await post("/v1/teams/members/leave", outsider.id, { v: 1, teamId: hiddenTeamId });
            expect(hidden.statusCode).toBe(404);
            expect(hidden.json()).toEqual({ error: "team_not_found" });
        }
        const removed = await post("/v1/teams/members/leave", person.id, { v: 1, teamId });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toEqual({ status: "removed", membershipId: admitted.membership.teamMembershipId });
        expect(await db.teamMembership.count({ where: { teamId, accountId: person.id } })).toBe(0);
        expect(await db.teamMembership.count({ where: { teamId, accountId: ownerAccountId } })).toBe(1);
        const after = await inTx((tx) => listTeamsForActorInTx(tx, { v: 1, actorAccountId: person.id, scope: "member", archived: "active" }));
        expect(after).toMatchObject({ ok: true, page: { items: [] } });
    });

    it("carries one member through add, role, suspend, reactivate, and remove", async () => {
        const { teamId, ownerAccountId } = await teamWithOwner("Member routes");
        const person = await account();

        const added = await post("/v1/teams/members/add", ownerAccountId, {
            v: 1, teamId, accountId: person.id, role: "member", historyAccess: "from_membership",
        });
        expect(added.statusCode).toBe(200);
        expect(added.json()).toMatchObject({
            v: 1,
            teamId,
            accountId: person.id,
            role: "member",
            status: "active",
            historyAccess: "from_membership",
        });

        const listed = await post("/v1/teams/members/list", ownerAccountId, {
            v: 1, teamId, filter: "members",
        });
        expect(listed.statusCode).toBe(200);
        const roster = listed.json();
        expect(roster.items).toHaveLength(1);
        const membershipId = roster.items[0].id;
        expect(roster.items[0].historyAccess).toBe("from_membership");
        // The wire projection never carries the raw cutoff.
        expect(roster.items[0].sessionAccessStartsAt).toBeUndefined();

        const promoted = await post("/v1/teams/members/role/set", ownerAccountId, {
            v: 1, teamId, membershipId, role: "admin",
        });
        expect(promoted.statusCode).toBe(200);
        expect(promoted.json().role).toBe("admin");

        const suspended = await post("/v1/teams/members/suspend", ownerAccountId, {
            v: 1, teamId, membershipId,
        });
        expect(suspended.statusCode).toBe(200);
        expect(suspended.json().status).toBe("suspended");

        const reactivated = await post("/v1/teams/members/reactivate", ownerAccountId, {
            v: 1, teamId, membershipId,
        });
        expect(reactivated.statusCode).toBe(200);
        expect(reactivated.json().status).toBe("active");

        const removed = await post("/v1/teams/members/remove", ownerAccountId, {
            v: 1, teamId, membershipId,
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toEqual({ status: "removed", membershipId });
    });

    it("maps each domain refusal to its one wire status", async () => {
        const { teamId, ownerAccountId } = await teamWithOwner("Refusals");
        const ownerRoster = await post("/v1/teams/members/list", ownerAccountId, {
            v: 1, teamId, filter: "all",
        });
        const ownerMembershipId = ownerRoster.json().items[0].id;
        const stranger = await account();

        // A Team the caller cannot see is absent, not forbidden.
        const hidden = await post("/v1/teams/members/list", stranger.id, {
            v: 1, teamId, filter: "all",
        });
        expect(hidden.statusCode).toBe(404);
        expect(hidden.json()).toEqual({ error: "team_not_found" });

        // The last active owner cannot be demoted through ordinary administration.
        const stranded = await post("/v1/teams/members/role/set", ownerAccountId, {
            v: 1, teamId, membershipId: ownerMembershipId, role: "member",
        });
        expect(stranded.statusCode).toBe(409);
        expect(stranded.json()).toEqual({ error: "team_owner_transfer_required" });

        const unknown = await post("/v1/teams/members/get", ownerAccountId, {
            v: 1, teamId, membershipId: "does-not-exist",
        });
        expect(unknown.statusCode).toBe(404);
        expect(unknown.json()).toEqual({ error: "membership_not_found" });

        // Owner is not an admissible direct-add role at the wire.
        const ownerAdd = await post("/v1/teams/members/add", ownerAccountId, {
            v: 1, teamId, accountId: stranger.id, role: "owner", historyAccess: "all_existing",
        });
        expect(ownerAdd.statusCode).toBe(400);
    });

    it("carries a Group through create, roster, archive, and restore", async () => {
        const { teamId, ownerAccountId } = await teamWithOwner("Group routes");
        const person = await account();
        const memberAdded = await post("/v1/teams/members/add", ownerAccountId, {
            v: 1, teamId, accountId: person.id, role: "member", historyAccess: "from_membership",
        });
        const membershipId = memberAdded.json().id;

        const created = await post("/v1/teams/groups/create", ownerAccountId, {
            v: 1, teamId, name: "Developers", requestKey: crypto.randomUUID(),
        });
        expect(created.statusCode).toBe(200);
        const group = created.json();
        expect(group.name).toBe("Developers");
        expect(group.memberCount).toBe(0);
        expect(group.nameKey).toBeUndefined();

        const added = await post("/v1/teams/groups/members/add", ownerAccountId, {
            v: 1, teamId, groupId: group.id, accountId: person.id, historyAccess: "all_existing",
        });
        expect(added.statusCode).toBe(200);
        expect(added.json().status).toBe("added");
        expect(added.json().member.contributions).toEqual({ native: true, external: [] });

        const roster = await post("/v1/teams/groups/members/list", ownerAccountId, {
            v: 1, teamId, groupId: group.id,
        });
        expect(roster.statusCode).toBe(200);
        expect(roster.json().items).toHaveLength(1);

        const memberGroups = await post("/v1/teams/members/groups/list", ownerAccountId, {
            v: 1, teamId, membershipId,
        });
        expect(memberGroups.statusCode).toBe(200);
        expect(memberGroups.json().items.map((item: { id: string }) => item.id)).toEqual([group.id]);

        const removed = await post("/v1/teams/groups/members/remove", ownerAccountId, {
            v: 1, teamId, groupId: group.id, accountId: person.id,
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toEqual({ status: "removed" });

        const archived = await post("/v1/teams/groups/archive", ownerAccountId, {
            v: 1, teamId, groupId: group.id,
        });
        expect(archived.statusCode).toBe(200);
        expect(archived.json().archivedAt).not.toBeNull();

        const blocked = await post("/v1/teams/groups/members/add", ownerAccountId, {
            v: 1, teamId, groupId: group.id, accountId: person.id, historyAccess: "all_existing",
        });
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toEqual({ error: "group_archived" });

        const restored = await post("/v1/teams/groups/restore", ownerAccountId, {
            v: 1, teamId, groupId: group.id,
        });
        expect(restored.statusCode).toBe(200);
        expect(restored.json().archivedAt).toBeNull();
    });

    it("rejects a duplicate Group name in the same Team through the wire", async () => {
        const { teamId, ownerAccountId } = await teamWithOwner("Group name");
        await post("/v1/teams/groups/create", ownerAccountId, {
            v: 1, teamId, name: "Design", requestKey: crypto.randomUUID(),
        });
        const duplicate = await post("/v1/teams/groups/create", ownerAccountId, {
            v: 1, teamId, name: "design", requestKey: crypto.randomUUID(),
        });
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json()).toEqual({ error: "group_name_taken" });
    });

    it("maps a commit-time Group rename collision to the canonical typed refusal", async () => {
        const { teamId, ownerAccountId } = await teamWithOwner("Concurrent Group rename");
        const created = await post("/v1/teams/groups/create", ownerAccountId, {
            v: 1, teamId, name: "Original", requestKey: crypto.randomUUID(),
        });
        expect(created.statusCode).toBe(200);

        // Force the database boundary to introduce the competing name only
        // after the service's ordinary collision read. This deterministically
        // exercises the same unique-constraint race as two concurrent renames,
        // while keeping the internal service path real.
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "TeamGroup_commit_time_name_collision"
            BEFORE UPDATE OF "nameKey" ON "TeamGroup"
            WHEN NEW."nameKey" = 'concurrent name'
            BEGIN
                INSERT INTO "TeamGroup" (
                    "id", "teamId", "name", "nameKey", "createdAt", "updatedAt"
                ) VALUES (
                    'commit-time-collision', NEW."teamId", 'Concurrent name',
                    'concurrent name', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
            END
        `);
        try {
            const response = await post("/v1/teams/groups/update", ownerAccountId, {
                v: 1,
                teamId,
                groupId: created.json().id,
                name: "Concurrent name",
            });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "group_name_taken" });
        } finally {
            await db.$executeRawUnsafe(
                'DROP TRIGGER IF EXISTS "TeamGroup_commit_time_name_collision"',
            );
        }
    });

    /**
     * The nested membership-history envelope addresses.
     *
     * These assert the transports exist at their exact approved paths and hand
     * the subject to the one envelope service; what that service decides is
     * proven against a real database in its own suite.
     */
    it("mounts both nested membership-history envelope addresses behind authentication", async () => {
        const { teamId, ownerAccountId } = await teamWithOwner("History mount");
        const person = await account();
        await post("/v1/teams/members/add", ownerAccountId, {
            v: 1, teamId, accountId: person.id, role: "member", historyAccess: "all_existing",
        });
        const roster = await post("/v1/teams/members/list", ownerAccountId, { v: 1, teamId, filter: "members" });
        const membershipId = roster.json().items[0].id;
        const created = await post("/v1/teams/groups/create", ownerAccountId, {
            v: 1, teamId, name: "History", requestKey: crypto.randomUUID(),
        });
        const groupId = created.json().id;
        await post("/v1/teams/groups/members/add", ownerAccountId, {
            v: 1, teamId, groupId, accountId: person.id, historyAccess: "all_existing",
        });

        const teamUrl = `/v2/teams/${teamId}/members/${membershipId}/sessions/data-key/envelopes`;
        const groupUrl = `/v2/teams/${teamId}/groups/${groupId}/members/${person.id}/sessions/data-key/envelopes`;

        // An unauthenticated caller is refused by authentication, not by a
        // missing route: a 404 here would mean the transport is not mounted.
        for (const url of [teamUrl, groupUrl]) {
            expect((await request("GET", url, null)).statusCode).toBe(401);
        }

        // A plain recipient is a stable whole-page state, not per-Session work.
        for (const url of [teamUrl, groupUrl]) {
            const page = await request("GET", url, ownerAccountId);
            expect(page.statusCode).toBe(200);
            expect(page.json()).toEqual({
                status: "recipient_unavailable",
                recipientAccountId: person.id,
                contentKey: { status: "unavailable", reason: "plain_account" },
            });
        }

        // The membership subject conceals an id that is not addressable here.
        const unknown = await request(
            "GET",
            `/v2/teams/${teamId}/members/${crypto.randomUUID()}/sessions/data-key/envelopes`,
            ownerAccountId,
        );
        expect(unknown.statusCode).toBe(404);
        expect(unknown.json()).toEqual({ error: "membership_not_found" });

        // Boundary validation belongs to this resource's own vocabulary.
        // Fastify's global invalid-params body must not leak through either
        // nested address (nor fail response serialization as a 500).
        for (const url of [teamUrl, groupUrl]) {
            const malformed = await request("PATCH", url, ownerAccountId, { entries: [] });
            expect(malformed.statusCode).toBe(400);
            expect(malformed.json()).toEqual({ error: "invalid_request" });

            const invalidCursor = await request("GET", `${url}?cursor=not-a-data-key-cursor`, ownerAccountId);
            expect(invalidCursor.statusCode).toBe(400);
            expect(invalidCursor.json()).toEqual({ error: "invalid_cursor" });
        }
    });

    it("completes real Team and Group GET -> open/seal -> PATCH -> recipient-open journeys through the mounted routes", async () => {
        const manager = await encryptedAccount();
        const target = await encryptedAccount();
        const team = await db.team.create({ data: { name: "Mounted encrypted history" } });
        const admitted = await inTx(async (tx) => ({
            manager: await admitTeamMemberInTx(tx, {
                teamId: team.id,
                accountId: manager.account.id,
                role: "owner",
                historyAccess: "all_existing",
            }),
            target: await admitTeamMemberInTx(tx, {
                teamId: team.id,
                accountId: target.account.id,
                role: "member",
                historyAccess: "all_existing",
            }),
        }));
        if (!admitted.manager.ok || !admitted.target.ok) throw new Error("encrypted membership admission failed");

        const group = await db.teamGroup.create({ data: {
            teamId: team.id,
            name: "Mounted encrypted group",
            nameKey: crypto.randomUUID(),
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: admitted.target.membership.teamMembershipId,
            sessionAccessStartsAt: null,
        } });

        const teamSession = await db.session.create({ data: {
            accountId: manager.account.id,
            tag: crypto.randomUUID(),
            encryptionMode: "e2ee",
            metadata: JSON.stringify({ t: "encrypted", c: "" }),
            seq: 1,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: teamSession.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt: new Date(0),
        } });
        const groupSession = await db.session.create({ data: {
            accountId: manager.account.id,
            tag: crypto.randomUUID(),
            encryptionMode: "e2ee",
            metadata: JSON.stringify({ t: "encrypted", c: "" }),
            seq: 1,
        } });
        await db.sessionGroupGrant.create({ data: {
            sessionId: groupSession.id,
            teamGroupId: group.id,
            accessLevel: "view",
            effectiveAt: new Date(0),
        } });
        const subjects = [
            {
                session: teamSession,
                url: `/v2/teams/${team.id}/members/${admitted.target.membership.teamMembershipId}/sessions/data-key/envelopes`,
            },
            {
                session: groupSession,
                url: `/v2/teams/${team.id}/groups/${group.id}/members/${target.account.id}/sessions/data-key/envelopes`,
            },
        ];

        for (const subject of subjects) {
            const dataKey = new Uint8Array(tweetnacl.randomBytes(32));
            await db.sessionDataKeyEnvelope.create({ data: {
                sessionId: subject.session.id,
                recipientAccountId: manager.account.id,
                encryptedDataKey: Buffer.from(seal(dataKey, manager.contentPublicKey)),
            } });

            const get = await request("GET", subject.url, manager.account.id);
            expect(get.statusCode).toBe(200);
            const page = get.json();
            expect(page.items.map((item: { sessionId: string }) => item.sessionId)).toEqual([subject.session.id]);
            const openedByManager = openEncryptedDataKeyEnvelopeV1({
                envelope: decodeBase64(page.items[0].callerDataKeyEnvelope),
                recipientSecretKeyOrSeed: manager.contentSecretKey,
            });
            expect(openedByManager).toEqual(dataKey);

            const patch = await request("PATCH", subject.url, manager.account.id, {
                recipientAccountId: target.account.id,
                entries: [{
                    sessionId: subject.session.id,
                    encryptedDataKey: Buffer.from(seal(openedByManager!, target.contentPublicKey)).toString("base64"),
                }],
            });
            expect(patch.statusCode).toBe(200);
            expect(patch.json()).toEqual({ appliedCount: 1 });

            const stored = await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: {
                sessionId_recipientAccountId: {
                    sessionId: subject.session.id,
                    recipientAccountId: target.account.id,
                },
            } });
            expect(openEncryptedDataKeyEnvelopeV1({
                envelope: new Uint8Array(stored.encryptedDataKey),
                recipientSecretKeyOrSeed: target.contentSecretKey,
            })).toEqual(dataKey);
        }
    });
});
