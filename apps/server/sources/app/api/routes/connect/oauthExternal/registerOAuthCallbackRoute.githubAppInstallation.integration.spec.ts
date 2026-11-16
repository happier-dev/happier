import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

const transport = vi.hoisted(() => ({
    fetch: vi.fn(),
    close: vi.fn(async () => undefined),
}));
const github = vi.hoisted(() => ({
    appRequest: vi.fn(),
    installationRequest: vi.fn(),
}));

vi.mock("@/app/net/outboundIdentityFetch", () => ({
    createOutboundIdentityFetch: vi.fn(() => transport),
}));
vi.mock("octokit", () => ({
    App: vi.fn(() => ({ octokit: { request: github.appRequest } })),
    Octokit: Object.assign(vi.fn(() => ({ request: github.installationRequest })), {
        defaults: vi.fn(() => vi.fn(() => ({ request: github.installationRequest }))),
    }),
}));

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    beginGitHubAppInstallationVerification,
    createHomeGitHubAppRegistration,
} from "@/app/integrations/github/githubManagedAppLifecycle";
import { registerOAuthCallbackRoute } from "./registerOAuthCallbackRoute";
import { createExternalAuthorizeUrl } from "./createExternalAuthorizeUrl";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { beginGitHubAppManifestSetup } from "@/app/integrations/github/githubManagedAppManifest";
import { registerManagedGitHubAppRoutes } from "@/app/integrations/github/githubManagedAppRoutes";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";

const ACCEPTED_EMAIL_PASSWORD = { kind: "home_method" as const, methodId: "email_password" };
const HOME_OFFERS_EMAIL_PASSWORD = {
    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
};

describe("OAuth callback GitHub App installation verification", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-github-app-install-oauth-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    beforeEach(() => {
        transport.fetch.mockReset();
        transport.close.mockClear();
        github.appRequest.mockImplementation(async (route: string) => ({
            data: route.startsWith("POST ")
                ? { token: "installation-token" }
                : {
                    id: 301,
                    app_id: 44,
                    account: { id: 401, login: "Acme", type: "Organization" },
                    repository_selection: "selected",
                    permissions: { members: "read" },
                    events: [],
                    suspended_at: null,
                },
        }));
        github.installationRequest.mockResolvedValue({
            data: { state: "active", role: "admin", user: { id: 501 } },
        });
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.repeatKey.deleteMany();
        // Verifying an installation also materializes its managed identity provider, and that
        // reference is `onDelete: Restrict` so the installation stays immutable while consumed.
        // Tear down in dependency order rather than weakening the constraint.
        await db.identityProviderInstance.deleteMany();
        await db.gitHubAppInstallation.deleteMany();
        await db.gitHubAppRegistration.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.accountPasswordCredential.deleteMany();
        await db.teamMembership.deleteMany();
        await db.team.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    it("uses the ephemeral user profile to authenticate and persist the exact installation", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });
        const account = await db.account.create({
            data: { publicKey: "github-app-admin", homeRole: "owner", status: "active" },
            select: { id: true },
        });
        const created = await createHomeGitHubAppRegistration({
            actorAccountId: account.id,
            input: {
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.client",
                secrets: { v: 1, clientSecret: "client-secret", privateKey: "private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected registration");
        const started = await beginGitHubAppInstallationVerification({
            actorAccountId: account.id,
            owner: { kind: "home" },
            registrationId: created.registration.id,
            expectedRegistrationRevision: created.registration.revision,
            expectedInstallationRevision: 0,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
            env: process.env,
        });
        if (started.status !== "ready") throw new Error(`unexpected start: ${started.status}`);

        transport.fetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "ephemeral-user-token" }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: 501, login: "github-admin-1" }), { status: 200 }));
        const authorize = new URL(started.authorizeUrl);
        const state = authorize.searchParams.get("state");
        expect(state).toBeTruthy();

        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        registerOAuthCallbackRoute(app.withTypeProvider<ZodTypeProvider>());
        const response = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?state=${encodeURIComponent(state!)}&code=one-time-code`,
        });
        await app.close();

        expect(response.statusCode).toBe(302);
        const redirect = new URL(response.headers.location as string);
        expect(redirect.searchParams.get("verified")).toBe("1");
        expect(redirect.searchParams.get("error")).toBeNull();
        expect(await db.gitHubAppInstallation.findFirst({
            where: { registrationId: created.registration.id },
            select: { githubInstallationId: true, githubOrganizationId: true, state: true },
        })).toEqual({ githubInstallationId: 301n, githubOrganizationId: 401n, state: "verified" });
        expect(transport.close).toHaveBeenCalled();
    });

    it("consumes a GitHub.com manifest code once and immediately stores one encrypted registration", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });
        const account = await db.account.create({
            data: { publicKey: "github-manifest-admin", homeRole: "owner", status: "active" },
            select: { id: true },
        });
        const started = await beginGitHubAppManifestSetup({
            actorAccountId: account.id,
            owner: { kind: "home" },
            appName: 'Happier "><script>alert(1)</script>',
            githubOwner: { kind: "organization", login: "acme" },
            env: process.env,
        });
        if (started.status !== "ready") throw new Error(`unexpected start: ${started.status}`);
        expect(new URL(started.authorizeUrl).origin).toBe("https://home.example.test");
        transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
            id: 77,
            slug: "happier-home",
            client_id: "Iv1.manifest",
            client_secret: "manifest-client-secret",
            webhook_secret: "manifest-webhook-secret",
            pem: "manifest-private-key",
            owner: { id: 88, login: "acme" },
        }), { status: 201 }));
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async () => undefined);
        registerManagedGitHubAppRoutes(app.withTypeProvider<ZodTypeProvider>() as never);
        registerOAuthCallbackRoute(app.withTypeProvider<ZodTypeProvider>());
        const launchTarget = new URL(started.authorizeUrl);
        const launchPath = `${launchTarget.pathname}${launchTarget.search}`;
        const launch = await app.inject({ method: "GET", url: launchPath });
        const launchReplay = await app.inject({ method: "GET", url: launchPath });
        expect(launch.statusCode).toBe(200);
        expect(launch.headers["content-security-policy"]).toContain("form-action https://github.com");
        expect(launch.body).toContain('action="https://github.com/organizations/acme/settings/apps/new?state=');
        expect(launch.body).toContain('name="manifest"');
        expect(launch.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(launch.body).not.toContain("<script>alert(1)</script>");
        expect(launchReplay.statusCode).toBe(410);
        const action = launch.body.match(/action="([^"]+)"/)?.[1]?.replace(/&amp;/gu, "&");
        const state = action ? new URL(action).searchParams.get("state") : null;
        expect(state).toBeTruthy();
        const first = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?state=${encodeURIComponent(state!)}&code=manifest-code`,
        });
        const replay = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?state=${encodeURIComponent(state!)}&code=manifest-code`,
        });
        github.appRequest.mockImplementation(async (route: string) => ({
            data: route.startsWith("POST ")
                ? { token: "installation-token" }
                : {
                    id: 301,
                    app_id: 77,
                    account: { id: 401, login: "Acme", type: "Organization" },
                    repository_selection: "selected",
                    permissions: { members: "read" },
                    events: [],
                    suspended_at: null,
                },
        }));
        const setup = await app.inject({
            method: "GET",
            url: `/v1/identity/github-apps/manifest-setup/complete?state=${encodeURIComponent(state!)}&installation_id=301&setup_action=install`,
        });
        const setupReplay = await app.inject({
            method: "GET",
            url: `/v1/identity/github-apps/manifest-setup/complete?state=${encodeURIComponent(state!)}&installation_id=301&setup_action=install`,
        });
        await app.close();

        expect(new URL(first.headers.location as string).searchParams.get("created")).toBe("1");
        expect(new URL(replay.headers.location as string).searchParams.get("error")).toBe("invalid_state");
        expect(setup.statusCode).toBe(302);
        expect(new URL(setup.headers.location as string).origin).toBe("https://github.com");
        expect(setupReplay.statusCode).toBe(409);
        expect(setupReplay.json()).toEqual({ error: "invalid_state" });
        expect(transport.fetch).toHaveBeenCalledTimes(1);
        const registration = await db.gitHubAppRegistration.findUniqueOrThrow({
            where: { githubHost_githubAppId: { githubHost: "https://github.com", githubAppId: 77n } },
            select: { encryptedSecrets: true, githubClientId: true, githubAppSlug: true },
        });
        expect(registration).toMatchObject({ githubClientId: "Iv1.manifest", githubAppSlug: "happier-home" });
        const ciphertext = Buffer.from(registration.encryptedSecrets).toString("utf8");
        expect(ciphertext).not.toContain("manifest-client-secret");
        expect(ciphertext).not.toContain("manifest-private-key");
        expect(ciphertext).not.toContain("manifest-webhook-secret");
    });
    // The GitHub return is a browser redirect with no Happier credential. A
    // restricted Team's App must still be finishable by the administrator who
    // started it, and must stop the moment that Team stops accepting their
    // credential — so the finalizer re-decides from the facts the server
    // stamped on the initiating request, never from a stored "yes".
    it("carries the initiating request's credential facts through the manifest round trip and re-decides at the end", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_WEBAPP_URL: "https://app.example.test",
            ...HOME_OFFERS_EMAIL_PASSWORD,
        });
        const account = await db.account.create({
            data: { publicKey: "github-manifest-team-admin", homeRole: "member", status: "active" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "email",
                providerUserId: "team-admin@example.test",
                profile: {},
            },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: account.id,
                credential: {
                    v: 1,
                    kind: "plain_password_hash",
                    hash: await hashPasswordMaterial(new TextEncoder().encode("team admin factor")),
                },
            },
        });
        const team = await db.team.create({
            data: {
                name: "Restricted App owner",
                authenticationPolicy: { v: 1, mode: "restricted", accepted: [ACCEPTED_EMAIL_PASSWORD] },
            },
            select: { id: true },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: "owner" } });
        const owner = { kind: "team" as const, teamId: team.id };

        const started = await beginGitHubAppManifestSetup({
            actorAccountId: account.id,
            owner,
            authenticationAuthority: "present_user",
            authenticationEvidence: [ACCEPTED_EMAIL_PASSWORD],
            appName: "Happier Team",
            githubOwner: { kind: "organization", login: "acme" },
            env: process.env,
        });
        if (started.status !== "ready") throw new Error(`unexpected start: ${started.status}`);
        transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
            id: 78,
            slug: "happier-team",
            client_id: "Iv1.team-manifest",
            client_secret: "team-manifest-client-secret",
            // GitHub always returns this field and sends null when the manifest
            // configures no webhook, which is what Happier's manifest does.
            webhook_secret: null,
            pem: "team-manifest-private-key",
            owner: { id: 89, login: "acme" },
        }), { status: 201 }));
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async () => undefined);
        registerManagedGitHubAppRoutes(app.withTypeProvider<ZodTypeProvider>() as never);
        registerOAuthCallbackRoute(app.withTypeProvider<ZodTypeProvider>());
        const launchTarget = new URL(started.authorizeUrl);
        const launch = await app.inject({
            method: "GET",
            url: `${launchTarget.pathname}${launchTarget.search}`,
        });
        const action = launch.body.match(/action="([^"]+)"/u)?.[1]?.replace(/&amp;/gu, "&");
        const state = action ? new URL(action).searchParams.get("state") : null;
        expect(state).toBeTruthy();

        const created = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?state=${encodeURIComponent(state!)}&code=team-manifest-code`,
        });
        const createdRedirect = new URL(created.headers.location as string);
        expect(createdRedirect.searchParams.get("error")).toBeNull();
        expect(createdRedirect.searchParams.get("created")).toBe("1");

        // The Team now accepts a credential this administrator does not hold.
        // The installation continuation must refuse rather than replay the
        // authorization the attempt was started with.
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        github.appRequest.mockImplementation(async (route: string) => ({
            data: route.startsWith("POST ")
                ? { token: "installation-token" }
                : {
                    id: 302,
                    app_id: 78,
                    account: { id: 402, login: "Acme", type: "Organization" },
                    repository_selection: "selected",
                    permissions: { members: "read" },
                    events: [],
                    suspended_at: null,
                },
        }));
        const refused = await app.inject({
            method: "GET",
            url: `/v1/identity/github-apps/manifest-setup/complete?state=${encodeURIComponent(state!)}&installation_id=302&setup_action=install`,
        });
        await app.close();

        expect(refused.statusCode).toBe(403);
        // The persisted facts no longer satisfy the Team's accepted method, and
        // that is recoverable: the finalizer says so instead of collapsing the
        // outcome into a generic refusal the person cannot act on.
        expect(refused.json()).toEqual({ error: "team_authentication_required" });
        await expect(db.gitHubAppRegistration.count({ where: { ownerTeamId: team.id } })).resolves.toBe(1);
        await expect(db.gitHubAppInstallation.count()).resolves.toBe(0);
    });
    it("keeps no managed-GitHub user token in the sign-in continuation it persists", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });
        const account = await db.account.create({
            data: { publicKey: "github-app-owner", homeRole: "owner", status: "active" },
            select: { id: true },
        });
        const created = await createHomeGitHubAppRegistration({
            actorAccountId: account.id,
            input: {
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.client",
                secrets: { v: 1, clientSecret: "client-secret", privateKey: "private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected registration");
        const started = await beginGitHubAppInstallationVerification({
            actorAccountId: account.id,
            owner: { kind: "home" },
            registrationId: created.registration.id,
            expectedRegistrationRevision: created.registration.revision,
            expectedInstallationRevision: 0,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
            env: process.env,
        });
        if (started.status !== "ready") throw new Error(`unexpected start: ${started.status}`);
        transport.fetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "ephemeral-user-token" }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: 501, login: "github-admin-1" }), { status: 200 }));
        const verifyApp = Fastify({ logger: false });
        verifyApp.setValidatorCompiler(validatorCompiler);
        verifyApp.setSerializerCompiler(serializerCompiler);
        registerOAuthCallbackRoute(verifyApp.withTypeProvider<ZodTypeProvider>());
        const verified = await verifyApp.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?state=${encodeURIComponent(
                new URL(started.authorizeUrl).searchParams.get("state")!,
            )}&code=one-time-code`,
        });
        await verifyApp.close();
        expect(verified.statusCode).toBe(302);

        // Verification materializes the Home's managed-GitHub sign-in provider.
        const instance = await db.identityProviderInstance.findFirstOrThrow({
            where: { kind: "github_app_identity" },
            select: { id: true },
        });
        await db.identityProviderInstance.update({
            where: { id: instance.id },
            data: { enabled: true, firstEnabledAt: new Date() },
        });
        const resolved = await resolveOAuthRuntimeById(process.env, instance.id);
        if (!resolved) throw new Error("expected a managed GitHub sign-in runtime");
        const authorizeUrl = await createExternalAuthorizeUrl({
            flow: "auth",
            providerId: instance.id,
            provider: resolved.provider,
            reference: resolved.reference,
            env: process.env,
            publicKeyHex: "b".repeat(64),
            proofHash: null,
        });
        expect(authorizeUrl).toBeTruthy();

        transport.fetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "sign-in-user-token" }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: 777, login: "member-1" }), { status: 200 }));
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        registerOAuthCallbackRoute(app.withTypeProvider<ZodTypeProvider>());
        const response = await app.inject({
            method: "GET",
            // A managed GitHub sign-in provider registers its callback under the shared
            // `github-app` route; the consumed attempt still carries the exact instance id.
            url: `/v1/oauth/github-app/callback?state=${encodeURIComponent(
                new URL(authorizeUrl!).searchParams.get("state")!,
            )}&code=sign-in-code`,
        });
        await app.close();

        expect(response.statusCode).toBe(302);
        const redirect = new URL(response.headers.location as string);
        expect(redirect.searchParams.get("error")).toBeNull();
        const pendingKey = redirect.searchParams.get("pending");
        expect(pendingKey).toBeTruthy();
        const pending = JSON.parse(
            (await db.repeatKey.findUniqueOrThrow({ where: { key: pendingKey! } })).value,
        ) as Record<string, unknown>;
        // The managed GitHub user token proved the identity during this callback and
        // nothing after it reads one, so the continuation retains neither token.
        expect(pending.profileEnc).toEqual(expect.any(String));
        expect(pending).not.toHaveProperty("accessTokenEnc");
        expect(pending).not.toHaveProperty("refreshTokenEnc");
        expect(JSON.stringify(pending)).not.toContain("sign-in-user-token");
    });
});
