import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from "@happier-dev/protocol";
import { SessionInputMachineTargetV1Schema } from "@happier-dev/protocol/sessions/messages/sessionInputAdmission";

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { revokeMachineInTx } from "@/app/machines/machineMutations";
import { applyMachineReplacement } from "@/app/machines/applyMachineReplacement";
import { eventRouter } from "@/app/events/eventRouter";
import { deleteAccountForErasure } from "@/app/plugins/data/accountDataErase";
import { setMachineAccessGrantInTx, removeMachineAccessGrantInTx } from "@/app/machines/machineAccess";
import { auth } from "@/app/auth/auth";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { accessKeyHandler } from "@/app/api/socket/accessKeyHandler";
import { resolveSessionScopedSocketBinding, canPublishFromSessionScopedSocket } from "@/app/api/socket/sessionScopedBinding";
import { hasCurrentSocketCredential } from "@/app/api/socket/socketCredentialCurrentness";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { hasCurrentPublisherTargetAdmissionCapabilityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import { enqueuePendingMessage, materializeNextPendingMessage, settlePendingInputAdmission } from "@/app/session/pending/pendingMessageService";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { accessKeysRoutes } from "@/app/api/routes/accessKeys/accessKeysRoutes";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { isCurrentSessionInputMachineTargetInTx } from "@/app/session/messages/sessionInputAdmission";

import {
    createSessionMachineAccessKeyInTx,
    readSessionMachineBindingStateInTx,
    readMachineAccessKeySessionBindingsInTx,
    readSessionMachineAccessKeyInTx,
    updateSessionMachineAccessKeyDataInTx,
} from "./sessionMachineAccessKeyMutations";

describe("session/machine AccessKey mutations (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-machine-access-key-",
            initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" },
        });
        await getOrCreateServerIdentityId();
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    afterEach(async () => {
        eventRouter.clearIo();
        await harness.resetDbTables([
            () => db.accessKey.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccount(publicKey: string) {
        return db.account.create({
            data: { publicKey, encryptionMode: "plain" },
            select: { id: true },
        });
    }

    async function createSession(accountId: string, tag: string) {
        return db.session.create({
            data: { accountId, tag, encryptionMode: "plain", metadata: "{}" },
            select: { id: true },
        });
    }

    async function createMachine(accountId: string, id: string) {
        return db.machine.create({
            data: { id, accountId, metadata: "{}" },
            select: { id: true },
        });
    }

    async function createInstalledPlainMachine(accountId: string, id: string) {
        return db.machine.create({ data: {
            id, accountId, installationId: `installation-${id}`,
            metadata: encodePlainMachineStoredContent({ host: "host", platform: "linux", happyCliVersion: "test", homeDir: "/home/test", happyHomeDir: "/home/test/.happier" }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
    }

    it("uses C41 readiness for installed custodians but preserves exact legacy owned tuples", async () => {
        const owner = await createAccount("pk-access-key-readiness");
        const session = await createSession(owner.id, "readiness-session");
        const installed = await createInstalledPlainMachine(owner.id, "readiness-installed");
        await db.machine.update({ where: { id: installed.id }, data: { metadata: "{}" } });
        await expect(createSessionMachineAccessKeyInTx(db, { accountId: owner.id, machineId: installed.id, sessionId: session.id, data: "key" }))
            .resolves.toEqual({ ok: false, reason: "binding-not-found" });
        const legacy = await createMachine(owner.id, "readiness-legacy");
        await expect(createSessionMachineAccessKeyInTx(db, { accountId: owner.id, machineId: legacy.id, sessionId: session.id, data: "legacy-key" }))
            .resolves.toMatchObject({ ok: true, created: true });
    });

    it("serves the released AccessKey HTTP contract using the ordinary requester credential and current C41 admission", async () => {
        const custodian = await createAccount("pk-access-key-http-custodian");
        const requester = await createAccount("pk-access-key-http-requester");
        const session = await createSession(requester.id, "http-requester-session");
        const machine = await createInstalledPlainMachine(custodian.id, "http-custodian-machine");
        const token = await auth.createToken(requester.id, undefined, { kind: "terminal", authority: "account_automation" });
        const custodianToken = await auth.createToken(custodian.id, undefined, { kind: "terminal", authority: "account_automation" });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        accessKeysRoutes(app);
        const url = `/v1/access-keys/${session.id}/${machine.id}`;
        const headers = { authorization: `Bearer ${token}` };
        try {
            await app.ready();
            expect((await app.inject({ method: "POST", url, headers, payload: { data: "requester-key" } })).statusCode).toBe(404);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: "account", accountId: requester.id }, level: "view" }));
            const created = await app.inject({ method: "POST", url, headers, payload: { data: "requester-key" } });
            expect(created.statusCode).toBe(200);
            expect(created.json()).toMatchObject({ success: true, accessKey: { data: "requester-key", dataVersion: 1 } });
            expect(created.json()).not.toHaveProperty("runtimeToken");
            expect((await app.inject({ method: "POST", url, headers, payload: { data: "overwrite" } })).statusCode).toBe(409);
            const read = await app.inject({ method: "GET", url, headers });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toMatchObject({ accessKey: { data: "requester-key", dataVersion: 1 } });
            expect((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${custodianToken}` } })).statusCode).toBe(404);
            const updated = await app.inject({ method: "PUT", url, headers, payload: { data: "next-key", expectedVersion: 1 } });
            expect(updated.statusCode).toBe(200);
            expect(updated.json()).toEqual({ success: true, version: 2 });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: "account", accountId: requester.id } }));
            expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
            expect((await app.inject({ method: "PUT", url, headers, payload: { data: "forbidden", expectedVersion: 2 } })).statusCode).toBe(404);
            await expect(db.accessKey.findUnique({ where: { accountId_machineId_sessionId: { accountId: requester.id, sessionId: session.id, machineId: machine.id } } }))
                .resolves.toMatchObject({ data: "next-key", dataVersion: 2 });
        } finally {
            await app.close();
        }
    });

    it.each(["grant", "installation", "replacement"] as const)("admits an ordinary requester publisher only for a current exact tuple and fences %s loss", async (loss) => {
        const custodian = await createAccount(`pk-access-key-runtime-custodian-${loss}`);
        const requester = await createAccount(`pk-access-key-runtime-requester-${loss}`);
        const machine = await createInstalledPlainMachine(custodian.id, `runtime-machine-${loss}`);
        const session = await createSession(requester.id, `runtime-session-${loss}`);
        const otherSession = await createSession(requester.id, `runtime-other-session-${loss}`);
        const binding = { accountId: requester.id, machineId: machine.id, sessionId: session.id };
        await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { ...binding, data: "requester-key" })))
            .resolves.toEqual({ ok: false, reason: "binding-not-found" });
        await expect(inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: "account", accountId: requester.id }, level: "view" }))).resolves.toMatchObject({ kind: "saved", readiness: "ready" });
        await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { ...binding, data: "requester-key" })))
            .resolves.toMatchObject({ ok: true, created: true });
        const token = await auth.createToken(requester.id, undefined, { kind: "terminal", authority: "account_automation" });
        await expect(auth.verifyTokenForRoute(token)).resolves.toMatchObject({ userId: requester.id });
        await expect(resolveSessionScopedSocketBinding({ userId: requester.id, sessionId: session.id, machineId: machine.id }))
            .resolves.toMatchObject({ ok: true, binding: { sessionId: session.id, machineId: machine.id, proof: "machine-access-key" } });
        await expect(resolveSessionScopedSocketBinding({ userId: custodian.id, sessionId: session.id, machineId: machine.id }))
            .resolves.toMatchObject({ ok: false, error: "invalid-session-access-key" });
        await expect(resolveSessionScopedSocketBinding({ userId: requester.id, sessionId: otherSession.id, machineId: machine.id }))
            .resolves.toMatchObject({ ok: false, error: "invalid-session-access-key" });
        // Only Socket.IO is replaced: credential verification, DB admission,
        // AccessKey reading and publisher lifecycle remain their actual owners.
        const fake = Object.assign(createFakeSocket({ data: { clientType: "session-scoped", sessionScopedBinding: {
            sessionId: session.id, machineId: machine.id, proof: "machine-access-key",
        } } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        const socket = fake as unknown as Socket;
        const connection = { connectionType: "session-scoped", socket, userId: requester.id, sessionId: session.id, machineId: machine.id } as const;
        accessKeyHandler(requester.id, socket, connection);
        const callback = vi.fn();
        await getSocketHandler(fake, "access-key-get")({ sessionId: session.id, machineId: machine.id }, callback);
        expect(callback).toHaveBeenLastCalledWith({ ok: true, accessKey: expect.objectContaining({ data: "requester-key", dataVersion: 1 }) });
        await expect(canPublishFromSessionScopedSocket({ socket, connection, sessionId: session.id, requireMachineBinding: true })).resolves.toBe(true);
        await expect(canPublishFromSessionScopedSocket({ socket, connection: { ...connection, userId: custodian.id }, sessionId: session.id, requireMachineBinding: true })).resolves.toBe(false);
        const presence = createSessionPublisherPresence();
        const registration = await presence.registerPublisher({ socket, binding, completeActivitySnapshot: { state: "unknown", activeCount: 0 } });
        expect(registration).toMatchObject({ status: "registered" });
        if (registration.status !== "registered") throw new Error("Requester publisher was not admitted");
        const authority = { ...binding, committedFence: registration.committedFence };
        await expect(presence.checkCurrentPublisher({ socket })).resolves.toBe(true);
        await expect(inTx(tx => hasCurrentPublisherTargetAdmissionCapabilityInTx(tx, authority))).resolves.toBe(true);
        const input = {
            actorUserId: requester.id, sessionId: session.id, localId: "requester-run-input",
            authentication: createPresentUserSessionAccessAuthentication(),
            targetMachineId: machine.id, targetExecutionRunId: "requester-run",
            requestedAction: { v: 1, kind: "enqueue" },
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "continue" } } },
        } as const;
        const enqueued = await enqueuePendingMessage(input);
        expect(enqueued, JSON.stringify(enqueued)).toMatchObject({ ok: true, didWrite: true });
        await expect(materializeNextPendingMessage({ actorUserId: requester.id, sessionId: session.id,
            deliveryState: "provider", deliveryTiming: "after_foreground_ready", foregroundState: "ready",
            publisherAuthority: authority, targetExecutionRunId: "requester-run", expectedSidechainId: "requester-sidechain" }))
            .resolves.toMatchObject({ ok: true, didMaterialize: true });
        await expect(settlePendingInputAdmission({ actorUserId: requester.id, sessionId: session.id,
            publisherAuthority: authority, localId: input.localId, decision: { kind: "reject", code: "session_input_unauthorized" } }))
            .resolves.toMatchObject({ ok: true });
        if (loss === "grant") {
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: "account", accountId: requester.id } }));
        } else if (loss === "installation") {
            await db.machine.update({ where: { id: machine.id }, data: { installationId: null } });
        } else {
            const replacement = await createInstalledPlainMachine(custodian.id, `runtime-replacement-${loss}`);
            await inTx(tx => applyMachineReplacement({ tx, accountId: custodian.id, oldMachineId: machine.id, replacementMachineId: replacement.id,
                reason: "machine_rotation", source: "manual", actorUserId: custodian.id }));
        }
        await expect(presence.checkCurrentPublisher({ socket })).resolves.toBe(false);
        await expect(inTx(tx => hasCurrentPublisherTargetAdmissionCapabilityInTx(tx, authority))).resolves.toBe(false);
        await expect(enqueuePendingMessage({ ...input, localId: "requester-after-access-loss" }))
            .resolves.toMatchObject({ ok: false, admissionRejectionCode: "session_input_target_unavailable" });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: "requester-after-access-loss" } })).resolves.toBe(0);
        await expect(canPublishFromSessionScopedSocket({ socket, connection, sessionId: session.id, requireMachineBinding: true })).resolves.toBe(false);
        await getSocketHandler(fake, "access-key-get")({ sessionId: session.id, machineId: machine.id }, callback);
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
        await expect(db.accessKey.findUnique({ where: { accountId_machineId_sessionId: binding } })).resolves.toMatchObject({ data: "requester-key" });
        await expect(db.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({ accountId: requester.id });
        await db.account.update({ where: { id: requester.id }, data: { tokenEpoch: { increment: 1 } } });
        await expect(hasCurrentSocketCredential(requester.id, socket)).resolves.toBe(false);
    });

    it("refuses to write a key for a Session owned by another Account", async () => {
        const owner = await createAccount("pk-access-key-owner");
        const stranger = await createAccount("pk-access-key-stranger");
        const session = await createSession(owner.id, "owned-session");
        const machine = await createMachine(stranger.id, "stranger-machine");

        await expect(createSessionMachineAccessKeyInTx(db, {
            accountId: stranger.id,
            machineId: machine.id,
            sessionId: session.id,
            data: "key",
        })).resolves.toEqual({ ok: false, reason: "binding-not-found" });
        await expect(db.accessKey.count()).resolves.toBe(0);
    });

    it.each(["grant", "installation", "home"] as const)("retains the committed publisher placement for cold input and refuses %s loss instead of choosing another usable key", async (loss) => {
        const custodian = await createAccount("pk-cold-placement-custodian");
        const requester = await createAccount("pk-cold-placement-requester");
        const session = await createSession(requester.id, "cold-placement-session");
        const unused = await createInstalledPlainMachine(custodian.id, "cold-placement-unused");
        const selected = await createInstalledPlainMachine(custodian.id, "cold-placement-selected");
        for (const machine of [unused, selected]) {
            await inTx(tx => setMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: "account", accountId: requester.id }, level: "view",
            }));
            await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
                accountId: requester.id, sessionId: session.id, machineId: machine.id, data: "requester-key",
            }));
        }
        const input = { actorUserId: requester.id, sessionId: session.id, localId: "cold-placement-input",
            authentication: createPresentUserSessionAccessAuthentication(),
            requestedAction: { v: 1, kind: "send_now" },
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "continue" } } },
        } as const;
        await expect(enqueuePendingMessage({ ...input, localId: "unplaced-input" }))
            .resolves.toMatchObject({ ok: true, didWrite: true });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: "unplaced-input" } },
        })).inputAdmissionReceipt).not.toHaveProperty("admittedTarget");
        const socket = createFakeSocket();
        const presence = createSessionPublisherPresence();
        await expect(presence.registerPublisher({ socket,
            binding: { accountId: requester.id, sessionId: session.id, machineId: selected.id },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toMatchObject({ status: "registered" });
        await expect(presence.closePublisher({ socket })).resolves.toMatchObject({ status: "closed" });
        const committed = SessionInputMachineTargetV1Schema.parse((await db.session.findUniqueOrThrow({
            where: { id: session.id }, select: { runtimeMachineTarget: true },
        })).runtimeMachineTarget);
        await db.session.update({ where: { id: session.id }, data: {
            runtimeMachineTarget: { ...committed, futureDisplay: "ignored" },
        } });
        await expect(enqueuePendingMessage(input)).resolves.toMatchObject({ ok: true, didWrite: true });
        const row = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: input.localId } },
            select: { inputAdmissionReceipt: true },
        });
        expect(row.inputAdmissionReceipt).toMatchObject({ admittedTarget: {
            accountId: requester.id, sessionId: session.id, machineId: selected.id,
            installationId: selected.installationId,
        } });
        expect(row.inputAdmissionReceipt).not.toHaveProperty("admittedTarget.futureDisplay");

        if (loss === "grant") {
            await inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: selected.id,
                principal: { kind: "account", accountId: requester.id },
            }));
        } else if (loss === "installation") {
            await db.machine.update({ where: { id: selected.id }, data: { installationId: "replacement-installation" } });
        } else {
            await db.session.update({ where: { id: session.id }, data: {
                runtimeMachineTarget: { ...committed, homeId: `srv_${"f".repeat(32)}` },
            } });
        }
        await expect(enqueuePendingMessage({ ...input, localId: "cold-placement-revoked" }))
            .resolves.toMatchObject({ ok: false, admissionRejectionCode: "session_input_target_unavailable" });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: "cold-placement-revoked" } }))
            .resolves.toBe(0);
        await expect(db.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({ accountId: requester.id });
        const replacementSocket = createFakeSocket();
        await expect(presence.registerPublisher({ socket: replacementSocket,
            binding: { accountId: requester.id, sessionId: session.id, machineId: unused.id },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toMatchObject({ status: "registered" });
        await expect(inTx(tx => isCurrentSessionInputMachineTargetInTx(tx, committed))).resolves.toBe(false);
        await expect(presence.closePublisher({ socket: replacementSocket })).resolves.toMatchObject({ status: "closed" });
        await expect(enqueuePendingMessage({ ...input, localId: "cold-placement-after-admitted-move" }))
            .resolves.toMatchObject({ ok: true, didWrite: true });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: session.id, localId: "cold-placement-after-admitted-move",
        } } })).inputAdmissionReceipt).toMatchObject({ admittedTarget: {
            accountId: requester.id, sessionId: session.id, machineId: unused.id,
            installationId: unused.installationId,
        } });
    });

    it("stores requester tuples independently of Machine custody and invalidates them only through the custodian", async () => {
        const custodian = await createAccount("pk-access-key-custodian");
        const requester = await createAccount("pk-access-key-requester");
        const stranger = await createAccount("pk-access-key-unrelated");
        const machine = await createMachine(custodian.id, "custodian-machine");
        const otherMachine = await createMachine(custodian.id, "other-custodian-machine");
        const ownSession = await createSession(custodian.id, "custodian-session");
        const requesterSession = await createSession(requester.id, "requester-session");
        const foreignBinding = { accountId: requester.id, machineId: machine.id, sessionId: requesterSession.id };
        await createSessionMachineAccessKeyInTx(db, {
            accountId: custodian.id, machineId: machine.id, sessionId: ownSession.id, data: "retained-owner-key",
        });
        // Persistence accepts the exact requester tuple; admission remains at
        // the canonical mutation owner, which refuses foreign use without C41 admission.
        await expect(db.accessKey.create({ data: { ...foreignBinding, data: "requester-key", dataVersion: 7 } }))
            .resolves.toMatchObject({ ...foreignBinding, dataVersion: 7 });
        await db.accessKey.create({ data: { ...foreignBinding, machineId: otherMachine.id, data: "other-key", dataVersion: 3 } });
        await expect(readSessionMachineAccessKeyInTx(db, foreignBinding)).resolves.toMatchObject({ data: "requester-key", dataVersion: 7 });
        await expect(createSessionMachineAccessKeyInTx(db, { ...foreignBinding, data: "replacement" }))
            .resolves.toEqual({ ok: false, reason: "binding-not-found" });
        await expect(updateSessionMachineAccessKeyDataInTx(db, { ...foreignBinding, data: "replacement", expectedVersion: 7 }))
            .resolves.toEqual({ ok: false, reason: "not-found" });
        await expect(db.accessKey.create({ data: { ...foreignBinding, data: "duplicate" } })).rejects.toMatchObject({ code: "P2002" });
        expect(await readMachineAccessKeySessionBindingsInTx(db, { accountId: custodian.id, machineId: machine.id }))
            .toEqual(expect.arrayContaining([
                { accountId: custodian.id, sessionId: ownSession.id },
                { accountId: requester.id, sessionId: requesterSession.id },
            ]));

        await expect(inTx((tx) => revokeMachineInTx(tx, { accountId: stranger.id, machineId: machine.id })))
            .resolves.toEqual({ ok: false, reason: "machine_not_found" });
        await expect(db.accessKey.count({ where: { machineId: machine.id } })).resolves.toBe(2);
        const disconnectedRooms: string[] = [];
        // Socket.IO transport is the boundary; tuple discovery and durable
        // Machine mutation stay real, including after-transaction delivery.
        eventRouter.setIo({ to: (rooms) => ({
            emit: () => undefined,
            disconnectSockets: () => disconnectedRooms.push(...(Array.isArray(rooms) ? rooms : [rooms])),
        }) });
        await expect(inTx((tx) => revokeMachineInTx(tx, { accountId: custodian.id, machineId: machine.id })))
            .resolves.toMatchObject({ ok: true, deletedAccessKeys: 2 });
        expect(disconnectedRooms).toEqual(expect.arrayContaining([
            `machine:${machine.id}:${custodian.id}`,
            `session:${ownSession.id}:machine:${machine.id}:${custodian.id}`,
            `session:${requesterSession.id}:machine:${machine.id}:${requester.id}`,
        ]));
        expect(disconnectedRooms).not.toContain(`session:${requesterSession.id}:${requester.id}`);
        await expect(db.accessKey.count({ where: { machineId: machine.id } })).resolves.toBe(0);
        await expect(readSessionMachineAccessKeyInTx(db, { ...foreignBinding, machineId: otherMachine.id }))
            .resolves.toMatchObject({ data: "other-key", dataVersion: 3 });
        await expect(db.session.count({ where: { id: { in: [ownSession.id, requesterSession.id] } } })).resolves.toBe(2);
    });

    it("includes requester Session admission in Machine replacement without erasing retained keys or history", async () => {
        const custodian = await createAccount("pk-access-key-replacement-custodian");
        const requester = await createAccount("pk-access-key-replacement-requester");
        const machine = await createMachine(custodian.id, "replaced-custodian-machine");
        const replacement = await createMachine(custodian.id, "replacement-custodian-machine");
        const session = await createSession(requester.id, "replacement-requester-session");
        const binding = { accountId: requester.id, machineId: machine.id, sessionId: session.id };
        await db.accessKey.create({ data: { ...binding, data: "retained-requester-key", dataVersion: 4 } });
        expect(await readMachineAccessKeySessionBindingsInTx(db, { accountId: custodian.id, machineId: machine.id }))
            .toEqual([{ accountId: requester.id, sessionId: session.id }]);
        const disconnectedRooms: string[] = [];
        eventRouter.setIo({ to: (rooms) => ({
            emit: () => undefined,
            disconnectSockets: () => disconnectedRooms.push(...(Array.isArray(rooms) ? rooms : [rooms])),
        }) });
        await inTx((tx) => applyMachineReplacement({
            tx, accountId: custodian.id, oldMachineId: machine.id, replacementMachineId: replacement.id,
            reason: "machine_rotation", source: "manual", actorUserId: custodian.id,
        }));
        await expect(readSessionMachineAccessKeyInTx(db, binding)).resolves.toMatchObject({ data: "retained-requester-key", dataVersion: 4 });
        await expect(db.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({ accountId: requester.id });
        await expect(db.machine.findUnique({ where: { id: machine.id } })).resolves.toMatchObject({ replacedByMachineId: replacement.id });
        expect(disconnectedRooms).toContain(`session:${session.id}:machine:${machine.id}:${requester.id}`);
    });

    it.each(["requester", "custodian"] as const)("erases the %s without deleting the other Account's Session or Machine", async (erased) => {
        const custodian = await createAccount(`pk-access-key-erase-custodian-${erased}`);
        const requester = await createAccount(`pk-access-key-erase-requester-${erased}`);
        const machine = await createMachine(custodian.id, `erase-custodian-machine-${erased}`);
        const requesterSession = await createSession(requester.id, `erase-requester-session-${erased}`);
        const otherCustodian = await createAccount(`pk-access-key-erase-other-custodian-${erased}`);
        const otherMachine = await createMachine(otherCustodian.id, `erase-other-machine-${erased}`);
        const otherSession = await createSession(requester.id, `erase-other-session-${erased}`);
        await db.accessKey.create({ data: {
            accountId: requester.id, machineId: machine.id, sessionId: requesterSession.id, data: "requester-key",
        } });
        await db.accessKey.create({ data: {
            accountId: requester.id, machineId: otherMachine.id, sessionId: otherSession.id, data: "other-key",
        } });
        const disconnectedRooms: string[] = [];
        eventRouter.setIo({ to: (rooms) => ({
            emit: () => undefined,
            disconnectSockets: () => disconnectedRooms.push(...(Array.isArray(rooms) ? rooms : [rooms])),
        }) });
        await expect(deleteAccountForErasure({ accountId: erased === "requester" ? requester.id : custodian.id }))
            .resolves.toEqual({ status: "deleted" });
        await expect(db.accessKey.count({ where: { machineId: machine.id } })).resolves.toBe(0);
        await expect(db.machine.findUnique({ where: { id: otherMachine.id } })).resolves.toMatchObject({ accountId: otherCustodian.id });
        if (erased === "requester") {
            await expect(db.accessKey.count()).resolves.toBe(0);
            await expect(db.machine.findUnique({ where: { id: machine.id } })).resolves.toMatchObject({ accountId: custodian.id });
            await expect(db.session.findUnique({ where: { id: requesterSession.id } })).resolves.toBeNull();
        } else {
            await expect(db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                accountId: requester.id, machineId: otherMachine.id, sessionId: otherSession.id,
            } } })).resolves.toMatchObject({ data: "other-key" });
            await expect(db.machine.findUnique({ where: { id: machine.id } })).resolves.toBeNull();
            await expect(db.session.findUnique({ where: { id: requesterSession.id } })).resolves.toMatchObject({ accountId: requester.id });
            expect(disconnectedRooms).toContain(`session:${requesterSession.id}:machine:${machine.id}:${requester.id}`);
            expect(disconnectedRooms).not.toContain(`session:${requesterSession.id}:${requester.id}`);
            expect(disconnectedRooms).not.toContain(`session:${otherSession.id}:machine:${otherMachine.id}:${requester.id}`);
        }
    });

    it("refuses to write a key for a revoked Machine", async () => {
        const owner = await createAccount("pk-access-key-revoked");
        const session = await createSession(owner.id, "revoked-machine-session");
        const machine = await createMachine(owner.id, "revoked-machine");
        await db.machine.update({
            where: { id: machine.id },
            data: { revokedAt: new Date() },
        });

        await expect(readSessionMachineBindingStateInTx(db, {
            accountId: owner.id,
            machineId: machine.id,
            sessionId: session.id,
        })).resolves.toBe("missing");
        await expect(createSessionMachineAccessKeyInTx(db, {
            accountId: owner.id,
            machineId: machine.id,
            sessionId: session.id,
            data: "key",
        })).resolves.toEqual({ ok: false, reason: "binding-not-found" });
        await expect(db.accessKey.count()).resolves.toBe(0);
    });

    it("creates the exact tuple once and reports a repeated create as existing", async () => {
        const owner = await createAccount("pk-access-key-create");
        const session = await createSession(owner.id, "create-session");
        const machine = await createMachine(owner.id, "create-machine");
        const binding = {
            accountId: owner.id,
            machineId: machine.id,
            sessionId: session.id,
        } as const;

        const created = await createSessionMachineAccessKeyInTx(db, { ...binding, data: "first" });
        expect(created).toMatchObject({ ok: true, created: true });
        if (!created.ok) return;
        expect(created.accessKey).toMatchObject({ data: "first", dataVersion: 1 });

        await expect(createSessionMachineAccessKeyInTx(db, { ...binding, data: "second" }))
            .resolves.toEqual({ ok: false, reason: "already-exists" });
        await expect(db.accessKey.findUniqueOrThrow({
            where: { accountId_machineId_sessionId: binding },
            select: { data: true, dataVersion: true },
        })).resolves.toEqual({ data: "first", dataVersion: 1 });
    });

    it("commits with freshly bound resources and rolls back when the caller aborts", async () => {
        const owner = await createAccount("pk-access-key-outer-transaction");
        const binding = {
            accountId: owner.id,
            sessionId: "transaction-session",
            machineId: "transaction-machine",
        };
        const createBoundResources = async (tx: Tx) => {
            await tx.session.create({ data: {
                id: binding.sessionId,
                accountId: owner.id,
                tag: "transaction-session",
                encryptionMode: "plain",
                metadata: "{}",
            } });
            await tx.machine.create({ data: {
                id: binding.machineId,
                accountId: owner.id,
                metadata: "{}",
            } });
            return createSessionMachineAccessKeyInTx(tx, { ...binding, data: "bound-key" });
        };

        const abort = new Error("caller aborted after AccessKey creation");
        await expect(inTx(async (tx) => {
            expect(await createBoundResources(tx)).toMatchObject({ ok: true, created: true });
            throw abort;
        })).rejects.toBe(abort);
        await expect(db.accessKey.count()).resolves.toBe(0);
        await expect(db.session.count()).resolves.toBe(0);
        await expect(db.machine.count()).resolves.toBe(0);

        await expect(inTx(createBoundResources)).resolves.toMatchObject({
            ok: true,
            created: true,
            accessKey: { data: "bound-key", dataVersion: 1 },
        });
        await expect(db.accessKey.findUniqueOrThrow({
            where: { accountId_machineId_sessionId: binding },
            select: { accountId: true, machineId: true, sessionId: true, data: true },
        })).resolves.toEqual({ ...binding, data: "bound-key" });
    });

    it("updates only on the expected version and reports the current row otherwise", async () => {
        const owner = await createAccount("pk-access-key-update");
        const session = await createSession(owner.id, "update-session");
        const machine = await createMachine(owner.id, "update-machine");
        const binding = {
            accountId: owner.id,
            machineId: machine.id,
            sessionId: session.id,
        } as const;
        await createSessionMachineAccessKeyInTx(db, { ...binding, data: "first" });

        await expect(updateSessionMachineAccessKeyDataInTx(db, {
            ...binding,
            data: "second",
            expectedVersion: 1,
        })).resolves.toEqual({ ok: true, version: 2 });

        await expect(updateSessionMachineAccessKeyDataInTx(db, {
            ...binding,
            data: "third",
            expectedVersion: 1,
        })).resolves.toEqual({
            ok: false,
            reason: "version-mismatch",
            currentVersion: 2,
            currentData: "second",
        });
    });

    it("reports a missing key when the bound Machine is no longer available", async () => {
        const owner = await createAccount("pk-access-key-update-revoked");
        const session = await createSession(owner.id, "update-revoked-session");
        const machine = await createMachine(owner.id, "update-revoked-machine");
        const binding = {
            accountId: owner.id,
            machineId: machine.id,
            sessionId: session.id,
        } as const;
        await createSessionMachineAccessKeyInTx(db, { ...binding, data: "first" });
        await db.machine.update({
            where: { id: machine.id },
            data: { revokedAt: new Date() },
        });

        await expect(updateSessionMachineAccessKeyDataInTx(db, {
            ...binding,
            data: "second",
            expectedVersion: 1,
        })).resolves.toEqual({ ok: false, reason: "not-found" });
    });
});
