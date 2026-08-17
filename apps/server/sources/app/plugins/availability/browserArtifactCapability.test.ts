import { describe, expect, it } from "vitest";
import { decodeBase64 } from "privacy-kit";
import {
    deriveGeneratedHostedWebAssetPolicyV1,
    type PluginUiArtifactDigestV1,
} from "@happier-dev/protocol/plugins/ui";

import {
    createBrowserArtifactCapabilityUrl,
    isBrowserArtifactCapabilityRequestOnArtifactOrigin,
    mintBrowserArtifactCapability,
    resolveBrowserArtifactCapabilityConfig,
    verifyBrowserArtifactCapability,
} from "./browserArtifactCapability";

const artifactDigest: PluginUiArtifactDigestV1 =
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const graph = {
    contributionId: "panel",
    tier: "hostedWeb" as const,
    platform: "web" as const,
    entry: "hosted-web/panel/index.html",
    files: [
        {
            relativePath: "hosted-web/panel/index.html",
            digest: `sha256:${"a".repeat(64)}`,
            byteSize: 1,
        },
        {
            relativePath: "hosted-web/panel/assets/app.js",
            digest: `sha256:${"b".repeat(64)}`,
            byteSize: 2,
        },
        {
            relativePath: "hosted-web/panel/assets/app.css",
            digest: `sha256:${"c".repeat(64)}`,
            byteSize: 3,
        },
        {
            relativePath: "hosted-web/panel/assets/font.woff2",
            digest: `sha256:${"d".repeat(64)}`,
            byteSize: 4,
        },
        {
            relativePath: "hosted-web/panel/assets/logo.svg",
            digest: `sha256:${"e".repeat(64)}`,
            byteSize: 5,
        },
    ],
    digest: artifactDigest,
    builtWith: { bundler: "vite" as const, version: "7.0.0" },
    hostUiApiVersion: "1.0.0",
    compat: {},
};

const config = {
    artifactOrigin: "https://artifacts.happier.test",
    embeddingOrigin: "https://app.happier.test",
    signingSecret: "browser-artifact-test-secret",
};

describe("browser Artifact capability", () => {
    it("keeps a valid Account identity sentinel opaque in the bearer", () => {
        const policy = deriveGeneratedHostedWebAssetPolicyV1(graph);
        if (!policy) throw new Error("Expected derived browser Artifact policy");
        const accountId = "account-private-sentinel";
        const minted = mintBrowserArtifactCapability({
            config,
            claim: {
                accountId,
                release: { pluginId: "com.acme.panel", version: "1.2.3" },
                contributionId: graph.contributionId,
                tier: graph.tier,
                platform: graph.platform,
                artifactId: "00000000-0000-4000-8000-000000000001",
                artifactDigest: graph.digest,
                hostedWebScope: {
                    profile: policy.profile,
                    assetRootId: policy.assetRootId,
                    entryPath: policy.entryPath,
                },
            },
            nowMs: 1_800_000_000_000,
        });
        expect(minted).not.toBeNull();
        if (!minted) throw new Error("Expected browser capability");

        expect(minted.capability).toMatch(/^hwb1\.[A-Za-z0-9_-]+$/u);
        const bearerText = minted.capability
            .split(".")
            .slice(1)
            .map((segment) => new TextDecoder().decode(decodeBase64(segment, "base64url")))
            .join("\n");
        expect(bearerText).not.toContain(accountId);
        expect(verifyBrowserArtifactCapability({
            capability: minted.capability,
            signingSecret: config.signingSecret,
            nowMs: 1_800_000_000_001,
        })).toEqual(expect.objectContaining({ accountId }));
    });

    it("accepts the capability only at its configured dedicated HTTPS origin", () => {
        expect(isBrowserArtifactCapabilityRequestOnArtifactOrigin({
            config,
            request: {
                protocol: "https",
                host: "artifacts.happier.test",
            },
        })).toBe(true);
        expect(isBrowserArtifactCapabilityRequestOnArtifactOrigin({
            config,
            request: {
                protocol: "http",
                host: "artifacts.happier.test",
            },
        })).toBe(false);
        expect(isBrowserArtifactCapabilityRequestOnArtifactOrigin({
            config,
            request: {
                protocol: "https",
                host: "api.happier.test",
            },
        })).toBe(false);
        expect(isBrowserArtifactCapabilityRequestOnArtifactOrigin({
            config,
            request: {
                protocol: "https",
                host: "artifacts.happier.test/forged-path",
            },
        })).toBe(false);
    });

    it("keeps only the generated-V2 profile/root/entry scope sealed and valid for a late lazy subresource", () => {
        const policy = deriveGeneratedHostedWebAssetPolicyV1(graph);
        expect(policy).toEqual(expect.objectContaining({
            profile: "generatedV2",
            assetRootId: "hosted-web/panel",
            entryPath: "hosted-web/panel/index.html",
            files: graph.files.map((file) => file.relativePath),
            digest: graph.digest,
            routeMode: "pathFallback",
            sourceMaps: { enabled: false },
        }));
        if (!policy) throw new Error("Expected derived browser Artifact policy");
        const hostedWebScope = {
            profile: policy.profile,
            assetRootId: policy.assetRootId,
            entryPath: policy.entryPath,
        } as const;

        const minted = mintBrowserArtifactCapability({
            config,
            claim: {
                accountId: "account-a",
                release: { pluginId: "com.acme.panel", version: "1.2.3" },
                contributionId: graph.contributionId,
                tier: graph.tier,
                platform: graph.platform,
                artifactId: "00000000-0000-4000-8000-000000000001",
                artifactDigest: graph.digest,
                hostedWebScope,
            },
            nowMs: 1_800_000_000_000,
        });
        expect(minted).not.toBeNull();
        if (!minted) throw new Error("Expected browser capability");

        expect(verifyBrowserArtifactCapability({
            capability: minted.capability,
            signingSecret: config.signingSecret,
            nowMs: 1_800_000_000_001,
        })).toEqual(expect.objectContaining({
            accountId: "account-a",
            artifactDigest: graph.digest,
            artifactOrigin: config.artifactOrigin,
            embeddingOrigin: config.embeddingOrigin,
            hostedWebScope,
        }));
        expect(verifyBrowserArtifactCapability({
            capability: minted.capability,
            signingSecret: config.signingSecret,
            // The frame can lazy-load a route chunk or font well after its
            // initial document graph. There is deliberately no renewal state.
            nowMs: 1_800_000_000_000 + (12 * 60 * 60 * 1_000),
        })).toEqual(expect.objectContaining({ hostedWebScope }));
        expect(verifyBrowserArtifactCapability({
            capability: `${minted.capability}x`,
            signingSecret: config.signingSecret,
            nowMs: 1_800_000_000_001,
        })).toBeNull();
        expect(verifyBrowserArtifactCapability({
            capability: minted.capability,
            signingSecret: "wrong-secret",
            nowMs: 1_800_000_000_001,
        })).toBeNull();
        expect(verifyBrowserArtifactCapability({
            capability: minted.capability,
            signingSecret: config.signingSecret,
            nowMs: minted.expiresAt,
        })).toBeNull();
        expect(createBrowserArtifactCapabilityUrl({
            artifactOrigin: config.artifactOrigin,
            capability: minted.capability,
        })).toBe(`https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/${minted.capability}/`);
    });

    it("fails closed without a dedicated HTTPS Artifact origin or effective web-app origin", () => {
        expect(resolveBrowserArtifactCapabilityConfig({
            HANDY_MASTER_SECRET: config.signingSecret,
            HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: "http://artifacts.happier.test",
            HAPPIER_WEBAPP_URL: config.embeddingOrigin,
        })).toBeNull();
        expect(resolveBrowserArtifactCapabilityConfig({
            HANDY_MASTER_SECRET: config.signingSecret,
            HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: config.artifactOrigin,
            HAPPIER_WEBAPP_URL: "not-a-url",
        })).toBeNull();
        expect(resolveBrowserArtifactCapabilityConfig({
            HANDY_MASTER_SECRET: config.signingSecret,
            HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: config.artifactOrigin,
            HAPPIER_PUBLIC_SERVER_URL: "https://server.happier.test/api",
            HAPPIER_WEBAPP_URL: "https://app.happier.test/base/path",
        })).toMatchObject({
            artifactOrigin: config.artifactOrigin,
            embeddingOrigin: config.embeddingOrigin,
        });
    });

    it("fails closed when the Artifact origin aliases the web app or public API", () => {
        expect(resolveBrowserArtifactCapabilityConfig({
            HANDY_MASTER_SECRET: config.signingSecret,
            HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: config.embeddingOrigin,
            HAPPIER_WEBAPP_URL: `${config.embeddingOrigin}/base/path`,
        })).toBeNull();
        expect(resolveBrowserArtifactCapabilityConfig({
            HANDY_MASTER_SECRET: config.signingSecret,
            HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: "https://api.happier.test",
            HAPPIER_PUBLIC_SERVER_URL: "https://api.happier.test/v1",
            HAPPIER_WEBAPP_URL: config.embeddingOrigin,
        })).toBeNull();
    });
});
