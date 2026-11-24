import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    describeLinkedIds,
    identityProviderCallbackUrl,
    listProviderDescriptors,
    resolveIdentityRuntimeById,
    resolveOAuthRuntimeById,
    resolveRuntime,
} from "./identityProviderCatalog";
import type { ProviderReference } from "./providerReference";

let harness: LightSqliteHarness;

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-provider-catalog-",
        initAuth: false,
        initEncrypt: false,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());

function oidcEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        type: "oidc",
        displayName: id,
        issuer: "https://issuer.example.test",
        clientId: "cid",
        clientAuthenticationMethod: "client_secret_post",
        clientSecret: "secret",
        redirectUrl: `https://server.example.test/v1/oauth/${id}/callback`,
        ...overrides,
    };
}

function envWith(...entries: Record<string, unknown>[]): NodeJS.ProcessEnv {
    return { AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify(entries) } as NodeJS.ProcessEnv;
}

describe("identityProviderCatalog runtime resolution (SQLite integration)", () => {
    it("enumerates surviving built-in and deployment runtimes from the canonical catalog", async () => {
        const runtimes = await listProviderDescriptors(envWith(
            oidcEntry("acme"),
            oidcEntry("github"),
        ));

        expect(runtimes.map(({ reference }) => reference.id)).toEqual(["github", "acme"]);
        expect(runtimes.map(({ reference }) => reference.source)).toEqual(["built_in", "deployment"]);
    });

    it("reads deployment configuration before starting the descriptor transaction and refreshes it on the next call", async () => {
        const path = join(harness.baseDir, "oidc-providers.json");
        const env = { AUTH_PROVIDERS_CONFIG_PATH: path };
        writeFileSync(path, JSON.stringify([oidcEntry("before")]));
        const transaction = db.$transaction;
        // Change the file at the real database boundary to distinguish when the
        // catalog captures deployment configuration.
        db.$transaction = new Proxy(transaction, {
            apply(target, receiver, args: unknown[]) {
                writeFileSync(path, JSON.stringify([oidcEntry("after")]));
                return Reflect.apply(target, receiver, args);
            },
        });
        try {
            expect((await listProviderDescriptors(env)).map(({ reference }) => reference.id)).toEqual(["github", "before"]);
        } finally {
            db.$transaction = transaction;
        }
        expect((await listProviderDescriptors(env)).map(({ reference }) => reference.id)).toEqual(["github", "after"]);
    });

    it("resolves the built-in provider with a home-context built-in reference", async () => {
        const resolved = await resolveOAuthRuntimeById(envWith(), " GitHub ");

        expect(resolved?.provider.id).toBe("github");
        expect(resolved?.reference).toEqual({
            id: "github",
            source: "built_in",
            runtimeFingerprint: "builtin:github:v1",
            context: { kind: "home" },
        });
    });

    it("resolves a deployment provider and returns null for an unknown id", async () => {
        const env = envWith(oidcEntry("acme"));

        const resolved = await resolveOAuthRuntimeById(env, "acme");
        expect(resolved?.provider.id).toBe("acme");
        expect(resolved?.reference.source).toBe("deployment");
        expect(resolved?.reference.runtimeFingerprint).toMatch(/^deployment:v1:/);

        expect(await resolveOAuthRuntimeById(env, "missing")).toBeNull();
    });

    it("keeps the built-in runtime when a deployment entry claims a reserved id", async () => {
        const resolved = await resolveOAuthRuntimeById(envWith(oidcEntry("github")), "github");

        expect(resolved?.reference.source).toBe("built_in");
    });

    it("resolves the identity leaf of the same instance", async () => {
        const resolved = await resolveIdentityRuntimeById(envWith(oidcEntry("acme")), "acme");

        expect(resolved?.provider.id).toBe("acme");
        expect(resolved?.reference.source).toBe("deployment");
    });

    it("accepts an unchanged bound reference and rejects a changed runtime configuration", async () => {
        const env = envWith(oidcEntry("acme"));
        const bound = (await resolveOAuthRuntimeById(env, "acme"))!.reference;

        await expect(resolveRuntime({ env, reference: bound, purpose: "oauth_callback" })).resolves.toMatchObject({
            ok: true,
            reference: bound,
        });

        const rotated = envWith(oidcEntry("acme", { clientSecret: "rotated" }));
        await expect(
            resolveRuntime({ env: rotated, reference: bound, purpose: "oauth_callback" }),
        ).resolves.toEqual({ ok: false, code: "auth_provider_configuration_changed" });
    });

    it("reports an unavailable provider when the bound instance no longer exists", async () => {
        const bound = (await resolveOAuthRuntimeById(envWith(oidcEntry("acme")), "acme"))!.reference;

        await expect(
            resolveRuntime({ env: envWith(), reference: bound, purpose: "oauth_finalize" }),
        ).resolves.toEqual({ ok: false, code: "auth_provider_unavailable" });
    });

    it("rejects a bound reference whose source changed for the same id", async () => {
        const deploymentReference: ProviderReference = {
            id: "github",
            source: "deployment",
            runtimeFingerprint: "builtin:github:v1",
            context: { kind: "home" },
        };

        await expect(
            resolveRuntime({ env: envWith(), reference: deploymentReference, purpose: "oauth_start" }),
        ).resolves.toEqual({ ok: false, code: "auth_provider_configuration_changed" });
    });

    it("describes presentation leaves for many linked ids at once and omits unknown ids", async () => {
        const presentation = await describeLinkedIds({
            env: envWith(oidcEntry("acme")),
            providerIds: ["github", " ACME ", "github", "removed-provider"],
        });

        expect([...presentation.keys()].sort()).toEqual(["acme", "github"]);
        expect(presentation.get("github")?.extractLinkedProvider).toBeTypeOf("function");
    });

    it("derives the one callback URL an administrator must register at the provider", () => {
        // The same value the runtime hands the IdP as redirect_uri, so what the
        // administrator copies is what the provider will be asked to accept.
        expect(identityProviderCallbackUrl("https://home.example.test", { id: "acme", kind: "oidc" }))
            .toBe("https://home.example.test/v1/oauth/acme/callback");
        expect(identityProviderCallbackUrl("https://home.example.test", { id: "acme_sso", kind: "workos_sso" }))
            .toBe("https://home.example.test/v1/oauth/acme_sso/callback");
        expect(identityProviderCallbackUrl("https://home.example.test", { id: "gh", kind: "github_app_identity" }))
            .toBe("https://home.example.test/v1/oauth/github-app/callback");
        expect(identityProviderCallbackUrl(undefined, { id: "acme", kind: "oidc" })).toBeNull();
    });
});
