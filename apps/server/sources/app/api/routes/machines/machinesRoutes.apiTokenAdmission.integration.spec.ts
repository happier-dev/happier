import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";

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
                AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("returns PAT callers only the strict machine-selection bootstrap projection", async () => {
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
            label: "Machine discovery",
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
            }]);
        } finally {
            await app.close();
        }
    });
});
