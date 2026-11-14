import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { initEncrypt } from "@/modules/encrypt";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { initFilesLocalFromEnv, loadFiles, readPublicFile } from "@/storage/blob/files";
import { plainPrivateLabel } from "@/testkit/privateLabelFixture";
import { createTeamGroupForActorInTx } from "./groups/groupService";
import { registerTeamGroupRoutes } from "./groups/registerTeamGroupRoutes";
import { createTeamInvitationForActorInTx, reissueTeamInvitationForActorInTx } from "./invitations/invitationService";
import { registerTeamInvitationRoutes } from "./invitations/registerTeamInvitationRoutes";
import { removeTeamLogo, setTeamLogo } from "./logo";
import { readStoredTeamLogo } from "./projections";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Team replay and logo contention (PostgreSQL)", () => {
    const accountIds: string[] = [];
    const teamIds: string[] = [];
    const previousEnv = new Map<string, string | undefined>();
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let filesDir: string;
    let image: { mimeType: "image/jpeg"; dataBase64: string };

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use a disposable PostgreSQL contract database");
        for (const [key, value] of Object.entries({
            HANDY_MASTER_SECRET: "serialaudit-team-replay-logo",
            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
            HAPPIER_DB_CONNECTION_LIMIT: "10",
        })) {
            previousEnv.set(key, process.env[key]);
            process.env[key] = value;
        }
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        filesDir = await mkdtemp(join(tmpdir(), "happier-team-replay-logo-"));
        initFilesLocalFromEnv({ ...process.env, HAPPIER_SERVER_LIGHT_DATA_DIR: filesDir });
        await loadFiles();
        image = { mimeType: "image/jpeg", dataBase64: (await sharp({
            create: { width: 32, height: 32, channels: 3, background: { r: 12, g: 34, b: 56 } },
        }).jpeg().toBuffer()).toString("base64") };
        app = createAuthenticatedTestApp();
        registerTeamGroupRoutes(app);
        registerTeamInvitationRoutes(app, {
            resolveJoinLinkTarget: async () => ({ applicationOrigin: "https://app.example.test", homeTarget: "replay-home" }),
            resolveJoinScreenHomeIdentity: async () => ({ serverId: "replay-home", displayName: "Replay Home", storageMode: "plain", hosting: null }),
            email: { delivery: { isReady: async () => true, deliver: async () => ({ status: "sent" }) }, isDeliveryReady: () => true },
        });
        await app.ready();
    });

    afterAll(async () => {
        if (app) await app.close();
        await db.team.deleteMany({ where: { id: { in: teamIds } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        await db.$disconnect();
        if (filesDir) await rm(filesDir, { recursive: true, force: true });
        for (const [key, value] of previousEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        accountIds.push(owner.id);
        const team = await db.team.create({ data: { name: "Concurrent replay and branding" } });
        teamIds.push(team.id);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        return { actorAccountId: owner.id, teamId: team.id };
    }

    async function objectExists(path: string) {
        try { await readPublicFile(path); return true; } catch { return false; }
    }

    it.each(["group", "invitation"] as const)("rechecks %s authority after an earlier Team mutation commits", async kind => {
        const input = { ...await fixture(), requestKey: randomUUID() };
        const groupInput = { ...input, groupId: randomUUID(), name: plainPrivateLabel("Demoted group") };
        let ready!: (pid: number) => void;
        let release!: () => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const holder = db.$transaction(async tx => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${input.teamId} FOR NO KEY UPDATE`;
            await tx.teamMembership.update({ where: { teamId_accountId: {
                teamId: input.teamId, accountId: input.actorAccountId,
            } }, data: { role: "member" } });
            ready(pid);
            await held;
        });
        const holderOutcome = Promise.allSettled([holder]);
        const mutate = () => inTx(async tx => kind === "group"
            ? createTeamGroupForActorInTx(tx, groupInput)
            : createTeamInvitationForActorInTx(tx, { ...input, role: "member", historyAccess: "from_membership",
                recipientEmailNormalized: null, emailDeliveryAvailable: true }), { isolationLevel: "ReadCommitted" });
        let mutation: ReturnType<typeof mutate> | undefined;
        let mutationOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof mutate>>>[]> | undefined;
        try {
            const pid = await Promise.race([started, holder.then(() => { throw new Error("Demotion missed rendezvous"); })]);
            let finished = false;
            mutation = mutate();
            mutationOutcome = Promise.allSettled([mutation]).finally(() => { finished = true; });
            while (!finished) {
                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked
                `;
                if (blocked) break;
            }
            release();
            await holder;
            const result = await mutation;
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error("Demoted actor retained mutation authority");
            expect(result.error).toBe(kind === "group" ? "team_forbidden" : "forbidden");
            expect(kind === "group" ? await db.teamGroup.count({ where: { teamId: input.teamId } })
                : await db.teamInvitation.count({ where: { teamId: input.teamId } })).toBe(0);
        } finally {
            release();
            await holderOutcome;
            if (mutationOutcome) await mutationOutcome;
        }
    });

    it.each(["group", "invitation", "reissue"] as const)("replays one %s intent after concurrent absence reads under ReadCommitted", async kind => {
        const input = { ...await fixture(), requestKey: randomUUID() };
        const groupInput = { ...input, groupId: randomUUID(), name: plainPrivateLabel("Exactly one group") };
        const initialInvitation = kind === "reissue" ? await inTx(tx => createTeamInvitationForActorInTx(tx, {
            ...input, requestKey: randomUUID(), role: "member", historyAccess: "from_membership",
            recipientEmailNormalized: null, emailDeliveryAvailable: true,
        })) : null;
        if (initialInvitation && !initialInvitation.ok) throw new Error(`Initial invitation refused: ${initialInvitation.error}`);
        const original = db.$transaction;
        const peerScope = new AsyncLocalStorage<boolean>();
        let scheduled = false;
        let peer: ReturnType<typeof mutate> | undefined;
        let peerOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const mutate = () => inTx(async tx => kind === "group"
            ? createTeamGroupForActorInTx(tx, groupInput)
            : initialInvitation?.ok
                ? reissueTeamInvitationForActorInTx(tx, { ...input, invitationId: initialInvitation.value.invitation.id,
                    replacementRecipientEmailNormalized: null, emailDeliveryAvailable: true })
                : createTeamInvitationForActorInTx(tx, { ...input, role: "member", historyAccess: "from_membership",
                    recipientEmailNormalized: null, emailDeliveryAvailable: true }), { isolationLevel: "ReadCommitted" });

        // Observe the real database boundary only. The complete owner path,
        // Account admission, replay codec and PostgreSQL locks remain real.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            const isPeer = peerScope.getStore();
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                if (isPeer) {
                    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    ready(pid);
                    return callback(tx);
                }
                const repeatKey = new Proxy(tx.repeatKey, { get(owner, property, receiver) {
                    if (property !== "findUnique") return Reflect.get(owner, property, receiver);
                    return async (...values: Parameters<typeof owner.findUnique>) => {
                        const found = await owner.findUnique(...values);
                        if (!scheduled && found === null) {
                            scheduled = true;
                            let settled = false;
                            peer = peerScope.run(true, mutate);
                            peerOutcome = Promise.allSettled([peer]).finally(() => { settled = true; });
                            const pid = await Promise.race([started, peer.then(() => { throw new Error("Replay peer missed rendezvous"); })]);
                            while (!settled) {
                                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                    SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                                `;
                                if (blocked) break;
                            }
                        }
                        return found;
                    };
                } });
                return callback(new Proxy(tx, { get(owner, property, receiver) {
                    return property === "repeatKey" ? repeatKey : Reflect.get(owner, property, receiver);
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const first = await mutate();
            expect(first.ok, first.ok ? undefined : first.error).toBe(true);
            if (!first.ok || !peer) throw new Error("Replay race did not reach the owner");
            const second = await peer;
            const firstId = "id" in first.value ? first.value.id
                : "invitation" in first.value ? first.value.invitation.id : first.value.replacement.id;
            expect(second.ok).toBe(true);
            if (!second.ok) throw new Error(`Replay refused: ${second.error}`);
            const secondId = "id" in second.value ? second.value.id
                : "invitation" in second.value ? second.value.invitation.id : second.value.replacement.id;
            expect(secondId).toBe(firstId);
            if ("token" in second.value) expect(second.value.token === null).toBe(true);
            expect(kind === "group" ? await db.teamGroup.count({ where: { teamId: input.teamId } })
                : await db.teamInvitation.count({ where: { teamId: input.teamId } })).toBe(kind === "reissue" ? 2 : 1);
        } finally {
            db.$transaction = original;
            if (peerOutcome) await peerOutcome;
        }
    });

    it("deletes the actual displaced logo when two ReadCommitted replacements overlap", async () => {
        const input = await fixture();
        const initial = await setTeamLogo({ ...input, image });
        if (!initial.ok) throw new Error(`Initial logo refused: ${initial.error}`);
        const original = db.$transaction;
        const peerScope = new AsyncLocalStorage<boolean>();
        let scheduled = false;
        let peer: ReturnType<typeof setTeamLogo> | undefined;
        let peerOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof setTeamLogo>>>[]> | undefined;
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            const isPeer = peerScope.getStore();
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                if (isPeer) {
                    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    ready(pid);
                    return callback(tx);
                }
                const team = new Proxy(tx.team, { get(owner, property, receiver) {
                    if (property !== "findUnique") return Reflect.get(owner, property, receiver);
                    return async (...values: Parameters<typeof owner.findUnique>) => {
                        const row = await owner.findUnique(...values);
                        if (!scheduled && values[0].select?.logo && Object.keys(values[0].select).length === 1) {
                            scheduled = true;
                            let settled = false;
                            peer = peerScope.run(true, () => setTeamLogo({ ...input, image }));
                            peerOutcome = Promise.allSettled([peer]).finally(() => { settled = true; });
                            const pid = await Promise.race([started, peer.then(() => { throw new Error("Logo peer missed rendezvous"); })]);
                            while (!settled) {
                                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                    SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                                `;
                                if (blocked) break;
                            }
                        }
                        return row;
                    };
                } });
                return callback(new Proxy(tx, { get(owner, property, receiver) {
                    return property === "team" ? team : Reflect.get(owner, property, receiver);
                } }));
            // Characterize the authorized RC conversion's cleanup invariant at
            // the SQL boundary; retain all actual public helper/writer logic.
            }, { ...(typeof args[1] === "object" && args[1] !== null ? args[1] : {}), isolationLevel: "ReadCommitted" }]);
        } });
        try {
            const first = await setTeamLogo({ ...input, image });
            expect(first.ok).toBe(true);
            if (!first.ok || !peer) throw new Error("Logo overlap missed capture");
            const second = await peer;
            expect(second.ok).toBe(true);
            if (!second.ok) return;
            const current = readStoredTeamLogo((await db.team.findUniqueOrThrow({ where: { id: input.teamId } })).logo, input.teamId);
            for (const path of [initial.team.logo?.path, first.team.logo?.path, second.team.logo?.path]) {
                if (!path) throw new Error("Successful branding must project its path");
                expect(await objectExists(path), path === current?.path ? "Winning object retained" : "Displaced object removed")
                    .toBe(path === current?.path);
            }
        } finally {
            db.$transaction = original;
            if (peerOutcome) await peerOutcome;
        }
    });

    it.each(["group", "invitation", "logo_set", "logo_remove"] as const)("%s commits while its Account cursor advances before publication", async kind => {
        const input = await fixture();
        if (kind === "logo_remove") expect((await setTeamLogo({ ...input, image })).ok).toBe(true);
        const original = db.$transaction;
        const peerScope = new AsyncLocalStorage<boolean>();
        const peers: Promise<unknown>[] = [];
        let advances = 0;
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function" || peerScope.getStore()) return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let advanced = false;
                const query = tx.$queryRawUnsafe.bind(tx);
                return callback(new Proxy(tx, { get(owner, property, receiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, receiver);
                    return async (...values: Parameters<typeof query>) => {
                        if (!advanced && values[0].includes('FROM "Account"') && values[0].endsWith("FOR NO KEY UPDATE")) {
                            advanced = true;
                            const peer = peerScope.run(true, () => inTx(writer => markAccountChanged(writer, {
                                accountId: input.actorAccountId, kind: "account", entityId: "team-replay-logo-peer",
                            })));
                            peers.push(peer);
                            await peer;
                            advances++;
                        }
                        return query(...values);
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            if (kind === "group" || kind === "invitation") {
                const response = await app.inject({ method: "POST", url: `/v1/teams/${kind === "group" ? "groups" : "invitations"}/create`,
                    headers: { "x-test-user-id": input.actorAccountId }, payload: { v: 1, teamId: input.teamId, requestKey: randomUUID(),
                        ...(kind === "group" ? { name: "Hot replay group" }
                            : { role: "member", historyAccess: "from_membership", recipientEmail: null }) } });
                expect(response.statusCode, JSON.stringify({ statusCode: response.statusCode, error: response.json().error })).toBe(200);
            } else {
                const result = kind === "logo_set" ? await setTeamLogo({ ...input, image }) : await removeTeamLogo(input);
                expect(result.ok).toBe(true);
            }
            expect(advances).toBeGreaterThan(0);
        } finally {
            db.$transaction = original;
            const outcomes = await Promise.allSettled(peers);
            expect(outcomes.filter(outcome => outcome.status === "rejected")).toEqual([]);
        }
    });
});
