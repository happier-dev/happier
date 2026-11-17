import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";
import tweetnacl from "tweetnacl";
import { decodeBase64 } from "privacy-kit";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from "@happier-dev/protocol";
import { encodeBase64 as encodeProtocolBase64 } from "@happier-dev/protocol/crypto/base64";
import { signMachineInstallationProof } from "@happier-dev/protocol/machines/identity/installationIdentity";

import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { stopLocalMachinePresenceTimeout } from "@/app/presence/timeout";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";

/** Resolves once post-connect admission either releases handlers (ping acks) or disconnects the socket. */
function waitForAdmissionOutcome(socket: ReturnType<typeof ioClient>): Promise<"handler_usable" | "disconnected"> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error("No admission outcome")); }, 10_000);
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off("disconnect", onDisconnect);
            socket.off("connect_error", onDisconnect);
            socket.off("connect", onConnect);
        };
        const onDisconnect = () => { cleanup(); resolve("disconnected"); };
        const onConnect = () => {
            void socket.timeout(5_000).emitWithAck("ping").then(() => { cleanup(); resolve("handler_usable"); }, () => {});
        };
        socket.on("disconnect", onDisconnect);
        socket.on("connect_error", onDisconnect);
        socket.on("connect", onConnect);
    });
}

// Machine-socket handlers trust the handshake admission because revoke, replacement and installation
// change disconnect the socket by push to its Machine room. A loss that commits after the handshake's
// last Machine check but before the room join cannot reach it; one read after the join closes that window.
describe("machine-scoped socket admission across the room-join window", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-socket-join-window-", initAuth: true, initEncrypt: true });
    }, 120_000);
    afterAll(async () => { await harness.close(); });
    beforeEach(() => { harness.resetEnv(); harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: undefined }); });
    afterEach(async () => {
        await stopLocalMachinePresenceTimeout();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    it.each([
        { revokeInWindow: false, appCredential: false }, { revokeInWindow: true, appCredential: false },
        { revokeInWindow: false, appCredential: true }, { revokeInWindow: true, appCredential: true },
    ])("confirms Machine admission after joining withdrawal rooms (revoked: $revokeInWindow, App credential: $appCredential)", async ({ revokeInWindow, appCredential }) => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const key = tweetnacl.sign.keyPair();
        const installationId = `installation-${account.id}`;
        const terminalAuthRequestId = `terminal-auth-${account.id}`;
        const machine = await db.machine.create({ data: {
            id: `join-window-${account.id}`, accountId: account.id, installationId,
            installationPublicKey: new Uint8Array(key.publicKey),
            ...(appCredential ? { terminalAuthRequestId } : {}),
            metadata: encodePlainMachineStoredContent({ host: "join-window" }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
        } });
        const token = appCredential
            ? await auth.createToken(account.id, { session: terminalAuthRequestId }, { kind: 'terminal', authority: 'account_automation' })
            : await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        let revoked = false;
        let handshakeChecked = false;
        // The handshake's last Machine check is the capability withdrawal read (inside its own transaction).
        // Commit the revoke on the next request outside a transaction, i.e. before the room join.
        const stopObserving = observeSqliteRequests({
            after: request => {
                const select = (request.args as { select?: Record<string, unknown> } | undefined)?.select;
                if (request.model === "Machine" && select?.operationProtocolCapabilities === true) handshakeChecked = true;
                const where = (request.args as { where?: Record<string, unknown> } | undefined)?.where;
                if (appCredential && request.model === 'Machine' && where?.terminalAuthRequestId === terminalAuthRequestId) handshakeChecked = true;
            },
            before: async request => {
                if (!revokeInWindow || revoked || !handshakeChecked || request.transactionId !== undefined) return;
                revoked = true;
                await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            },
        });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Missing socket listener");
        const socket = ioClient(`http://127.0.0.1:${address.port}`, { path: "/v1/updates", transports: ["websocket"],
            reconnection: false, autoConnect: false, auth: appCredential ? { token, clientType: 'user-scoped' } : { token, clientType: "machine-scoped", machineId: machine.id,
                runtimeId: "join-window-runtime", startupSource: "manual", serviceManaged: false,
                installationId, installationPublicKey: encodeProtocolBase64(key.publicKey, "base64url"),
                installationProof: signMachineInstallationProof({ payload: { version: 1, installationId,
                    machineId: machine.id, accountId: account.id }, privateKey: key.secretKey }) } });
        try {
            const outcome = waitForAdmissionOutcome(socket);
            socket.connect();
            expect(await outcome).toBe(revokeInWindow ? "disconnected" : "handler_usable");
            expect(revoked).toBe(revokeInWindow);
        } finally {
            stopObserving();
            socket.disconnect();
            await app.close();
        }
    });
});
