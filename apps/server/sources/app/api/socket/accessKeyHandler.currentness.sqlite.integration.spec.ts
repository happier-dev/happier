import { randomUUID } from "node:crypto";

import type { Socket } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import * as prisma from "@/storage/prisma";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { accessKeyHandler } from "./accessKeyHandler";

const establishedConnections: ClientConnection[] = [];

async function createEstablishedAccountFixture(label: string) {
    const account = await db.account.create({
        data: { publicKey: `pk-${label}-${randomUUID()}` },
        select: { id: true },
    });
    const session = await db.session.create({
        data: { accountId: account.id, tag: `tag-${label}-${randomUUID()}`, metadata: "{}" },
        select: { id: true },
    });
    const machine = await db.machine.create({
        data: { id: `machine-${label}-${randomUUID()}`, accountId: account.id, metadata: "{}" },
        select: { id: true },
    });
    await db.accessKey.create({
        data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: "encrypted-envelope" },
    });
    const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

    const verified = await auth.verifyTokenForRoute(token);
    if (!verified) throw new Error("expected connect-time Account identity");
    const transport = createFakeSocket({ data: {
        clientType: "user-scoped", userId: verified.userId,
        authTokenKind: verified.authTokenKind, authAuthority: verified.authority,
        tokenEpoch: verified.tokenEpoch,
    } });
    const socket = Object.assign(transport, {
        disconnect: vi.fn(() => { transport.connected = false; }),
    });
    const connection: ClientConnection = {
        connectionType: "user-scoped",
        socket: socket as unknown as Socket,
        userId: account.id,
    };
    eventRouter.addConnection(account.id, connection);
    establishedConnections.push(connection);
    accessKeyHandler(account.id, socket as unknown as Socket, connection);

    return { accountId: account.id, sessionId: session.id, machineId: machine.id, socket };
}

async function readAccessKey(fixture: Awaited<ReturnType<typeof createEstablishedAccountFixture>>) {
    const callback = vi.fn();
    await getSocketHandler(fixture.socket, "access-key-get")(
        { sessionId: fixture.sessionId, machineId: fixture.machineId },
        callback,
    );
    return callback;
}

describe("access-key-get currentness on an established socket", () => {
    let harness: LightSqliteHarness;
    let restoreTransaction: (() => void) | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-access-key-currentness-",
            initAuth: true,
            env: {
                HANDY_MASTER_SECRET: "access-key-currentness-secret",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        restoreTransaction?.();
        for (const connection of establishedConnections.splice(0)) {
            eventRouter.removeConnection(connection.userId, connection);
        }
        vi.restoreAllMocks();
        harness.resetEnv({
            HANDY_MASTER_SECRET: "access-key-currentness-secret",
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
        });
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("closes the suspended Account socket through eviction and refuses queued access-key reads", async () => {
        const subject = await createEstablishedAccountFixture("subject");
        const control = await createEstablishedAccountFixture("control");

        const admitted = await readAccessKey(subject);
        expect(admitted).toHaveBeenCalledWith(
            expect.objectContaining({ ok: true, accessKey: expect.objectContaining({ data: "encrypted-envelope" }) }),
        );

        // Account lifecycle publishes through the real connection eviction owner.
        const applied = await inTx(async (tx) => await setAccountStatusInTx(tx, {
            actorAccountId: subject.accountId,
            targetAccountId: subject.accountId,
            status: "suspended",
            authority: "account_erasure",
        }));
        expect(applied).toEqual({ status: "applied" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);
        expect(subject.socket.connected).toBe(false);

        const refused = await readAccessKey(subject);
        expect(refused).toHaveBeenCalledWith({ ok: false, error: "Forbidden" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);

        const unaffected = await readAccessKey(control);
        expect(unaffected).toHaveBeenCalledWith(
            expect.objectContaining({ ok: true, accessKey: expect.objectContaining({ data: "encrypted-envelope" }) }),
        );
        expect(control.socket.disconnect).not.toHaveBeenCalled();
    });

    it("refuses disclosure when eviction closes the socket while an envelope read is in flight", async () => {
        const subject = await createEstablishedAccountFixture("inflight");

        // The database is a genuine boundary, so the read is held open there.
        // Eviction closes the admitted connection before stored material returns.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let markReadComplete: () => void = () => {};
        const readComplete = new Promise<void>(resolve => { markReadComplete = resolve; });
        const realSnapshot = prisma.withSqliteReadSnapshot;
        // The owner reads admission and ciphertext in one read-only snapshot.
        // Hold its DB-boundary result after commit, without stubbing its logic
        // or keeping a SQLite writer lock across the Account transition.
        const snapshot = vi.spyOn(prisma, 'withSqliteReadSnapshot').mockImplementation(async (operation, options) => {
            restoreTransaction?.();
            const row = await realSnapshot(operation, options);
            markReadComplete();
            await gate;
            return row;
        });
        restoreTransaction = () => {
            snapshot.mockRestore();
            restoreTransaction = undefined;
        };

        const callback = vi.fn();
        const pending = getSocketHandler(subject.socket, "access-key-get")(
            { sessionId: subject.sessionId, machineId: subject.machineId },
            callback,
        );
        await readComplete;

        try {
            const applied = await inTx(async (tx) => await setAccountStatusInTx(tx, {
                actorAccountId: subject.accountId,
                targetAccountId: subject.accountId,
                status: "suspended",
                authority: "account_erasure",
            }));
            expect(applied).toEqual({ status: "applied" });
            expect(subject.socket.disconnect).toHaveBeenCalledWith(true);
            expect(subject.socket.connected).toBe(false);
        } finally {
            release();
        }
        await pending;
        expect(callback).toHaveBeenCalledWith({ ok: false, error: "Forbidden" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);
    });
});
