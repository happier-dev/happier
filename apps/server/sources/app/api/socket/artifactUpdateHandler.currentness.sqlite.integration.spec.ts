import { randomUUID } from "node:crypto";

import type { Socket } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { artifactUpdateHandler } from "./artifactUpdateHandler";

/**
 * Sealed-looking bytes: the Account is e2ee, so the stored pair is opaque to the
 * Home and the handler hands it back verbatim. That is the disclosure under
 * test: an evicted connection must not return stored Artifact content.
 */
const sealed = (label: string) => new TextEncoder().encode(`sealed:${label}`);

/** A complete e2ee Account row: the write service requires current key material. */
function readyE2eeAccountData() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    return {
        encryptionMode: "e2ee",
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: new Uint8Array(signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey: content.publicKey,
        })),
    };
}

const establishedConnections: ClientConnection[] = [];

async function createEstablishedArtifactFixture(label: string) {
    const account = await db.account.create({
        data: readyE2eeAccountData(),
        select: { id: true },
    });
    const artifactId = `artifact-${label}-${randomUUID()}`;
    await db.artifact.create({
        data: {
            id: artifactId,
            accountId: account.id,
            header: sealed(`${label}-header`),
            body: sealed(`${label}-body`),
            dataEncryptionKey: sealed(`${label}-key`),
        },
    });
    const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

    const verified = await auth.verifyTokenForRoute(token);
    if (!verified) throw new Error("expected connect-time Account identity");
    const transport = createFakeSocket({
        data: {
            clientType: "user-scoped", userId: verified.userId,
            authTokenKind: verified.authTokenKind, authAuthority: verified.authority,
            tokenEpoch: verified.tokenEpoch,
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                outcome: "accepted",
                declaration: null,
                upgradeRequired: null,
            },
        },
    });
    const socket = Object.assign(transport, {
        disconnect: vi.fn(() => { transport.connected = false; }),
    });
    const connection: ClientConnection = {
        connectionType: "user-scoped", userId: account.id, socket: socket as unknown as Socket,
    };
    eventRouter.addConnection(account.id, connection);
    establishedConnections.push(connection);
    artifactUpdateHandler(account.id, socket as unknown as Socket);

    return { accountId: account.id, artifactId, socket };
}

type Fixture = Awaited<ReturnType<typeof createEstablishedArtifactFixture>>;

async function emit(fixture: Fixture, event: string, payload: unknown) {
    const callback = vi.fn();
    await getSocketHandler(fixture.socket, event)(payload, callback);
    return callback;
}

async function suspend(fixture: Fixture) {
    // Suspension closes this Account through the production connection owner.
    const applied = await inTx(async (tx) => await setAccountStatusInTx(tx, {
        actorAccountId: fixture.accountId,
        targetAccountId: fixture.accountId,
        status: "suspended",
        authority: "account_erasure",
    }));
    expect(applied).toEqual({ status: "applied" });
    expect(fixture.socket.disconnect).toHaveBeenCalledWith(true);
    expect(fixture.socket.connected).toBe(false);
}

describe("Artifact content disclosure on an established socket", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-artifact-currentness-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HANDY_MASTER_SECRET: "artifact-currentness-secret",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        for (const connection of establishedConnections.splice(0)) {
            eventRouter.removeConnection(connection.userId, connection);
        }
        vi.restoreAllMocks();
        harness.resetEnv({
            HANDY_MASTER_SECRET: "artifact-currentness-secret",
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
        });
        await db.artifact.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("closes the suspended Account socket and refuses queued artifact-read disclosure", async () => {
        const subject = await createEstablishedArtifactFixture("read");
        const control = await createEstablishedArtifactFixture("read-control");

        const admitted = await emit(subject, "artifact-read", { artifactId: subject.artifactId });
        expect(admitted).toHaveBeenCalledWith(expect.objectContaining({
            result: "success",
            artifact: expect.objectContaining({
                header: privacyKit.encodeBase64(sealed("read-header")),
                body: privacyKit.encodeBase64(sealed("read-body")),
            }),
        }));

        await suspend(subject);

        const refused = await emit(subject, "artifact-read", { artifactId: subject.artifactId });
        expect(refused).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(refused.mock.calls[0]?.[0]).not.toHaveProperty("artifact");
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);

        const unaffected = await emit(control, "artifact-read", { artifactId: control.artifactId });
        expect(unaffected).toHaveBeenCalledWith(expect.objectContaining({ result: "success" }));
        expect(control.socket.disconnect).not.toHaveBeenCalled();
    });

    it("refuses the artifact-update version-mismatch echo and disconnects", async () => {
        const subject = await createEstablishedArtifactFixture("update");

        await suspend(subject);

        // A stale expectedVersion is the branch that hands back the CURRENT
        // stored header and body, so it discloses exactly what artifact-read does.
        const refused = await emit(subject, "artifact-update", {
            artifactId: subject.artifactId,
            header: { data: privacyKit.encodeBase64(sealed("update-next")), expectedVersion: 7 },
        });
        expect(refused).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(refused.mock.calls[0]?.[0]).not.toHaveProperty("header");
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);
    });

    it("refuses the artifact-create existing-id echo and disconnects", async () => {
        const subject = await createEstablishedArtifactFixture("create");

        await suspend(subject);

        // Creating with an id this Account already owns returns the EXISTING
        // row's content with didWrite:false — a read wearing a create's name.
        const refused = await emit(subject, "artifact-create", {
            id: subject.artifactId,
            header: privacyKit.encodeBase64(sealed("create-other-header")),
            body: privacyKit.encodeBase64(sealed("create-other-body")),
            dataEncryptionKey: privacyKit.encodeBase64(sealed("create-key")),
        });
        expect(refused).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(refused.mock.calls[0]?.[0]).not.toHaveProperty("artifact");
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);
    });

    it("refuses a evicted socket before a successful artifact update", async () => {
        const subject = await createEstablishedArtifactFixture("update-write");

        await suspend(subject);

        const refused = await emit(subject, "artifact-update", {
            artifactId: subject.artifactId,
            header: { data: privacyKit.encodeBase64(sealed("update-write-next")), expectedVersion: 0 },
        });
        expect(refused).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);
        await expect(db.artifact.findUnique({ where: { id: subject.artifactId }, select: { headerVersion: true } }))
            .resolves.toMatchObject({ headerVersion: 0 });
    });

    it("refuses a evicted socket before a new artifact create", async () => {
        const subject = await createEstablishedArtifactFixture("create-write");
        const artifactId = `artifact-new-${randomUUID()}`;

        await suspend(subject);

        const refused = await emit(subject, "artifact-create", {
            id: artifactId,
            header: privacyKit.encodeBase64(sealed("create-write-header")),
            body: privacyKit.encodeBase64(sealed("create-write-body")),
            dataEncryptionKey: privacyKit.encodeBase64(sealed("create-write-key")),
        });
        expect(refused).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);
        await expect(db.artifact.findUnique({ where: { id: artifactId }, select: { id: true } })).resolves.toBeNull();
    });

    it("refuses a evicted socket before artifact deletion", async () => {
        const subject = await createEstablishedArtifactFixture("delete-write");

        await suspend(subject);

        const refused = await emit(subject, "artifact-delete", { artifactId: subject.artifactId });
        expect(refused).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);
        await expect(db.artifact.findUnique({ where: { id: subject.artifactId }, select: { id: true } }))
            .resolves.toMatchObject({ id: subject.artifactId });
    });
});
