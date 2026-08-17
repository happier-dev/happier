import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import {
    PluginHostedWebOriginV1Schema,
} from "@happier-dev/protocol";
import {
    GENERATED_HOSTED_WEB_ASSET_PROFILE_V1,
    PluginUiArtifactDigestV1Schema,
} from "@happier-dev/protocol/plugins/ui";
import { decodeBase64, encodeBase64 } from "privacy-kit";
import { z } from "zod";

import {
    resolveConfiguredCanonicalServerUrl,
    resolveEffectiveWebappUrl,
} from "@/app/serverUrls/effectiveServerUrls";

/**
 * A full local day covers a normal long-lived hosted surface that defers route
 * chunks, images, or fonts until long after its initial document graph. Static
 * bytes carry no Account or host authority; hard withdrawal still rechecks on
 * every request. There is intentionally no renewal state or client retry
 * protocol.
 */
export const BROWSER_ARTIFACT_CAPABILITY_TTL_MS = 24 * 60 * 60_000;
const BROWSER_ARTIFACT_CAPABILITY_PREFIX = "hwb1";
const BROWSER_ARTIFACT_CAPABILITY_AUDIENCE = "happier.plugin-ui-artifact-browser";
const BROWSER_ARTIFACT_CAPABILITY_DOMAIN = "happier.plugin-ui-artifact-browser.v1\u0000";
const BROWSER_ARTIFACT_CAPABILITY_ENCRYPTION_KEY_DOMAIN =
    "happier.plugin-ui-artifact-browser.v1.aes-256-gcm\u0000";
const BROWSER_ARTIFACT_CAPABILITY_NONCE_BYTES = 12;
const BROWSER_ARTIFACT_CAPABILITY_AUTH_TAG_BYTES = 16;
const MAX_BROWSER_ARTIFACT_CAPABILITY_LENGTH = 16 * 1024;
export const BROWSER_ARTIFACT_CAPABILITY_ROUTE_PREFIX =
    "/v1/plugins/availability/ui-artifacts/browser";
export const BROWSER_ARTIFACT_CAPABILITY_ROUTE_PATH =
    `${BROWSER_ARTIFACT_CAPABILITY_ROUTE_PREFIX}/:capability/*`;

const BrowserArtifactHostedWebScopeV1Schema = z.object({
    profile: z.literal(GENERATED_HOSTED_WEB_ASSET_PROFILE_V1),
    assetRootId: z.string().trim().min(1).max(1024),
    entryPath: z.string().trim().min(1).max(1024),
}).strict().refine(
    (scope) => scope.entryPath.startsWith(`${scope.assetRootId}/`),
    "Expected the generated Artifact entry beneath its signed root",
);
export type BrowserArtifactHostedWebScopeV1 = z.infer<typeof BrowserArtifactHostedWebScopeV1Schema>;

const BrowserArtifactCapabilityClaimsV1Schema = z.object({
    v: z.literal(1),
    audience: z.literal(BROWSER_ARTIFACT_CAPABILITY_AUDIENCE),
    accountId: z.string().trim().min(1).max(512),
    release: z.object({
        pluginId: z.string().trim().min(1).max(512),
        version: z.string().trim().min(1).max(512),
    }).strict(),
    contributionId: z.string().trim().min(1).max(512),
    tier: z.literal("hostedWeb"),
    platform: z.literal("web"),
    artifactId: z.string().uuid(),
    artifactDigest: PluginUiArtifactDigestV1Schema,
    hostedWebScope: BrowserArtifactHostedWebScopeV1Schema,
    embeddingOrigin: PluginHostedWebOriginV1Schema,
    artifactOrigin: PluginHostedWebOriginV1Schema.refine(
        (origin) => new URL(origin).protocol === "https:",
        "Expected a dedicated HTTPS Artifact origin",
    ),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
}).strict().superRefine((value, context) => {
    if (value.expiresAt <= value.issuedAt) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["expiresAt"],
            message: "Capability expiry must follow issuance",
        });
    }
    if (value.expiresAt - value.issuedAt > BROWSER_ARTIFACT_CAPABILITY_TTL_MS) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["expiresAt"],
            message: "Capability expiry exceeds the bounded browser Artifact lifetime",
        });
    }
});

export type BrowserArtifactCapabilityClaimsV1 = z.infer<typeof BrowserArtifactCapabilityClaimsV1Schema>;

export type BrowserArtifactCapabilityConfig = Readonly<{
    artifactOrigin: string;
    embeddingOrigin: string;
    signingSecret: string;
}>;

export type BrowserArtifactCapabilityRequestOrigin = Readonly<{
    protocol?: unknown;
    host?: unknown;
}>;

function readExactHttpsOrigin(value: unknown): string | null {
    const parsed = PluginHostedWebOriginV1Schema.safeParse(value);
    if (!parsed.success || new URL(parsed.data).protocol !== "https:") return null;
    return parsed.data;
}

function readOriginFromUrl(value: string | undefined): string | null {
    if (!value) return null;
    try {
        const parsed = PluginHostedWebOriginV1Schema.safeParse(new URL(value).origin);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function readEffectiveWebappOrigin(env: NodeJS.ProcessEnv): string | null {
    return readOriginFromUrl(resolveEffectiveWebappUrl(env));
}

function readConfiguredPublicServerOrigin(env: NodeJS.ProcessEnv): string | null {
    return readOriginFromUrl(resolveConfiguredCanonicalServerUrl(env));
}

/**
 * Deployment owns the dedicated HTTPS origin. The frame ancestor comes from
 * the effective web-app deployment, rather than the server API URL, so a
 * separately deployed or base-path web app remains the exact audience. The
 * Artifact origin must remain distinct from both that web app and the
 * configured public API, even when those are separately deployed.
 * Using the incumbent server master secret makes a stateless capability valid
 * across replicas/restarts without adding a token table, revocation registry,
 * or per-frame secret lifecycle.
 */
export function resolveBrowserArtifactCapabilityConfig(
    env: NodeJS.ProcessEnv = process.env,
): BrowserArtifactCapabilityConfig | null {
    const artifactOrigin = readExactHttpsOrigin(env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN);
    const embeddingOrigin = readEffectiveWebappOrigin(env);
    const publicServerOrigin = readConfiguredPublicServerOrigin(env);
    const signingSecret = (env.HANDY_MASTER_SECRET ?? "").trim();
    if (
        !artifactOrigin
        || !embeddingOrigin
        || !signingSecret
        || artifactOrigin === embeddingOrigin
        || artifactOrigin === publicServerOrigin
    ) {
        return null;
    }
    return Object.freeze({ artifactOrigin, embeddingOrigin, signingSecret });
}

/**
 * The public byte route may rely only on Fastify's configured request origin
 * projection. With proxy trust enabled, Fastify supplies that projection from
 * the trusted proxy headers; otherwise it is the direct HTTPS request. A raw
 * client-provided URL or a host-only comparison would let the bearer path be
 * replayed through another origin.
 */
export function isBrowserArtifactCapabilityRequestOnArtifactOrigin(input: Readonly<{
    config: BrowserArtifactCapabilityConfig;
    request: BrowserArtifactCapabilityRequestOrigin;
}>): boolean {
    if (input.request.protocol !== "https" || typeof input.request.host !== "string") {
        return false;
    }
    const host = input.request.host.trim();
    if (!host) return false;
    try {
        const requestUrl = new URL(`https://${host}`);
        return requestUrl.origin === input.config.artifactOrigin
            && requestUrl.pathname === "/"
            && !requestUrl.search
            && !requestUrl.hash
            && !requestUrl.username
            && !requestUrl.password;
    } catch {
        return false;
    }
}

function deriveCapabilityEncryptionKey(signingSecret: string): Buffer {
    return createHmac("sha256", signingSecret)
        .update(BROWSER_ARTIFACT_CAPABILITY_ENCRYPTION_KEY_DOMAIN, "utf8")
        .digest();
}

function encodeCanonicalBase64Url(value: Uint8Array): string {
    return encodeBase64(Uint8Array.from(value), "base64url").replace(/=+$/u, "");
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
    try {
        const decoded = decodeBase64(value, "base64url");
        return encodeCanonicalBase64Url(decoded) === value ? Buffer.from(decoded) : null;
    } catch {
        return null;
    }
}

function sealPayload(payload: Buffer, signingSecret: string): string {
    const nonce = randomBytes(BROWSER_ARTIFACT_CAPABILITY_NONCE_BYTES);
    const cipher = createCipheriv(
        "aes-256-gcm",
        deriveCapabilityEncryptionKey(signingSecret),
        nonce,
    );
    cipher.setAAD(Buffer.from(BROWSER_ARTIFACT_CAPABILITY_DOMAIN, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return encodeCanonicalBase64Url(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
}

function openPayload(encodedPayload: string, signingSecret: string): Buffer | null {
    const sealed = decodeCanonicalBase64Url(encodedPayload);
    if (
        !sealed
        || sealed.byteLength <= BROWSER_ARTIFACT_CAPABILITY_NONCE_BYTES
            + BROWSER_ARTIFACT_CAPABILITY_AUTH_TAG_BYTES
    ) {
        return null;
    }
    const nonce = sealed.subarray(0, BROWSER_ARTIFACT_CAPABILITY_NONCE_BYTES);
    const authTag = sealed.subarray(sealed.byteLength - BROWSER_ARTIFACT_CAPABILITY_AUTH_TAG_BYTES);
    const ciphertext = sealed.subarray(
        BROWSER_ARTIFACT_CAPABILITY_NONCE_BYTES,
        sealed.byteLength - BROWSER_ARTIFACT_CAPABILITY_AUTH_TAG_BYTES,
    );
    try {
        const decipher = createDecipheriv(
            "aes-256-gcm",
            deriveCapabilityEncryptionKey(signingSecret),
            nonce,
        );
        decipher.setAAD(Buffer.from(BROWSER_ARTIFACT_CAPABILITY_DOMAIN, "utf8"));
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
        return null;
    }
}

export function mintBrowserArtifactCapability(input: Readonly<{
    config: BrowserArtifactCapabilityConfig;
    claim: Omit<
        BrowserArtifactCapabilityClaimsV1,
        "v" | "audience" | "embeddingOrigin" | "artifactOrigin" | "issuedAt" | "expiresAt"
    >;
    nowMs: number;
}>): Readonly<{ capability: string; expiresAt: number }> | null {
    const issuedAt = Math.floor(input.nowMs);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
    const claim = BrowserArtifactCapabilityClaimsV1Schema.safeParse({
        ...input.claim,
        v: 1,
        audience: BROWSER_ARTIFACT_CAPABILITY_AUDIENCE,
        embeddingOrigin: input.config.embeddingOrigin,
        artifactOrigin: input.config.artifactOrigin,
        issuedAt,
        expiresAt: issuedAt + BROWSER_ARTIFACT_CAPABILITY_TTL_MS,
    });
    if (!claim.success) return null;

    const payload = sealPayload(
        Buffer.from(JSON.stringify(claim.data), "utf8"),
        input.config.signingSecret,
    );
    const capability = `${BROWSER_ARTIFACT_CAPABILITY_PREFIX}.${payload}`;
    if (capability.length > MAX_BROWSER_ARTIFACT_CAPABILITY_LENGTH) return null;
    return Object.freeze({ capability, expiresAt: claim.data.expiresAt });
}

export function verifyBrowserArtifactCapability(input: Readonly<{
    capability: string;
    signingSecret: string;
    nowMs: number;
}>): BrowserArtifactCapabilityClaimsV1 | null {
    if (input.capability.length > MAX_BROWSER_ARTIFACT_CAPABILITY_LENGTH) return null;
    const [prefix, encodedPayload, ...rest] = input.capability.split(".");
    if (
        prefix !== BROWSER_ARTIFACT_CAPABILITY_PREFIX
        || !encodedPayload
        || rest.length > 0
    ) {
        return null;
    }
    const payload = openPayload(encodedPayload, input.signingSecret);
    if (!payload) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(payload.toString("utf8"));
    } catch {
        return null;
    }
    const claim = BrowserArtifactCapabilityClaimsV1Schema.safeParse(raw);
    if (!claim.success || !Number.isSafeInteger(input.nowMs) || input.nowMs >= claim.data.expiresAt) {
        return null;
    }
    return claim.data;
}

export function createBrowserArtifactCapabilityUrl(input: Readonly<{
    artifactOrigin: string;
    capability: string;
}>): string | null {
    const origin = readExactHttpsOrigin(input.artifactOrigin);
    if (!origin || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(input.capability)) {
        return null;
    }
    return `${origin}${BROWSER_ARTIFACT_CAPABILITY_ROUTE_PREFIX}/${input.capability}/`;
}
