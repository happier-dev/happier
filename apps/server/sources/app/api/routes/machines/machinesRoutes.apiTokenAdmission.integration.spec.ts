import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import tweetnacl from "tweetnacl";
import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    signRunnerClaimV1,
} from "@happier-dev/protocol";
import { encodeBase64 } from "@happier-dev/protocol/crypto/base64";
import { signMachineInstallationProof } from "@happier-dev/protocol/machines/identity/installationIdentity";

import { machinesRoutes } from "./machinesRoutes";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    machinesRoutes(typed);
    return typed;
}

describe("machinesRoutes API-token admission (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-machine-pat-discovery-",
            initAuth: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        // An activation references both the Account and its Runner Machine, so
        // it retires before either of them.
        await db.ephemeralRunnerActivation.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("omits temporary computers from ordinary discovery but retains exact Account detail", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "e2ee" },
        });
        await db.machine.createMany({ data: [
            { id: "persistent", accountId: account.id, metadata: "encrypted" },
            { id: "temporary", accountId: account.id, metadata: "encrypted", kind: "ephemeral_session_runner" },
        ] });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = createTestApp();
        await app.ready();
        try {
            const headers = { authorization: `Bearer ${token}` };
            const list = await app.inject({ method: "GET", url: "/v1/machines", headers });
            expect(list.statusCode).toBe(200);
            expect(list.json()).toEqual([expect.objectContaining({ id: "persistent", kind: "persistent" })]);
            const exact = await app.inject({ method: "GET", url: "/v1/machines/temporary", headers });
            expect(exact.statusCode).toBe(200);
            expect(exact.json()).toMatchObject({ machine: { id: "temporary", kind: "ephemeral_session_runner" } });
        } finally {
            await app.close();
        }
    });

    it("returns scoped PAT callers only the strict machine-selection bootstrap projection", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: '{"t":"plain","v":{"host":"workstation"}}',
                daemonState: '{"t":"plain","v":{"status":"running"}}',
                dataEncryptionKey: new Uint8Array(
                    Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
                ),
                installationId: "installation-1",
                installationPublicKey: new Uint8Array([1, 2, 3]),
                contentPublicKeyFingerprint: "sensitive-fingerprint",
                replacedByMachineId: "machine-2",
                active: false,
                revokedAt: new Date(1234),
            },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Machine discovery",
            grant: {
                v: 1,
                actions: { families: [], ids: ["session.spawn_new"] },
                targets: { sessions: [], machines: ["machine-1"] },
                approve: false,
                origins: [],
                models: null,
                permissionModes: null,
                create: null,
            },
        });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "GET",
                url: "/v1/machines",
                headers: { authorization: `Bearer ${pat.token}` },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual([{
                id: "machine-1",
                active: false,
                revokedAt: 1234,
                replacedByMachineId: "machine-2",
                kind: "persistent",
                storageMode: "plain",
                // Only the canonical key marker accompanies routing facts;
                // Machine metadata, state and install details stay private.
                runnerClaim: null,
                installationId: null,
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                runnerContentKeyBinding: null,
            }]);
            const detail = await app.inject({
                method: "GET",
                url: "/v1/machines/machine-1",
                headers: { authorization: `Bearer ${pat.token}` },
            });
            expect(detail.statusCode).toBe(403);
            expect(detail.json()).toEqual({ error: "present_user_required" });
        } finally {
            await app.close();
        }
    });

    it("carries the Runner content-key facts a protected SDK request seals against", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "e2ee" },
            select: { id: true },
        });
        const sealedEnvelope = new Uint8Array(96).fill(7);
        const binding = {
            v: 1,
            purpose: "happier.ephemeral-runner.machine-content-key",
            homeServerIdentityId: "home-1",
            activationId: "00000000-0000-4000-8000-000000000001",
            creatorAccountId: account.id,
            machineId: "runner-1",
            installationId: "installation-1",
            machineContentKeyFingerprint:
                `runner-machine-content-key-sha256:${"a".repeat(64)}`,
            accountSignatureBase64Url: "A".repeat(86),
        };
        await db.machine.createMany({ data: [
            {
                id: "persistent-1",
                accountId: account.id,
                metadata: "encrypted",
                dataEncryptionKey: new Uint8Array(96).fill(3),
                installationId: "installation-persistent",
            },
            {
                id: "runner-1",
                accountId: account.id,
                metadata: "encrypted",
                kind: "ephemeral_session_runner",
                dataEncryptionKey: sealedEnvelope,
                installationId: "installation-1",
                runnerContentKeyBinding: binding,
            },
        ] });
        // The Runner was activated for exactly one Session, and a
        // Session-targeted protected request must select the same content key
        // a Machine-targeted one does. The correspondence crosses this seam as
        // the activation's persisted, activation-signed claim, never as a bare
        // Session id the Home could author.
        const activationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
        const installationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
        const activationSigningPublicKey = encodeBase64(activationSigning.publicKey, "base64url");
        const artifact = { product: "happier-runner", version: "0.3.0", target: "linux-x64", sha256: "c".repeat(64) } as const;
        const claim = signRunnerClaimV1({
            activationSecretKey: activationSigning.secretKey,
            payload: {
                v: 1,
                purpose: "happier.ephemeral-session-runner.claim",
                binding: {
                    activationId: "00000000-0000-4000-8000-000000000001",
                    homeServerIdentityId: "srv_home_1",
                    creatorAccountId: account.id,
                    creatorTokenEpoch: 0,
                    activationExpiresAt: null,
                    workspace: { kind: "choose_on_endpoint" },
                    sessionId: "session-runner-1",
                    machineId: "runner-1",
                    activationSigningPublicKey,
                    authoringCommitment: encodeBase64(new Uint8Array(32).fill(4), "base64url"),
                    artifact,
                    endpointFactsRecipient: { mode: "plain", creatorAccountId: account.id },
                },
                runnerBoxPublicKey: encodeBase64(
                    tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)).publicKey,
                    "base64url",
                ),
                installation: {
                    installationId: "installation-1",
                    publicKey: encodeBase64(installationSigning.publicKey, "base64url"),
                    proof: signMachineInstallationProof({
                        payload: { version: 1, installationId: "installation-1", machineId: "runner-1", accountId: account.id },
                        privateKey: installationSigning.secretKey,
                    }),
                },
                protocolEpoch: 1,
            },
        });
        await db.ephemeralRunnerActivation.create({
            data: {
                id: "00000000-0000-4000-8000-000000000001",
                creatorAccountId: account.id,
                creatorTokenEpoch: 0,
                draftId: "runner-draft-1",
                sessionId: "session-runner-1",
                machineId: "runner-1",
                state: "materialized",
                workspacePolicy: "choose_on_endpoint",
                activationExpiresAt: null,
                homeServerIdentityId: "srv_home_1",
                activationSigningPublicKey,
                authoringCommitment: encodeBase64(new Uint8Array(32).fill(4), "base64url"),
                artifact,
                endpointFactsRecipient: { mode: "plain", creatorAccountId: account.id },
                claim,
            },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Runner discovery",
        });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "GET",
                url: "/v1/machines",
                headers: { authorization: `Bearer ${pat.token}` },
            });

            expect(response.statusCode).toBe(200);
            const rows = response.json() as ReadonlyArray<Record<string, unknown>>;
            expect(rows.map((row) => row.id).sort()).toEqual(["persistent-1", "runner-1"]);
            expect(rows.find((row) => row.id === "runner-1")).toEqual({
                id: "runner-1",
                active: true,
                revokedAt: null,
                replacedByMachineId: null,
                kind: "ephemeral_session_runner",
                storageMode: "e2ee",
                runnerClaim: claim,
                installationId: "installation-1",
                dataEncryptionKey: Buffer.from(sealedEnvelope).toString("base64"),
                runnerContentKeyBinding: binding,
            });
            expect(rows.find((row) => row.id === "persistent-1")).toMatchObject({
                kind: "persistent",
                runnerClaim: null,
                installationId: null,
                storageMode: "e2ee",
                dataEncryptionKey: Buffer.from(new Uint8Array(96).fill(3)).toString("base64"),
                runnerContentKeyBinding: null,
            });
        } finally {
            await app.close();
        }
    });

    it("projects the placement-origin capability from the Machine list only to V4 readers", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "e2ee" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "encrypted-metadata",
                dataEncryptionKey: new Uint8Array(32).fill(1),
                operationProtocolCapabilities: {
                    sessionSpawn: { protocolVersions: [1] },
                    sessionSpawnPlacementOrigin: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const token = await auth.createToken(
            account.id,
            undefined,
            { kind: "account", authority: "present_user" },
        );
        const app = createTestApp();
        await app.ready();

        try {
            const readMachines = async (protocolVersion: 3 | 4) => app.inject({
                method: "GET",
                url: "/v1/machines",
                headers: {
                    authorization: `Bearer ${token}`,
                    [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: String(protocolVersion),
                },
            });
            const preV4 = await readMachines(3);
            const v4 = await readMachines(4);

            expect(preV4.statusCode).toBe(200);
            expect(preV4.json()[0].operationProtocolCapabilities).toEqual({
                sessionSpawn: { protocolVersions: [1] },
            });
            expect(v4.statusCode).toBe(200);
            expect(v4.json()[0].operationProtocolCapabilities).toEqual({
                sessionSpawn: { protocolVersions: [1] },
                sessionSpawnPlacementOrigin: { protocolVersions: [1] },
            });
        } finally {
            await app.close();
        }
    });
});
