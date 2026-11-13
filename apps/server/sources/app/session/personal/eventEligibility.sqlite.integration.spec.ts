import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { inTx } from "@/storage/inTx";
import { eventRouter } from "@/app/events/eventRouter";
import { putSessionAccessGrantInTx } from "@/app/session/access/sessionAccessGrantService";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionAccessGrantRoutes } from "@/app/api/routes/session/registerSessionAccessGrantRoutes";
import { projectReleasedDirectShareEvent, scheduleReleasedDirectShareEvent } from "@/app/session/access/publishSessionAccessChange";
import { setSessionResponsibility } from "@/app/session/access/sessionResponsibilityService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { admitSessionBackgroundDeliveryInTx } from "./backgroundDelivery";
import { listSessionPersonalEventRecipients } from "./eventEligibility";
import { machineUpdateHandler } from "@/app/api/socket/machineUpdateHandler";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { applySessionTurnMutation, createSessionMessage } from "@/app/session/sessionWriteService";
import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";

describe("personal event recipients", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "personal-events-", initAuth: false }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(() => vi.unstubAllEnvs());
    it("delivers committed share and assignment in-app facts without Follow, replay, or rollback leakage", async () => {
        vi.stubEnv("HAPPIER_FEATURE_SHARING__SESSION__ENABLED", "1");
        const app = createAuthenticatedTestApp();
        registerSessionAccessGrantRoutes(app);
        await app.ready();
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain", sessionAutoFollowAssigned: false } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: reader.id, status: "friend" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const authentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: [] };
        const delivered: Array<{ target: string; payload: unknown }> = [];
        // Socket.IO is the transport boundary. These clients have only Account
        // subscriptions, never a room for this previously unseen Session.
        eventRouter.setIo({
            in: rooms => ({ fetchSockets: async () => [owner, reader]
                .filter(account => (Array.isArray(rooms) ? rooms : [rooms]).includes(`user-scoped:${account.id}`))
                .map(account => ({
                id: account.id,
                data: { userId: account.id, clientType: "user-scoped", clientPurpose: "sync", authAuthority: "present_user", authTokenAuthenticationEvidence: [] },
            })) }),
            to: target => ({
                disconnectSockets: () => {},
                emit: (kind, payload) => {
                    if (kind === "ephemeral" && typeof payload === "object" && payload !== null
                        && "type" in payload && payload.type === "session-personal-event") {
                        delivered.push({ target: String(target), payload });
                    }
                },
            }),
        });
        try {
            const grant = { actorAccountId: owner.id, sessionId: session.id, authentication,
                subject: { kind: "account" as const, accountId: reader.id },
                grant: { accessLevel: "view" as const, canApprovePermissions: false } };
            await expect(inTx(async tx => {
                const mutation = await putSessionAccessGrantInTx(tx, grant);
                expect(mutation).toMatchObject({ ok: true, changed: true });
                if (!mutation.ok || !mutation.directShare) throw new Error("Grant fixture was not admitted");
                scheduleReleasedDirectShareEvent(tx, {
                    recipientAccountId: reader.id,
                    publication: mutation.effects.accountCursors.get(reader.id),
                    event: projectReleasedDirectShareEvent({ recipientAccountId: reader.id, effects: mutation.effects,
                        directShare: mutation.directShare, directShareRemoved: false }),
                    sharedByUser: null,
                });
                throw new Error("rollback-personal-event");
            })).rejects.toThrow("rollback-personal-event");
            expect(delivered).toEqual([]);

            const share = () => app.inject({ method: "POST", url: "/v2/sessions/access-grants/set",
                headers: { "x-test-user-id": owner.id }, payload: {
                    sessionId: session.id, subject: grant.subject, ...grant.grant,
                } });
            const committed = await share();
            expect(committed.statusCode).toBe(200);
            expect(committed.json()).toMatchObject({ changed: true });
            await vi.waitFor(() => expect(delivered).toEqual([{ target: reader.id, payload: {
                type: "session-personal-event", event: "directly_shared", sessionId: session.id, eventId: expect.any(String),
            } }]));
            expect((await share()).json()).toMatchObject({ changed: false });
            expect(delivered).toHaveLength(1);

            const assignment = { actorAccountId: owner.id, sessionId: session.id, responsibleAccountId: reader.id, authentication };
            expect(await setSessionResponsibility(assignment)).toMatchObject({ ok: true, changed: true, autoFollowed: false });
            await vi.waitFor(() => expect(delivered).toHaveLength(2));
            expect(delivered[1]).toEqual({ target: reader.id, payload: {
                type: "session-personal-event", event: "assigned", sessionId: session.id,
                eventId: expect.any(String), assignmentAutoFollowed: false,
            } });
            expect(await setSessionResponsibility(assignment)).toMatchObject({ ok: true, changed: false });
            expect(delivered).toHaveLength(2);
            expect(await setSessionResponsibility({ ...assignment, responsibleAccountId: owner.id }))
                .toMatchObject({ ok: true, changed: true });
            expect(delivered).toHaveLength(2);
            expect(await db.accountSessionFollow.count({ where: { accountId: reader.id } })).toBe(0);
            expect(await db.accountSessionReadState.count({ where: { accountId: reader.id } })).toBe(0);
        } finally {
            eventRouter.clearIo();
            await app.close();
        }
    });
    it("delivers committed source-unavailable facts through each socket's current credential", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        // Device-key authentication is offered to keyed Accounts, not plain Accounts.
        const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "e2ee" } });
        const team = await db.team.create({ data: {
            name: randomUUID(), authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }] },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: "member" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(0) } });
        expect(await inTx(tx => resolveSessionAccessForOperation(tx, {
            accountId: reader.id, sessionId: session.id,
            authentication: { env: process.env, authority: "present_user", authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }] },
        }))).toMatchObject({ status: "allowed" });
        expect(await inTx(tx => resolveSessionAccessForOperation(tx, {
            accountId: reader.id, sessionId: session.id,
            authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
        }))).not.toMatchObject({ status: "allowed" });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: "fixture" } });
        const delivered: Array<{ target: string; payload: unknown }> = [];
        // Socket.IO and the authenticated daemon socket are genuine transport boundaries.
        eventRouter.setIo({
            in: () => ({ fetchSockets: async () => [
                { id: "qualified", data: { userId: reader.id, clientType: "user-scoped", clientPurpose: "sync", authAuthority: "present_user", authTokenAuthenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }] } },
                { id: "unqualified", data: { userId: reader.id, clientType: "user-scoped", clientPurpose: "sync", authAuthority: "present_user", authTokenAuthenticationEvidence: [] } },
            ] }),
            to: target => ({ disconnectSockets: () => {}, emit: (kind, payload) => {
                if (kind === "ephemeral" && typeof payload === "object" && payload !== null
                    && "type" in payload && payload.type === "session-personal-event") delivered.push({ target: String(target), payload });
            } }),
        });
        const socket = createFakeSocket({ data: { clientType: "machine-scoped", machineId: machine.id } });
        try {
            machineUpdateHandler(owner.id, socket as unknown as Parameters<typeof machineUpdateHandler>[1], {
                operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
            });
            await getSocketHandler(socket, "external-session-source-unavailable")({ v: 1, type: "external-session-source-unavailable", sessionId: session.id, machineId: machine.id, observedAtMs: 100 });
            await vi.waitFor(() => expect(delivered).toEqual([{ target: "qualified", payload: {
                type: "session-personal-event", sessionId: session.id, event: "source_unavailable", eventId: expect.any(String),
            } }]));
        } finally {
            eventRouter.clearIo();
        }
    });

    it("publishes committed human and material message facts without reclassifying ready or replaying an insert", async () => {
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const delivered: unknown[] = [];
        eventRouter.setIo({
            in: () => ({ fetchSockets: async () => [{ id: owner.id, data: { userId: owner.id,
                clientType: "user-scoped", clientPurpose: "sync", authAuthority: "present_user", authTokenAuthenticationEvidence: [] } }] }),
            to: () => ({ disconnectSockets: () => {}, emit: (kind, payload) => {
                if (kind === "ephemeral" && typeof payload === "object" && payload !== null
                    && "type" in payload && payload.type === "session-personal-event") delivered.push(payload);
            } }),
        });
        try {
            const human = { actorUserId: owner.id, sessionId: session.id, localId: "human-1",
                inputAdmission: "authenticatedAccount" as const,
                authentication: { env: process.env, authority: "present_user" as const, authenticationEvidence: [] },
                content: { t: "plain" as const, v: { role: "user", content: { type: "text", text: "Hello" } } },
            };
            const first = await createSessionMessage(human);
            expect(first).toMatchObject({ ok: true, didWrite: true });
            if (!first.ok) throw new Error("Human fixture was not admitted");
            await vi.waitFor(() => expect(delivered).toEqual([{
                type: "session-personal-event", sessionId: session.id, eventId: first.message.id,
                event: "human_message", message: { sequenceDomain: "session_transcript", messageSeq: first.message.seq }, sourceAccountId: owner.id,
            }]));
            expect(await createSessionMessage(human)).toMatchObject({ ok: true, didWrite: false });
            expect(delivered).toHaveLength(1);
            expect(await createSessionMessage({ actorUserId: owner.id, sessionId: session.id, localId: "ready-1",
                inputAdmission: "transcriptOnly", trustedSessionEventType: "ready",
                content: { t: "plain", v: { role: "agent", content: { type: "event", data: { type: "ready" } } } },
            })).toMatchObject({ ok: true, didWrite: true });
            const material = await createSessionMessage({ actorUserId: owner.id, sessionId: session.id, localId: "message-1",
                inputAdmission: "transcriptOnly", content: { t: "plain", v: { role: "agent", content: { type: "text", text: "Result" } } },
            });
            expect(material).toMatchObject({ ok: true, didWrite: true });
            if (!material.ok) throw new Error("Material fixture was not admitted");
            await vi.waitFor(() => expect(delivered).toHaveLength(2));
            expect(delivered[1]).toEqual({ type: "session-personal-event", sessionId: session.id,
                eventId: material.message.id, event: "message", message: { sequenceDomain: "session_transcript", messageSeq: material.message.seq } });
        } finally { eventRouter.clearIo(); }
    });


    it.each(["fail", "cancel"] as const)("publishes only a committed %s occurrence, never a replay", async (action) => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const delivered: unknown[] = [];
        eventRouter.setIo({
            in: () => ({ fetchSockets: async () => [{ id: owner.id, data: { userId: owner.id,
                clientType: "user-scoped", clientPurpose: "sync", authAuthority: "present_user", authTokenAuthenticationEvidence: [] } }] }),
            to: () => ({ disconnectSockets: () => {}, emit: (kind, payload) => {
                if (kind === "ephemeral" && typeof payload === "object" && payload !== null
                    && "type" in payload && payload.type === "session-personal-event") delivered.push(payload);
            } }),
        });
        const authentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: [] };
        const turnId = randomUUID();
        const observedAt = Date.now();
        try {
            expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(), action: "begin", turnId, observedAt,
            } })).toMatchObject({ ok: true, didApply: true });
            const mutation = { v: 1 as const, sessionId: session.id, mutationId: randomUUID(), action, turnId, observedAt: observedAt + 1,
                ...(action === "fail" ? { issue: { v: 1 as const, scope: "primary_session" as const, status: "failed" as const,
                    code: "agent_failed", source: "agent_session_error" as const, occurredAt: observedAt + 1, sanitizedPreview: "test" } } : {}),
            };
            expect(delivered).toEqual([]);
            expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation })).toMatchObject({ ok: true, didApply: true });
            await vi.waitFor(() => expect(delivered).toEqual([{
                type: "session-personal-event", sessionId: session.id, eventId: mutation.mutationId,
                event: action === "fail" ? "failed" : "cancelled", turnId,
            }]));
            await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation });
            expect(delivered).toHaveLength(1);
        } finally { eventRouter.clearIo(); }
    });

    it("admits actual subscriptions and one-shot targets independently of broad readable recipients", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const reader = await db.account.create({ data: { publicKey: randomUUID() } });
        const follower = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionShare.createMany({ data: [reader, follower].map(account => ({
            sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: account.id, accessLevel: "view" as const,
        })) });
        await db.accountSessionFollow.create({ data: { sessionId: session.id, accountId: follower.id, following: true, followPolicy: JSON.stringify({ preset: "important" }) } });
        expect((await listSessionPersonalEventRecipients({ sessionId: session.id, event: "ready" })).map(row => row.accountId).sort())
            .toEqual([owner.id, follower.id].sort());
        expect((await listSessionPersonalEventRecipients({ sessionId: session.id, event: "discussion_mention", targetAccountIds: [reader.id] })).map(row => row.accountId))
            .toEqual([reader.id]);
        // A direct share is one targeted relevance fact: the granted recipient only,
        // never the granting owner and never the unrelated follower.
        expect(await listSessionPersonalEventRecipients({ sessionId: session.id, event: "directly_shared", targetAccountIds: [reader.id] }))
            .toEqual([{ accountId: reader.id, reason: "direct_share_target" }]);
        expect(await listSessionPersonalEventRecipients({ sessionId: session.id, event: "directly_shared" })).toEqual([]);
        const contentFreeCandidates = await listSessionPersonalEventRecipients({
            sessionId: session.id,
            event: "ready",
        });
        expect(contentFreeCandidates.every((candidate) => (
            Object.keys(candidate).every((key) => key === "accountId" || key === "reason" || key === "follow")
        ))).toBe(true);
        for (const candidate of contentFreeCandidates) expect(candidate.follow).toEqual({
            event: { kind: 'finished' }, policies: [{ preset: 'important' }],
        });
        await db.sessionShare.deleteMany({ where: { sessionId: session.id, sharedWithUserId: follower.id } });
        expect((await listSessionPersonalEventRecipients({ sessionId: session.id, event: "ready" })).map(row => row.accountId))
            .toEqual([owner.id]);
        await db.account.update({ where: { id: owner.id }, data: { status: "suspended" } });
        expect(await listSessionPersonalEventRecipients({ sessionId: session.id, event: "ready" })).toEqual([]);
    });

    it('suppresses only the muted Account receiver from future source alerts without removing Follow', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const [muted, other] = await Promise.all([0, 1].map(() => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } })));
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionShare.createMany({ data: [muted, other].map(account => ({ sessionId: session.id,
            sharedByUserId: owner.id, sharedWithUserId: account.id, accessLevel: 'view' as const })) });
        await db.accountSessionFollow.createMany({ data: [muted, other].map(account => ({ sessionId: session.id,
            accountId: account.id, following: true, followPolicy: JSON.stringify({ preset: "important" }) })) });
        const before = await listSessionPersonalEventRecipients({ sessionId: session.id, event: 'ready' });
        expect(before.map(row => row.accountId).sort()).toEqual([owner.id, muted.id, other.id].sort());
        await db.account.update({ where: { id: muted.id }, data: { deliveryMutes: JSON.stringify([
            { kind: 'sender_session', sessionId: session.id },
        ]) } });
        const after = await listSessionPersonalEventRecipients({ sessionId: session.id, event: 'ready' });
        expect(after.map(row => row.accountId).sort()).toEqual([owner.id, other.id].sort());
        await db.account.update({ where: { id: muted.id }, data: { deliveryMutes: '{corrupt' } });
        expect((await listSessionPersonalEventRecipients({ sessionId: session.id, event: 'ready' }))
            .map(row => row.accountId).sort()).toEqual([owner.id, other.id].sort());
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: { accountId: muted.id, sessionId: session.id } } }))
            .toMatchObject({ following: true });
    });

    /**
     * Background delivery carries no request credential, so a restricted Team is
     * the one arm it cannot currently qualify. Owner, direct and inherited
     * (unrestricted) arms keep delivering.
     */
    it("admits a restricted-Team arm only when that Team qualifies without request evidence", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const restrictedFollower = await db.account.create({ data: { publicKey: randomUUID() } });
        const inheritFollower = await db.account.create({ data: { publicKey: randomUUID() } });
        const directFollower = await db.account.create({ data: { publicKey: randomUUID() } });
        const restrictedTeam = await db.team.create({ data: {
            name: `restricted-${randomUUID()}`,
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "github" }] },
        } });
        const inheritTeam = await db.team.create({ data: { name: `inherit-${randomUUID()}` } });
        await db.teamMembership.createMany({ data: [
            { teamId: restrictedTeam.id, accountId: restrictedFollower.id, role: "member" as const },
            { teamId: inheritTeam.id, accountId: inheritFollower.id, role: "member" as const },
        ] });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionTeamGrant.createMany({ data: [restrictedTeam, inheritTeam].map(team => ({
            sessionId: session.id, teamId: team.id, accessLevel: "view" as const, effectiveAt: new Date(0),
        })) });
        await db.sessionShare.create({ data: {
            sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: directFollower.id, accessLevel: "view",
        } });
        await db.accountSessionFollow.createMany({ data: [restrictedFollower, inheritFollower, directFollower].map(account => ({
            sessionId: session.id, accountId: account.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        })) });

        expect((await listSessionPersonalEventRecipients({ sessionId: session.id, event: "ready" })).map(row => row.accountId).sort())
            .toEqual([owner.id, inheritFollower.id, directFollower.id].sort());

        // A one-shot target is not a second way in: the same unqualified arm
        // decides the targeted event too.
        expect(await listSessionPersonalEventRecipients({
            sessionId: session.id, event: "discussion_mention", targetAccountIds: [restrictedFollower.id],
        })).toEqual([]);
        expect((await listSessionPersonalEventRecipients({
            sessionId: session.id, event: "discussion_mention", targetAccountIds: [inheritFollower.id],
        })).map(row => row.accountId)).toEqual([inheritFollower.id]);
    });

    /**
     * One background event fans out to every recipient of one Session, so the
     * admission reads that Session's access row once for the batch instead of
     * once per recipient. The admitted set is the same credential-qualified
     * answer: owner, direct and inherited arms in, a restricted-Team-only
     * recipient out.
     */
    it("reads the Session access row once for a batch of recipients", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const inheritFollower = await db.account.create({ data: { publicKey: randomUUID() } });
        const directFollower = await db.account.create({ data: { publicKey: randomUUID() } });
        const restrictedFollower = await db.account.create({ data: { publicKey: randomUUID() } });
        const inheritTeam = await db.team.create({ data: { name: `batch-inherit-${randomUUID()}` } });
        const restrictedTeam = await db.team.create({ data: {
            name: `batch-restricted-${randomUUID()}`,
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "github" }] },
        } });
        await db.teamMembership.createMany({ data: [
            { teamId: inheritTeam.id, accountId: inheritFollower.id, role: "member" as const },
            { teamId: restrictedTeam.id, accountId: restrictedFollower.id, role: "member" as const },
        ] });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionTeamGrant.createMany({ data: [inheritTeam, restrictedTeam].map(team => ({
            sessionId: session.id, teamId: team.id, accessLevel: "view" as const, effectiveAt: new Date(0),
        })) });
        await db.sessionShare.create({ data: {
            sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: directFollower.id, accessLevel: "view",
        } });

        let sessionRowReads = 0;
        const reader = new Proxy(db, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== "session" || typeof value !== "object" || value === null) return value;
                return new Proxy(value, {
                    get(delegate, method, delegateReceiver) {
                        const member = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== "findUnique" || typeof member !== "function") return member;
                        return (...args: readonly unknown[]) => {
                            sessionRowReads += 1;
                            return Reflect.apply(member, delegate, args);
                        };
                    },
                });
            },
        }) as unknown as Tx;

        const admitted = await admitSessionBackgroundDeliveryInTx(reader, {
            sessionId: session.id,
            accountIds: [owner.id, inheritFollower.id, directFollower.id, restrictedFollower.id],
        });
        expect([...admitted.keys()].sort()).toEqual([owner.id, inheritFollower.id, directFollower.id].sort());
        expect(sessionRowReads).toBe(1);
    });
});
