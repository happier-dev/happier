import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinRelayAccessSelection } from "@happier-dev/cli-common/relayAccess";

import { auth } from "@/app/auth/auth";
import { createPerSendAuthEmailDelivery } from "@/app/auth/email/resolveAuthEmailDelivery";
import { readHomeConfigEnv } from "@/app/home/settings/homeSettings";
import { resetPublicServerUrlInferenceCacheForTests } from "@/app/integrations/publicUrl/publicServerUrlInference";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { homeGovernanceRoutes } from "./homeGovernanceRoutes";
import { registerHomeReachabilityRoutes } from "./homeReachabilityRoutes";
import { registerHomeSettingsRoutes } from "./homeSettingsRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

const REACH_ENV_KEYS = [
    "HAPPIER_PUBLIC_SERVER_URL",
    "HAPPIER_WEBAPP_URL",
    "HAPPIER_CANONICAL_SERVER_URL",
    "HAPPIER_HOME_DIR",
    "HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL",
    "HAPPIER_TAILSCALE_INFER_PUBLIC_URL",
    "HAPPIER_HOME_IROH_MODE",
] as const;

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    homeGovernanceRoutes(typed);
    registerHomeSettingsRoutes(typed, {
        authEmailDelivery: createPerSendAuthEmailDelivery({
            readEnv: () => readHomeConfigEnv({}),
            createSmtpTransport: () => ({ async send() {} }),
        }),
    });
    registerHomeReachabilityRoutes(typed);
    return trackApp(typed);
}

let harness: LightSqliteHarness;
let sequence = 0;
let homeDir: string;
const savedEnv: Partial<Record<(typeof REACH_ENV_KEYS)[number], string | undefined>> = {};

async function createAccount(homeRole: "owner" | "admin" | "member"): Promise<Readonly<{ token: string }>> {
    sequence += 1;
    const account = await db.account.create({
        data: { publicKey: `pk_home_reach_${sequence}`, encryptionMode: "plain", homeRole },
        select: { id: true },
    });
    const token = await auth.createToken(account.id, undefined, {
        kind: "account",
        authority: "present_user",
        authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
    });
    return { token };
}

async function post(app: ReturnType<typeof createTestApp>, url: string, token: string, payload: unknown) {
    return await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
}

async function configureRelayAccess(config: Record<string, unknown>): Promise<void> {
    await mkdir(join(homeDir, "relay", "access"), { recursive: true });
    await writeFile(join(homeDir, "relay", "access", "local.json"), JSON.stringify(config), "utf8");
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-reach-routes-",
        initAuth: true,
        initEncrypt: true,
        initFiles: true,
    });
    for (const key of REACH_ENV_KEYS) savedEnv[key] = process.env[key];
}, 120_000);
afterAll(async () => {
    for (const key of REACH_ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    await harness.close();
});
beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "happier-home-reach-"));
    for (const key of REACH_ENV_KEYS) delete process.env[key];
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_CANONICAL_SERVER_URL = "http://127.0.0.1:43123";
    process.env.HAPPIER_TAILSCALE_INFER_PUBLIC_URL = "0";
    resetPublicServerUrlInferenceCacheForTests();
});
afterEach(async () => {
    await closeTrackedApps();
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeSettings.deleteMany({});
    await db.account.deleteMany({});
    await rm(homeDir, { recursive: true, force: true });
});

describe("home.reachability routes", () => {
    it("resolves the public address env → stored → inferred → none, and a stored address beats an inferred one (I2)", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");

        const none = await post(app, "/v1/home/reachability/get", owner.token, {});
        expect(none.statusCode).toBe(200);
        expect(none.json()).toMatchObject({
            publicAddress: { url: null, source: "none" },
            webApp: { url: "https://cloud.happier.dev", source: "default" },
            hostAccess: null,
            iroh: { availability: "not_available", mode: "enabled", modeFixed: false },
        });

        const credentialAccountId = "tunnel-account-private-reference";
        await configureRelayAccess(createBuiltinRelayAccessSelection("cloudflareNamed", { hostname: "tunnel.home.test" }, [{
            purpose: "tunnel.manage", credentialRef: { kind: "connectedAccount", account: {
                service: { pluginId: "happier.deploy.cloudflare", localId: "cloudflare" }, accountId: credentialAccountId,
            } },
        }]));
        const unverified = await post(app, "/v1/home/reachability/get", owner.token, {});
        expect(unverified.json()).toMatchObject({
            publicAddress: { url: null, source: "none" },
            hostAccess: { method: "cloudflare_tunnel", exposure: "public", shareUrl: null },
        });
        expect(unverified.body).not.toContain(credentialAccountId);

        // A desired tunnel hostname is not verified reachability. A configured
        // LAN/custom URL is reported directly by its real access provider.
        await configureRelayAccess(createBuiltinRelayAccessSelection("lan", { url: "https://custom.home.test" }));
        const inferred = await post(app, "/v1/home/reachability/get", owner.token, {});
        expect(inferred.json()).toMatchObject({
            publicAddress: { url: "https://custom.home.test", source: "inferred", inferredFrom: "relay_access" },
            hostAccess: { method: "lan", exposure: "private", shareUrl: "https://custom.home.test" },
        });
        expect(inferred.body).not.toContain(credentialAccountId);
        // Inference is read-only: nothing was written to the environment or stored as a setting.
        expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBeUndefined();
        expect(await db.homeSettings.count()).toBe(0);

        const plain = await post(app, "/v1/home/settings/set", owner.token, {
            expectedRevision: 0,
            values: { HAPPIER_PUBLIC_SERVER_URL: "http://home.test" },
        });
        expect(plain.statusCode).toBe(400);
        expect(plain.json()).toEqual({ error: "home_settings_invalid", key: "HAPPIER_PUBLIC_SERVER_URL", reason: "out_of_bounds" });

        const stored = await post(app, "/v1/home/settings/set", owner.token, {
            expectedRevision: 0,
            values: { HAPPIER_PUBLIC_SERVER_URL: "https://home.test" },
        });
        expect(stored.statusCode).toBe(200);
        const home = await post(app, "/v1/home/reachability/get", owner.token, {});
        expect(home.json().publicAddress).toEqual({ url: "https://home.test", source: "home" });

        process.env.HAPPIER_PUBLIC_SERVER_URL = "https://ops.home.test";
        const deployment = await post(app, "/v1/home/reachability/get", owner.token, {});
        expect(deployment.json().publicAddress).toEqual({ url: "https://ops.home.test", source: "deployment" });
    });

    it("lets administrators read, keeps the Iroh switch owner-only, and refuses it where direct connections are not composed", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");

        expect((await post(app, "/v1/home/reachability/get", member.token, {})).statusCode).toBe(403);
        expect((await post(app, "/v1/home/reachability/get", admin.token, {})).statusCode).toBe(200);
        expect((await post(app, "/v1/home/reachability/iroh/set", admin.token, { mode: "disabled" })).statusCode).toBe(403);

        const unavailable = await post(app, "/v1/home/reachability/iroh/set", owner.token, { mode: "disabled" });
        expect(unavailable.statusCode).toBe(409);
        expect(unavailable.json()).toEqual({ error: "home_iroh_not_available" });

        // The mode is written only with its transition, never as a bare setting.
        const bare = await post(app, "/v1/home/settings/set", owner.token, {
            expectedRevision: 0,
            values: { HAPPIER_HOME_IROH_MODE: "disabled" },
        });
        expect(bare.statusCode).toBe(400);
        expect(bare.json()).toMatchObject({ key: "HAPPIER_HOME_IROH_MODE", reason: "not_home_editable" });
    });
});
