import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { putSessionAccessGrantInTx } from "./sessionAccessGrantService";
import { setTeamMembershipStatusInTx } from "@/app/teams/memberships/membershipService";
import { restoreTeamGroupForActorInTx } from "@/app/teams/groups/groupService";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "./sessionRecipients";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { setSessionManager } from "@/app/session/follow/sessionManagerService";
import { setSessionFollowSource } from "@/app/session/follow/sessionFollowEdgeService";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Session audience expansion writer fences (PostgreSQL)", () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable DATABASE_URL");
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("waits on the ready projection's Session before terminal Account publication", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
        } });
        let publisher: Promise<unknown> | undefined;
        try {
            await db.$transaction(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                // Physical deletion takes this strongest parent mode. A publisher
                // must wait here before its terminal Account/FK writes, not in them.
                await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${session.id} FOR UPDATE`;
                let finished = false;
                publisher = publishSessionReadyProjectionUpdate({ sessionId: session.id,
                    readyProjection: { latestReadyEventSeq: 1, latestReadyEventAt: Date.now() } })
                    .finally(() => { finished = true; });
                void publisher.catch(() => undefined);
                let waiting = false;
                while (!finished && !waiting) {
                    const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                            AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(true);
                // Probe the persistent boundary directly: inTx deliberately
                // retries 55P03, which would hide the lock-order observation.
                await expect(db.$transaction(peer => peer.$queryRawUnsafe(
                    'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', owner.id,
                ))).resolves.toEqual([{ id: owner.id }]);
            });
            await publisher;
        } finally {
            await publisher;
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it("serializes a direct grant with the Session domain writer before changing its audience", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
        } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: reader.id, status: "friend" } });
        let writer: Promise<unknown> | undefined;
        try {
            await db.$transaction(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${session.id} FOR NO KEY UPDATE`;
                let finished = false;
                writer = inTx(peer => putSessionAccessGrantInTx(peer, {
                    sessionId: session.id, actorAccountId: owner.id, subject: { kind: "account", accountId: reader.id },
                    grant: { accessLevel: "view", canApprovePermissions: false },
                    authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
                }), { isolationLevel: "ReadCommitted" }).finally(() => { finished = true; });
                void writer.catch(() => undefined);
                let waiting = false;
                while (!finished && !waiting) {
                    const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                            AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(true);
                expect(await tx.sessionGrant.count({ where: { principalKind: 'account', sessionId: session.id, accountId: reader.id } })).toBe(0);
            });
            expect(await writer).toMatchObject({ ok: true, changed: true });
            expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: session.id, accountId: reader.id } })).toBe(1);
        } finally {
            await writer;
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
        }
    });

    it("holds Follow attachment until the source Account fence is available", async () => {
        const prefix = `audience-follow-${randomUUID()}`;
        const destinationOwner = await db.account.create({ data: { id: `${prefix}-a-destination`, publicKey: `${prefix}-destination`, encryptionMode: "plain" } });
        const sourceOwner = await db.account.create({ data: { id: `${prefix}-b-source`, publicKey: `${prefix}-source`, encryptionMode: "plain" } });
        const destination = await db.session.create({ data: { accountId: destinationOwner.id, tag: prefix, metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted" } });
        const source = await db.session.create({ data: { accountId: sourceOwner.id, tag: prefix, metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted" } });
        let release!: () => void;
        let holderReady!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        const sourceHeld = new Promise<void>(resolve => { holderReady = resolve; });
        try {
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: source.id, createdByAccountId: sourceOwner.id,
                accountId: destinationOwner.id, accessLevel: "edit" } });
            let holderPid = -1;
            const holder = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, sourceOwner.id, "exclusive");
                const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                holderPid = row.pid;
                holderReady();
                await mayCommit;
            }, { isolationLevel: "ReadCommitted" });
            const holderOutcome = Promise.allSettled([holder]);
            await sourceHeld;
            let writerSettled = false;
            const writer = setSessionFollowSource({ accountId: destinationOwner.id, sourceSessionId: source.id,
                destinationSessionId: destination.id, policy: { preset: 'quiet' },
                authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] } });
            const writerOutcome = Promise.allSettled([writer]).finally(() => { writerSettled = true; });
            try {
                while (!writerSettled) {
                    const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting", holderPid,
                    );
                    if (row.waiting) break;
                }
                expect(writerSettled).toBe(false);
            } finally {
                release();
                for (const outcome of await holderOutcome) if (outcome.status === "rejected") throw outcome.reason;
                const [outcome] = await writerOutcome;
                if (outcome.status === "rejected") throw outcome.reason;
                expect(outcome.value).toMatchObject({ ok: true, value: { changed: true } });
            }
        } finally {
            release();
            await db.session.deleteMany({ where: { id: { in: [source.id, destination.id] } } });
            await db.account.deleteMany({ where: { id: { in: [sourceOwner.id, destinationOwner.id] } } });
        }
    });

    it("locks an incoming ReportsTo child's lower Account before the lead grant mutates", async () => {
        const prefix = `audience-reports-${randomUUID()}`;
        const childOwner = await db.account.create({ data: { id: `${prefix}-a-child`, publicKey: `${prefix}-child`, encryptionMode: "plain" } });
        const leadOwner = await db.account.create({ data: { id: `${prefix}-b-lead`, publicKey: `${prefix}-lead`, encryptionMode: "plain" } });
        const reader = await db.account.create({ data: { id: `${prefix}-c-reader`, publicKey: `${prefix}-reader`, encryptionMode: "plain" } });
        const child = await db.session.create({ data: { accountId: childOwner.id, tag: prefix, metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted" } });
        const lead = await db.session.create({ data: { accountId: leadOwner.id, tag: prefix, metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted" } });
        let release!: () => void;
        let holderReady!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        const childHeld = new Promise<void>(resolve => { holderReady = resolve; });
        const authentication = { env: process.env, authority: "present_user", authenticationEvidence: [] } as const;
        try {
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: child.id, createdByAccountId: childOwner.id, accountId: leadOwner.id, accessLevel: "edit" } });
            expect(await setSessionManager({ accountId: leadOwner.id, sessionId: child.id, managerSessionId: lead.id,
                expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            await db.userRelationship.create({ data: { fromUserId: leadOwner.id, toUserId: reader.id, status: "friend" } });
            let holderPid = -1;
            const holder = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, childOwner.id, "exclusive");
                const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                holderPid = row.pid;
                holderReady();
                await mayCommit;
            }, { isolationLevel: "ReadCommitted" });
            const holderOutcome = Promise.allSettled([holder]);
            await childHeld;
            let writerSettled = false;
            const writer = inTx(tx => putSessionAccessGrantInTx(tx, {
                sessionId: lead.id, actorAccountId: leadOwner.id, subject: { kind: "account", accountId: reader.id },
                grant: { accessLevel: "view", canApprovePermissions: false }, authentication,
            }), { isolationLevel: "ReadCommitted" });
            const writerOutcome = Promise.allSettled([writer]).finally(() => { writerSettled = true; });
            try {
                while (!writerSettled) {
                    const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting", holderPid,
                    );
                    if (row.waiting) break;
                }
                expect(writerSettled).toBe(false);
                await expect(inTx(tx => tx.$queryRawUnsafe(
                    'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', leadOwner.id,
                ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([{ id: leadOwner.id }]);
            } finally {
                release();
                for (const outcome of [...await holderOutcome, ...await writerOutcome]) {
                    if (outcome.status === "rejected") throw outcome.reason;
                }
            }
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toBeNull();
        } finally {
            release();
            await db.session.deleteMany({ where: { id: { in: [child.id, lead.id] } } });
            await db.account.deleteMany({ where: { id: { in: [childOwner.id, leadOwner.id, reader.id] } } });
        }
    });

    it("waits on the Session owner before locking a newly active reader's Account", async () => {
        const prefix = `audience-lifecycle-${randomUUID()}`;
        const owner = await db.account.create({ data: {
            id: `${prefix}-a-owner`, publicKey: `${prefix}-owner`, encryptionMode: "plain",
        } });
        const reader = await db.account.create({ data: {
            id: `${prefix}-b-reader`, publicKey: `${prefix}-reader`, encryptionMode: "plain", status: "suspended",
        } });
        const actor = await db.account.create({ data: {
            id: `${prefix}-c-actor`, publicKey: `${prefix}-actor`, encryptionMode: "plain",
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: prefix, metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
        } });
        let release!: () => void;
        let holderReady!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        const ownerHeld = new Promise<void>(resolve => { holderReady = resolve; });
        try {
            await db.sessionGrant.create({ data: { principalKind: 'account',
                sessionId: session.id, createdByAccountId: owner.id, accountId: reader.id, accessLevel: "view",
            } });
            let holderPid = -1;
            const holder = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, owner.id, "exclusive");
                const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                holderPid = row.pid;
                holderReady();
                await mayCommit;
            }, { isolationLevel: "ReadCommitted" });
            const holderOutcome = Promise.allSettled([holder]);
            await ownerHeld;
            let writerSettled = false;
            const writer = inTx(tx => setAccountStatusInTx(tx, {
                actorAccountId: actor.id, targetAccountId: reader.id, status: "active", authority: "provider_account_replacement",
            }), { isolationLevel: "ReadCommitted" });
            const writerOutcome = Promise.allSettled([writer]).finally(() => { writerSettled = true; });
            try {
                while (!writerSettled) {
                    const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting", holderPid,
                    );
                    if (row.waiting) break;
                }
                expect(writerSettled).toBe(false);
                await expect(inTx(tx => tx.$queryRawUnsafe(
                    'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', reader.id,
                ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([{ id: reader.id }]);
            } finally {
                release();
                for (const outcome of [...await holderOutcome, ...await writerOutcome]) {
                    if (outcome.status === "rejected") throw outcome.reason;
                }
            }
            expect(await db.account.findUniqueOrThrow({ where: { id: reader.id }, select: { status: true } }))
                .toEqual({ status: "active" });
        } finally {
            release();
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id, actor.id] } } });
        }
    });

    it.each(["direct_grant", "team_reactivation", "group_restore"] as const)(
        "holds the inactive Session owner's Account through %s commit",
        async transition => {
            const prefix = `audience-writer-${randomUUID()}`;
            const owner = await db.account.create({ data: {
                id: `${prefix}-a-owner`, publicKey: `${prefix}-owner`, encryptionMode: "plain", status: "suspended",
            } });
            const actor = await db.account.create({ data: {
                id: `${prefix}-b-actor`, publicKey: `${prefix}-actor`, encryptionMode: "plain",
            } });
            const recipient = await db.account.create({ data: {
                id: `${prefix}-c-reader`, publicKey: `${prefix}-reader`, encryptionMode: "plain",
            } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: prefix, metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
            } });
            const team = await db.team.create({ data: { name: prefix } });
            let release!: () => void;
            let completed!: () => void;
            const mayCommit = new Promise<void>(resolve => { release = resolve; });
            const mutationComplete = new Promise<void>(resolve => { completed = resolve; });
            try {
                await db.sessionGrant.create({ data: { principalKind: 'account',
                    sessionId: session.id, createdByAccountId: owner.id, accountId: actor.id, accessLevel: "admin",
                } });
                await db.userRelationship.create({ data: { fromUserId: actor.id, toUserId: recipient.id, status: "friend" } });
                await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "owner" } });
                const member = await db.teamMembership.create({ data: {
                    teamId: team.id, accountId: recipient.id, role: "member",
                    status: transition === "team_reactivation" ? "suspended" : "active",
                } });
                const group = await db.teamGroup.create({ data: {
                    teamId: team.id, name: storedPlainPrivateLabel(prefix), archivedAt: new Date(),
                } });
                await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id } });
                if (transition === "team_reactivation") {
                    await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });
                } else if (transition === "group_restore") {
                    await db.sessionGrant.create({ data: { principalKind: 'group', sessionId: session.id, teamGroupId: group.id, accessLevel: "view", effectiveAt: new Date() } });
                }
                expect(await inTx(tx => resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: session.id })))
                    .not.toContain(recipient.id);
                const writer = inTx(async tx => {
                    try {
                        if (transition === "direct_grant") {
                            expect(await putSessionAccessGrantInTx(tx, {
                                sessionId: session.id, actorAccountId: actor.id, subject: { kind: "account", accountId: recipient.id },
                                grant: { accessLevel: "view", canApprovePermissions: false },
                                authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
                            })).toMatchObject({ ok: true, changed: true });
                        } else if (transition === "team_reactivation") {
                            await setTeamMembershipStatusInTx(tx, {
                                teamId: team.id, membershipId: member.id, accountId: recipient.id, status: "active",
                            });
                        } else {
                            expect(await restoreTeamGroupForActorInTx(tx, {
                                teamId: team.id, actorAccountId: actor.id, groupId: group.id,
                            })).toMatchObject({ ok: true });
                        }
                        expect(await resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: session.id })).toContain(recipient.id);
                    } finally { completed(); }
                    await mayCommit;
                }, { isolationLevel: "ReadCommitted" });
                const writerOutcome = Promise.allSettled([writer]);
                await mutationComplete;
                try {
                    // Observe one NOWAIT attempt. The production transaction owner
                    // retries 55P03, which would outwait this test's held writer.
                    await expect(db.$queryRawUnsafe(
                        'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', owner.id,
                    )).rejects.toMatchObject({ meta: { code: '55P03' } });
                    const cursorWriter = db.$queryRawUnsafe(
                        'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', owner.id,
                    );
                    if (transition === "direct_grant") {
                        // Grant admission excludes cursor writers before it reads
                        // authority; native membership paths retain content admission.
                        await expect(cursorWriter).rejects.toMatchObject({ meta: { code: '55P03' } });
                    } else {
                        await expect(cursorWriter).resolves.toEqual([{ id: owner.id }]);
                    }
                } finally {
                    release();
                    for (const outcome of await writerOutcome) if (outcome.status === "rejected") throw outcome.reason;
                }
            } finally {
                release();
                await db.session.delete({ where: { id: session.id } });
                await db.team.delete({ where: { id: team.id } });
                await db.account.deleteMany({ where: { id: { in: [owner.id, actor.id, recipient.id] } } });
            }
        },
    );
});
