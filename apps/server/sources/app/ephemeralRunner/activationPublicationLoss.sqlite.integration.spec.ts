import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
    serializerCompiler,
    validatorCompiler,
    type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { encodeBase64 } from "@happier-dev/protocol";
import { EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1 } from "@happier-dev/protocol/ephemeralRunner/routes";

import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import { auth } from "@/app/auth/auth";
import { registerEphemeralRunnerRoutes } from "@/app/ephemeralRunner/routes";
import { runnerArtifactPublicationSnapshots } from "@/app/ephemeralRunner/runnerArtifactAvailability";
import { db } from "@/storage/db";
import { logger } from "@/utils/logging/log";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

describe("ephemeral Runner activation recovery after publication loss", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-runner-publication-loss-",
            initAuth: true,
            env: {
                HANDY_MASTER_SECRET: "runner-publication-loss-secret",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        await harness.resetDbTables([
            () => db.ephemeralRunnerActivation.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        await harness.close();
    });

    it.each([
        ["dev", "runner-dev"],
        ["preview", "runner-preview"],
    ] as const)("reads the Home %s release ring through the registered artifact route", async (channel, expectedTag) => {
        const account = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `runner-release-ring-${channel}-${randomUUID()}` },
        });
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        const requests: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input) => {
            requests.push(String(input));
            return new Response("", { status: 404 });
        }));

        const app = Fastify({ logger: false });
        app.register(rateLimit, { global: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();
        enableAuthentication(typed);
        enableErrorHandlers(typed);
        registerEphemeralRunnerRoutes(typed, {
            ...process.env,
            HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED: "1",
            HAPPIER_PUBLIC_RELEASE_CHANNEL: channel,
        });
        await app.ready();
        try {
            const response = await app.inject({
                method: "GET",
                url: EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1,
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "available", artifacts: [] });
            expect(requests.length).toBeGreaterThan(0);
            expect(new Set(requests)).toEqual(new Set([
                `https://api.github.com/repos/happier-dev/happier/releases/tags/${expectedTag}`,
            ]));
        } finally {
            await app.close();
        }
    });

    it("keeps an observed activation inspectable, cancelable, and its exact artifact recoverable while current publication is unavailable", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `runner-publication-loss-${randomUUID()}` },
        });
        const activationId = randomUUID();
        const draftId = randomUUID();
        await db.ephemeralRunnerActivation.create({
            data: {
                id: activationId,
                creatorAccountId: account.id,
                creatorTokenEpoch: account.tokenEpoch,
                draftId,
                sessionId: randomUUID(),
                machineId: randomUUID(),
                state: "pending",
                workspacePolicy: "choose_on_endpoint",
                activationExpiresAt: null,
                homeServerIdentityId: "srv_runner_publication_loss",
                activationSigningPublicKey: encodeBase64(new Uint8Array(32).fill(1), "base64url"),
                authoringCommitment: encodeBase64(new Uint8Array(32).fill(2), "base64url"),
                artifact: {
                    product: "happier-runner",
                    version: "0.3.0",
                    target: "linux-x64",
                    sha256: "a".repeat(64),
                },
                endpointFactsRecipient: { mode: "plain", creatorAccountId: account.id },
            },
        });
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("publication offline");
        }));

        const app = Fastify({ logger: false });
        app.register(rateLimit, { global: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();
        enableAuthentication(typed);
        enableErrorHandlers(typed);
        registerEphemeralRunnerRoutes(typed, {
            ...process.env,
            HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED: "1",
        });
        await app.ready();

        const headers = { authorization: `Bearer ${token}` };
        const activationUrl = `/v1/ephemeral-runners/activations/${activationId}`;
        // Pino is the output boundary; the route and log level dispatch stay real.
        const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
        try {
            const publication = await app.inject({
                method: "GET",
                url: EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1,
                headers,
            });
            expect(publication.statusCode).toBe(503);
            expect(publication.json()).toEqual({ error: "runner_artifact_publication_unavailable" });
            expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
                module: "ephemeral-runner",
                level: "error",
                errorCode: "runner_artifact_publication_unavailable",
            }), expect.any(String));

            const repository = (process.env.HAPPIER_GITHUB_REPO ?? "happier-dev/happier").trim();
            runnerArtifactPublicationSnapshots.write(`${repository}\u0000stable\u00000.3.0`, [{
                identity: {
                    product: "happier-runner",
                    version: "0.3.0",
                    target: "linux-x64",
                    sha256: "a".repeat(64),
                },
                channel: "stable",
                url: "https://github.com/happier-dev/happier/releases/download/runner-v0.3.0/happier-runner-v0.3.0-linux-x64.zip",
                checksumsUrl: "https://github.com/happier-dev/happier/releases/download/runner-v0.3.0/checksums-happier-runner-v0.3.0.txt",
                checksumsSignatureUrl: "https://github.com/happier-dev/happier/releases/download/runner-v0.3.0/checksums-happier-runner-v0.3.0.txt.minisig",
                sizeBytes: 321,
                entries: [{ path: "happier-runner", kind: "file", sizeBytes: 300, mode: 0o755 }],
            }]);
            const exactPublication = await app.inject({
                method: "GET",
                url: `${EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1}?version=0.3.0`,
                headers,
            });
            expect(exactPublication.statusCode).toBe(200);
            expect(exactPublication.json()).toMatchObject({
                artifacts: [{ identity: { version: "0.3.0", sha256: "a".repeat(64) } }],
            });

            await expect(app.inject({ method: "GET", url: activationUrl, headers }))
                .resolves.toMatchObject({ statusCode: 200 });
            await expect(app.inject({
                method: "GET",
                url: `/v1/ephemeral-runners/activations?draftId=${draftId}`,
                headers,
            })).resolves.toMatchObject({ statusCode: 200 });

            const canceled = await app.inject({ method: "DELETE", url: activationUrl, headers });
            expect(canceled.statusCode).toBe(200);
            expect(canceled.json()).toMatchObject({
                activationId,
                state: "closed",
                closeReason: "canceled",
            });
        } finally {
            await app.close();
        }
    });
});
