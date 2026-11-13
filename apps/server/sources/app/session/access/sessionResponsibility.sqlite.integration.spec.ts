import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionResponsibilityRoutes } from "@/app/api/routes/session/registerSessionResponsibilityRoutes";
import { deleteSessionAccessGrantInTx as deleteSessionAccessGrantWithAuthenticationInTx } from "./sessionAccessGrantService";
import {
    clearSessionResponsibilityIfNoReadAccessInTx,
    setSessionResponsibility as setSessionResponsibilityWithAuthentication,
} from "./sessionResponsibilityService";

async function deleteSessionAccessGrantInTx(
    tx: Parameters<typeof deleteSessionAccessGrantWithAuthenticationInTx>[0],
    input: Omit<Parameters<typeof deleteSessionAccessGrantWithAuthenticationInTx>[1], "authentication">,
) {
    return await deleteSessionAccessGrantWithAuthenticationInTx(tx, {
        ...input,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
    });
}

async function setSessionResponsibility(
    input: Omit<Parameters<typeof setSessionResponsibilityWithAuthentication>[0], "authentication">,
) {
    return await setSessionResponsibilityWithAuthentication({
        ...input,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
    });
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createAccount(profile?: Readonly<{ name?: string; username?: string }>) {
    return await db.account.create({
        data: {
            publicKey: crypto.randomUUID(),
            encryptionMode: "plain",
            ...(profile?.name ? { name: profile.name } : {}),
            ...(profile?.username ? { username: profile.username } : {}),
        },
    });
}

async function createFixture(params: Readonly<{
    collaboratorLevel?: "view" | "edit" | "admin";
}> = {}) {
    const owner = await createAccount({ name: "Olive", username: `olive-${crypto.randomUUID().slice(0, 8)}` });
    const collaborator = await createAccount({ name: "Alice", username: `alice-${crypto.randomUUID().slice(0, 8)}` });
    const outsider = await createAccount({ name: "Mallory", username: `mallory-${crypto.randomUUID().slice(0, 8)}` });
    const session = await db.session.create({
        data: {
            accountId: owner.id,
            tag: crypto.randomUUID(),
            encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
            seq: 4,
        },
    });
    const share = await db.sessionGrant.create({
        data: { principalKind: 'account',
            sessionId: session.id,
            createdByAccountId: owner.id,
            accountId: collaborator.id,
            accessLevel: params.collaboratorLevel ?? "view",
            canApprovePermissions: false,
        },
    });
    return { owner, collaborator, outsider, session, share };
}

async function readSession(sessionId: string) {
    return await db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
            responsibleAccountId: true,
            updatedAt: true,
            meaningfulActivityAt: true,
            accountId: true,
            metadata: true,
            agentState: true,
            encryptionMode: true,
        },
    });
}

async function countAccountChanges(accountId: string): Promise<number> {
    return await db.accountChange.count({ where: { accountId } });
}

describe("Session responsibility owner (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-responsibility-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    afterEach(() => vi.unstubAllEnvs());

    it("changes assignment without enrolling a Follow or resetting private read custody", async () => {
        const fixture = await createFixture();
        const input = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            responsibleAccountId: fixture.collaborator.id,
        };
        const assigned = await setSessionResponsibility(input);
        expect(assigned).toMatchObject({ ok: true, changed: true, autoFollowed: false });
        const where = { accountId_sessionId: { accountId: fixture.collaborator.id, sessionId: fixture.session.id } };
        const created = await db.$queryRaw<Array<{ followPolicy: string | null }>>`
            SELECT followPolicy FROM AccountSessionFollow
            WHERE accountId = ${fixture.collaborator.id} AND sessionId = ${fixture.session.id}
        `;
        expect(created).toEqual([]);
        expect(await db.accountSessionReadState.findUnique({ where })).toBeNull();
        await db.accountSessionFollow.create({ data: {
            accountId: fixture.collaborator.id, sessionId: fixture.session.id,
            following: false, followPolicy: null,
        } });
        const unreadSince = new Date(1234);
        await db.accountSessionReadState.create({ data: {
            accountId: fixture.collaborator.id, sessionId: fixture.session.id,
            lastViewedSessionSeq: 1, unreadSince,
        } });
        const cleared = await setSessionResponsibility({ ...input, responsibleAccountId: null });
        expect(cleared).toMatchObject({ ok: true, changed: true, autoFollowed: false });
        const reassigned = await setSessionResponsibility(input);
        expect(reassigned).toMatchObject({ ok: true, changed: true, autoFollowed: false });
        expect(await db.accountSessionFollow.findUnique({ where })).toMatchObject({
            following: false, followPolicy: null,
        });
        expect(await db.accountSessionReadState.findUnique({ where })).toMatchObject({
            lastViewedSessionSeq: 1, unreadSince,
        });
    });

    it("does not apply a newly enabled default to an unchanged assignment", async () => {
        const fixture = await createFixture();
        await db.account.update({ where: { id: fixture.collaborator.id }, data: { sessionAutoFollowAssigned: false } });
        const input = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            responsibleAccountId: fixture.collaborator.id,
        };
        const assigned = await setSessionResponsibility(input);
        expect(assigned).toMatchObject({ ok: true, changed: true, autoFollowed: false });
        expect(await db.accountSessionReadState.count({ where: { accountId: fixture.collaborator.id } })).toBe(0);
        await db.account.update({ where: { id: fixture.collaborator.id }, data: { sessionAutoFollowAssigned: true } });
        const repeated = await setSessionResponsibility(input);
        expect(repeated).toMatchObject({ ok: true, changed: false, autoFollowed: false });
        expect(await db.accountSessionFollow.count({ where: { accountId: fixture.collaborator.id } })).toBe(0);
    });

    describe("assignment authority and target eligibility", () => {
        it("assigns a currently readable collaborator on the owner's request", async () => {
            const fixture = await createFixture();
            const result = await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });

            expect(result).toMatchObject({
                ok: true,
                changed: true,
                responsibleAccountId: fixture.collaborator.id,
            });
            expect(result).not.toHaveProperty("previousResponsibleAccountId");
            expect(result).not.toHaveProperty("assigned");
            expect((await readSession(fixture.session.id)).responsibleAccountId)
                .toBe(fixture.collaborator.id);
            expect((await db.accountChange.findUnique({
                where: {
                    accountId_kind_entityId: {
                        accountId: fixture.owner.id,
                        kind: "session",
                        entityId: fixture.session.id,
                    },
                },
                select: { hint: true },
            }))?.hint).toMatchObject({
                responsibleAccountId: fixture.collaborator.id,
                responsibleAccount: {
                    kind: "account",
                    accountId: fixture.collaborator.id,
                    firstName: "Alice",
                },
            });
        });

        it("refuses an actor that can edit but cannot assign responsibility", async () => {
            const fixture = await createFixture({ collaboratorLevel: "edit" });
            const result = await setSessionResponsibility({
                actorAccountId: fixture.collaborator.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });

            expect(result).toEqual({ ok: false, error: "forbidden" });
            expect((await readSession(fixture.session.id)).responsibleAccountId).toBeNull();
        });

        it("admits a shared admin, because responsibility follows assignResponsibility", async () => {
            const fixture = await createFixture({ collaboratorLevel: "admin" });
            const result = await setSessionResponsibility({
                actorAccountId: fixture.collaborator.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });

            expect(result).toMatchObject({ ok: true, responsibleAccountId: fixture.collaborator.id });
        });

        it("refuses an Account without current read access with one non-enumerating conflict", async () => {
            const fixture = await createFixture();
            const result = await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.outsider.id,
            });

            expect(result).toEqual({ ok: false, error: "assignee_unavailable" });
            expect((await readSession(fixture.session.id)).responsibleAccountId).toBeNull();
        });

        it("uses the same conflict for an absent and for an inactive Account", async () => {
            const fixture = await createFixture();
            await db.account.update({
                where: { id: fixture.collaborator.id },
                data: { status: "suspended" },
            });

            expect(await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            })).toEqual({ ok: false, error: "assignee_unavailable" });

            expect(await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: "account-that-never-existed",
            })).toEqual({ ok: false, error: "assignee_unavailable" });
        });

        it("reports an undisclosable Session exactly like an absent one", async () => {
            const fixture = await createFixture();
            expect(await setSessionResponsibility({
                actorAccountId: fixture.outsider.id,
                sessionId: fixture.session.id,
                responsibleAccountId: null,
            })).toEqual({ ok: false, error: "not_found" });

            expect(await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: "session-that-never-existed",
                responsibleAccountId: null,
            })).toEqual({ ok: false, error: "not_found" });
        });
    });

    describe("non-authorizing, non-activity boundary", () => {
        it("grants no access and does not move Session activity or metadata", async () => {
            const fixture = await createFixture();
            const before = await readSession(fixture.session.id);
            const sharesBefore = await db.sessionGrant.findMany({ where: { principalKind: 'account', sessionId: fixture.session.id } });

            await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });

            const after = await readSession(fixture.session.id);
            expect(after.meaningfulActivityAt).toEqual(before.meaningfulActivityAt);
            expect(after).toMatchObject({
                accountId: before.accountId,
                metadata: before.metadata,
                agentState: before.agentState,
                encryptionMode: before.encryptionMode,
            });
            expect(await db.sessionGrant.findMany({ where: { principalKind: 'account', sessionId: fixture.session.id } }))
                .toEqual(sharesBefore);
        });

        it("treats an identical desired value as a true no-op", async () => {
            const fixture = await createFixture();
            await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });
            const afterFirst = await readSession(fixture.session.id);
            const ownerChanges = await countAccountChanges(fixture.owner.id);
            const collaboratorChanges = await countAccountChanges(fixture.collaborator.id);

            const repeat = await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });

            expect(repeat).toMatchObject({
                ok: true,
                changed: false,
                responsibleAccountId: fixture.collaborator.id,
            });
            expect((await readSession(fixture.session.id)).updatedAt.getTime())
                .toBe(afterFirst.updatedAt.getTime());
            expect(await countAccountChanges(fixture.owner.id)).toBe(ownerChanges);
            expect(await countAccountChanges(fixture.collaborator.id)).toBe(collaboratorChanges);
        });

        it("publishes responsibility to readers without changing private Follow configuration", async () => {
            const fixture = await createFixture();
            await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });
            for (const accountId of [fixture.owner.id, fixture.collaborator.id]) {
                expect(await db.accountChange.count({ where: {
                    accountId, kind: "session", entityId: fixture.session.id,
                } })).toBe(1);
            }
            expect(await db.accountChange.count({ where: {
                accountId: fixture.owner.id, kind: "account", entityId: "session-follows",
            } })).toBe(0);
            expect(await db.accountChange.count({ where: {
                accountId: fixture.collaborator.id, kind: "account", entityId: "session-follows",
            } })).toBe(0);
        });

        it("clears responsibility on an explicit null without exposing an already-consumed transition", async () => {
            const fixture = await createFixture();
            await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });

            const cleared = await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: null,
            });

            expect(cleared).toMatchObject({
                ok: true,
                changed: true,
                responsibleAccountId: null,
            });
            expect(cleared).not.toHaveProperty("previousResponsibleAccountId");
            expect(cleared).not.toHaveProperty("assigned");
        });
    });

    describe("access-loss lifecycle", () => {
        async function assign(fixture: Fixture) {
            const result = await setSessionResponsibility({
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                responsibleAccountId: fixture.collaborator.id,
            });
            expect(result).toMatchObject({ ok: true });
        }

        it("clears the assignment when the final read-access source is removed", async () => {
            const fixture = await createFixture();
            await assign(fixture);

            await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "account", accountId: fixture.collaborator.id },
            }));

            expect((await readSession(fixture.session.id)).responsibleAccountId).toBeNull();
        });

        it("does not resurrect the assignment when access is granted again", async () => {
            const fixture = await createFixture();
            await assign(fixture);
            await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "account", accountId: fixture.collaborator.id },
            }));

            await db.sessionGrant.create({
                data: { principalKind: 'account',
                    sessionId: fixture.session.id,
                    createdByAccountId: fixture.owner.id,
                    accountId: fixture.collaborator.id,
                    accessLevel: "view",
                    canApprovePermissions: false,
                },
            });

            expect((await readSession(fixture.session.id)).responsibleAccountId).toBeNull();
        });

        it("preserves responsibility through overlapping Team access and clears on final Team removal", async () => {
            const fixture = await createFixture();
            const team = await db.team.create({ data: { name: crypto.randomUUID() } });
            await db.teamMembership.create({ data: {
                teamId: team.id, accountId: fixture.collaborator.id, role: "member",
            } });
            await db.sessionGrant.create({ data: { principalKind: 'team',
                sessionId: fixture.session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
            } });
            await assign(fixture);

            await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "account", accountId: fixture.collaborator.id },
            }));
            expect((await readSession(fixture.session.id)).responsibleAccountId).toBe(fixture.collaborator.id);

            await expect(inTx(async tx => {
                await deleteSessionAccessGrantInTx(tx, {
                    actorAccountId: fixture.owner.id,
                    sessionId: fixture.session.id,
                    subject: { kind: "team", teamId: team.id },
                });
                throw new Error("abort access removal");
            })).rejects.toThrow("abort access removal");
            expect((await readSession(fixture.session.id)).responsibleAccountId).toBe(fixture.collaborator.id);

            await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "team", teamId: team.id },
            }));
            expect((await readSession(fixture.session.id)).responsibleAccountId).toBeNull();
        });

        it("keeps the assignment when another Account's grant is removed", async () => {
            const fixture = await createFixture();
            const bystander = await createAccount();
            await db.sessionGrant.create({
                data: { principalKind: 'account',
                    sessionId: fixture.session.id,
                    createdByAccountId: fixture.owner.id,
                    accountId: bystander.id,
                    accessLevel: "view",
                    canApprovePermissions: false,
                },
            });
            await assign(fixture);

            await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "account", accountId: bystander.id },
            }));

            expect((await readSession(fixture.session.id)).responsibleAccountId)
                .toBe(fixture.collaborator.id);
        });

        it("clears the assignment when the responsible Account is suspended", async () => {
            const fixture = await createFixture();
            await assign(fixture);
            await db.account.update({
                where: { id: fixture.collaborator.id },
                data: { status: "suspended" },
            });

            const cleared = await inTx(async (tx) => await clearSessionResponsibilityIfNoReadAccessInTx({
                tx,
                sessionId: fixture.session.id,
            }));

            expect(cleared).toEqual({ clearedAccountId: fixture.collaborator.id });
            expect((await readSession(fixture.session.id)).responsibleAccountId).toBeNull();
        });

        it("leaves an eligible assignment untouched when the helper runs", async () => {
            const fixture = await createFixture();
            await assign(fixture);

            const cleared = await inTx(async (tx) => await clearSessionResponsibilityIfNoReadAccessInTx({
                tx,
                sessionId: fixture.session.id,
            }));

            expect(cleared).toEqual({ clearedAccountId: null });
            expect((await readSession(fixture.session.id)).responsibleAccountId)
                .toBe(fixture.collaborator.id);
        });

        it("clears the pointer through the foreign key when the Account is deleted", async () => {
            const fixture = await createFixture();
            await assign(fixture);

            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', accountId: fixture.collaborator.id } });
            await db.account.delete({ where: { id: fixture.collaborator.id } });

            expect((await readSession(fixture.session.id)).responsibleAccountId).toBeNull();
        });
    });

    describe("HTTP surface", () => {
        it("returns typed Team authentication continuation for responsibility operations", async () => {
            vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "1");
            const fixture = await createFixture({ collaboratorLevel: "edit" });
            const team = await db.team.create({
                data: {
                    name: "Restricted responsibility team",
                    authenticationPolicy: {
                        v: 1,
                        mode: "restricted",
                        accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                    },
                },
            });
            await db.teamMembership.create({
                data: { teamId: team.id, accountId: fixture.collaborator.id, role: "member" },
            });
            await db.sessionGrant.create({
                data: { principalKind: 'team',
                    sessionId: fixture.session.id,
                    teamId: team.id,
                    accessLevel: "admin",
                    effectiveAt: new Date(),
                },
            });

            await withAuthenticatedTestApp(registerSessionResponsibilityRoutes, async (app) => {
                const requests = () => [
                    app.inject({
                        method: "POST",
                        url: "/v2/sessions/responsibility/set",
                        headers: { "x-test-user-id": fixture.collaborator.id },
                        payload: { sessionId: fixture.session.id, responsibleAccountId: fixture.owner.id },
                    }),
                    app.inject({
                        method: "POST",
                        url: "/v2/sessions/responsibility/candidates",
                        headers: { "x-test-user-id": fixture.collaborator.id },
                        payload: { sessionId: fixture.session.id, purpose: "assignment" },
                    }),
                ];

                for (const response of await Promise.all(requests())) {
                    expect(response.statusCode, response.body).toBe(403);
                    expect(response.json()).toEqual({ error: "session_access_authentication_required" });
                }

                vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "0");
                for (const response of await Promise.all(requests())) {
                    expect(response.statusCode, response.body).toBe(503);
                    expect(response.json()).toEqual({ error: "session_access_authentication_unavailable" });
                }

                // Mention admission needs only submitAgentInput, which the direct
                // Edit grant already supplies without Team qualification.
                const mention = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": fixture.collaborator.id },
                    payload: { sessionId: fixture.session.id, purpose: "mention" },
                });
                expect(mention.statusCode, mention.body).toBe(200);
            });
        });

        it("admits mention discovery for discussion editors without disclosing assignment access hints", async () => {
            const fixture = await createFixture({ collaboratorLevel: "edit" });
            await withAuthenticatedTestApp(registerSessionResponsibilityRoutes, async (app) => {
                const request = (actorAccountId: string, purpose: "mention" | "assignment") => app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": actorAccountId },
                    payload: { sessionId: fixture.session.id, purpose },
                });
                const mention = await request(fixture.collaborator.id, "mention");
                expect(mention.statusCode).toBe(200);
                expect(mention.json().candidates.map((row: { accountId: string }) => row.accountId).sort())
                    .toEqual([fixture.owner.id, fixture.collaborator.id].sort());
                for (const row of mention.json().candidates) expect(row).not.toHaveProperty("accessHint");
                expect((await request(fixture.collaborator.id, "assignment")).statusCode).toBe(403);
                const ownerMention = await request(fixture.owner.id, "mention");
                for (const row of ownerMention.json().candidates) expect(row).not.toHaveProperty("accessHint");
                await db.sessionGrant.update({ where: { principalKind: 'account', id: fixture.share.id }, data: { accessLevel: "view" } });
                // Mention admission is `submitAgentInput` plus Lane 05 discussion
                // admission: a view-only collaborator cannot mention.
                expect((await request(fixture.collaborator.id, "mention")).statusCode).toBe(403);
                await db.session.update({ where: { id: fixture.session.id }, data: { archivedAt: new Date() } });
                // Archived Sessions retain responsibility and allow an
                // otherwise-authorized manager to assign/clear; candidates use
                // the same readable archived admission as the mutation and must
                // not reject what the mutation accepts. Assignment never unarchives.
                // Lane 05 cannot post into any archived Session discussion, so
                // mention discovery must not remain as an enumeration bypass.
                expect((await request(fixture.owner.id, "mention")).statusCode).toBe(403);
                const archivedAssignment = await request(fixture.owner.id, "assignment");
                expect(archivedAssignment.statusCode).toBe(200);
            });
        });

        it("refuses responsibility operations while Session sharing is disabled", async () => {
            const fixture = await createFixture();
            const previous = process.env.HAPPIER_BUILD_FEATURES_DENY;
            process.env.HAPPIER_BUILD_FEATURES_DENY = "sharing.session";
            try {
                await withAuthenticatedTestApp(registerSessionResponsibilityRoutes, async (app) => {
                    for (const [operation, payload] of [
                        ["set", { sessionId: fixture.session.id, responsibleAccountId: fixture.collaborator.id }],
                        ["candidates", { sessionId: fixture.session.id, purpose: "assignment" }],
                    ] as const) {
                        const response = await app.inject({
                            method: "POST",
                            url: `/v2/sessions/responsibility/${operation}`,
                            headers: { "x-test-user-id": fixture.owner.id },
                            payload,
                        });
                        expect(response.statusCode).toBe(404);
                        expect(response.json()).toEqual({ error: "not_found" });
                    }
                    expect((await readSession(fixture.session.id)).responsibleAccountId).toBeNull();
                });
            } finally {
                if (previous === undefined) delete process.env.HAPPIER_BUILD_FEATURES_DENY;
                else process.env.HAPPIER_BUILD_FEATURES_DENY = previous;
            }
        });

        it("excludes grant recipients whose transcript is not published from candidates", async () => {
            const fixture = await createFixture();
            await db.session.update({
                where: { id: fixture.session.id },
                data: { currentStorageState: "machine_only" },
            });
            await withAuthenticatedTestApp(registerSessionResponsibilityRoutes, async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: { sessionId: fixture.session.id, purpose: "assignment" },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json().candidates.map((candidate: { accountId: string }) => candidate.accountId))
                    .toEqual([fixture.owner.id]);
            });
        });

        it("returns the authoritative current value and the typed conflict", async () => {
            const fixture = await createFixture();
            await withAuthenticatedTestApp(registerSessionResponsibilityRoutes, async (app) => {
                const assigned = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/set",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: {
                        sessionId: fixture.session.id,
                        responsibleAccountId: fixture.collaborator.id,
                    },
                });
                expect(assigned.statusCode).toBe(200);
                expect(assigned.json()).toMatchObject({ changed: true, responsibleAccountId: fixture.collaborator.id, autoFollowed: false });
                expect(assigned.json().responsibleAccount).toMatchObject({ kind: 'account', accountId: fixture.collaborator.id });
                const repeated = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/set",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: { sessionId: fixture.session.id, responsibleAccountId: fixture.collaborator.id },
                });
                expect(repeated.json()).toMatchObject({ changed: false, responsibleAccountId: fixture.collaborator.id, autoFollowed: false });
                expect(repeated.json().responsibleAccount).toMatchObject({ kind: 'account', accountId: fixture.collaborator.id });

                const conflict = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/set",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: {
                        sessionId: fixture.session.id,
                        responsibleAccountId: fixture.outsider.id,
                    },
                });
                expect(conflict.statusCode).toBe(409);
                expect(conflict.json()).toEqual({
                    error: "session_responsibility_assignee_unavailable",
                });

                const forbidden = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/set",
                    headers: { "x-test-user-id": fixture.collaborator.id },
                    payload: { sessionId: fixture.session.id, responsibleAccountId: null },
                });
                expect(forbidden.statusCode).toBe(403);
                expect(forbidden.json()).toEqual({ error: "session_access_forbidden" });

                const missing = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/set",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: { sessionId: "missing-session", responsibleAccountId: null },
                });
                expect(missing.statusCode).toBe(404);
                expect(missing.json()).toEqual({ error: "session_access_session_not_found" });
            });
        });

        it("lists only active, currently readable candidates for an authorized actor", async () => {
            const fixture = await createFixture();
            await withAuthenticatedTestApp(registerSessionResponsibilityRoutes, async (app) => {
                const page = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: { sessionId: fixture.session.id, purpose: "assignment" },
                });
                expect(page.statusCode).toBe(200);
                const body = page.json() as {
                    candidates: { accountId: string; accessHint?: string; profile: unknown }[];
                    nextCursor: string | null;
                };
                const accountIds = body.candidates.map((candidate) => candidate.accountId).sort();
                expect(accountIds).toEqual([fixture.collaborator.id, fixture.owner.id].sort());
                expect(body.candidates.find((c) => c.accountId === fixture.collaborator.id)?.accessHint)
                    .toBe("view");
                expect(body.candidates.find((c) => c.accountId === fixture.owner.id)?.accessHint)
                    .toBe("owner");
                expect(body.nextCursor).toBeNull();

                const denied = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": fixture.collaborator.id },
                    payload: { sessionId: fixture.session.id, purpose: "assignment" },
                });
                expect(denied.statusCode).toBe(403);
            });
        });

        it("uses an opaque query-bound continuation and rejects malformed or mismatched cursors", async () => {
            const fixture = await createFixture();
            await withAuthenticatedTestApp(registerSessionResponsibilityRoutes, async (app) => {
                const first = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: { sessionId: fixture.session.id, purpose: "assignment", limit: 1 },
                });
                expect(first.statusCode).toBe(200);
                const firstBody = first.json() as { candidates: { accountId: string }[]; nextCursor: string | null };
                expect(firstBody.nextCursor).toEqual(expect.any(String));
                expect(firstBody.nextCursor).not.toBe(firstBody.candidates[0]?.accountId);

                const second = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: {
                        sessionId: fixture.session.id,
                        purpose: "assignment",
                        limit: 1,
                        cursor: firstBody.nextCursor,
                    },
                });
                expect(second.statusCode).toBe(200);
                expect(second.json().candidates[0]?.accountId).not.toBe(firstBody.candidates[0]?.accountId);

                for (const payload of [
                    { sessionId: fixture.session.id, purpose: "assignment", cursor: "not-a-cursor" },
                    { sessionId: fixture.session.id, purpose: "assignment", query: "different", cursor: firstBody.nextCursor },
                ]) {
                    const invalid = await app.inject({
                        method: "POST",
                        url: "/v2/sessions/responsibility/candidates",
                        headers: { "x-test-user-id": fixture.owner.id },
                        payload,
                    });
                    expect(invalid.statusCode).toBe(400);
                    expect(invalid.json()).toEqual({ error: "invalid_cursor" });
                }
            });
        });

        it.each(["sqlite", "mysql"] as const)("filters candidates and omits suspended Accounts with %s search filters", async (provider) => {
            const fixture = await createFixture();
            await db.account.update({
                where: { id: fixture.collaborator.id },
                data: { name: "Zenobia" },
            });
            // Both connectors reject Prisma's PostgreSQL-only `mode` argument.
            // This exercises the MySQL filter shape, not a MySQL runtime.
            vi.stubEnv("HAPPIER_DB_PROVIDER", provider);
            await withAuthenticatedTestApp(registerSessionResponsibilityRoutes, async (app) => {
                const matched = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: { sessionId: fixture.session.id, purpose: "assignment", query: "zeno" },
                });
                expect(matched.statusCode).toBe(200);
                expect(matched.json().candidates.map((c: { accountId: string }) => c.accountId))
                    .toEqual([fixture.collaborator.id]);

                await db.account.update({
                    where: { id: fixture.collaborator.id },
                    data: { status: "suspended" },
                });
                const afterSuspension = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/responsibility/candidates",
                    headers: { "x-test-user-id": fixture.owner.id },
                    payload: { sessionId: fixture.session.id, purpose: "assignment", query: "zeno" },
                });
                expect(afterSuspension.json().candidates).toEqual([]);
            });
        });
    });
});
