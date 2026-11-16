import { randomBytes } from "node:crypto";
import { z } from "zod/mini";

import type { ProviderCatalogContext } from "@/app/auth/providers/providerReference";
import { auth } from "@/app/auth/auth";
import { resolveManagedIdentityNetworkPolicyInTx } from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import { resolveOauthStateAttemptTtlMsFromEnv } from "@/app/api/routes/connect/oauthExternal/oauthExternalConfig";
import { createOutboundIdentityFetch } from "@/app/net/outboundIdentityFetch";
import { resolveConfiguredPublicServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { readGitHubAppInstallationEvidence } from "./githubAppInstallationClient";
import {
    authorizeGitHubAppManagementInTx,
    type GitHubAppManagementRefusal,
    beginGitHubAppInstallationVerification,
    createGitHubAppRegistration,
    projectGitHubAppManagementAuthenticationV1,
    readGitHubAppRegistrationRuntime,
    type BeginGitHubAppInstallationVerificationResult,
    type GitHubAppManagementAuthorizationInput,
    type GitHubAppRegistrationView,
} from "./githubManagedAppLifecycle";
import {
    GitHubAppManagementAuthenticationV1Schema,
    type GitHubAppManagementAuthenticationV1,
} from "./githubManagedApp";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";

const GITHUB_MANIFEST_PURPOSE = "github_app_manifest_setup" as const;
const GITHUB_CALLBACK_PROVIDER_ID = "github";
const GITHUB_MANIFEST_LAUNCH_PREFIX = "github_app_manifest_launch_";

const GitHubManifestSetupContinuationSchema = z.strictObject({
    v: z.literal(1),
    actorAccountId: z.string().check(z.minLength(1)),
    owner: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("home") }),
        z.strictObject({ kind: z.literal("team"), teamId: z.string().check(z.minLength(1)) }),
    ]),
    registrationId: z.string().check(z.minLength(1)),
    registrationRevision: z.number().check(z.int(), z.positive()),
    // The initiating request's server-stamped authentication facts. The setup
    // return is a browser redirect with no Happier credential, so the finalizer
    // re-runs the same authorization with what the server observed.
    authentication: z.optional(GitHubAppManagementAuthenticationV1Schema),
});

export function isGitHubAppManifestSetupContinuationValue(value: string): boolean {
    try {
        return GitHubManifestSetupContinuationSchema.safeParse(JSON.parse(value)).success;
    } catch {
        return false;
    }
}

export function createGitHubAppManifest(input: Readonly<{
    appName: string;
    publicServerUrl: string;
    callbackUrl: string;
    userAuthorizationCallbackUrl: string;
    setupUrl: string;
}>): string {
    return JSON.stringify({
        name: input.appName,
        url: input.publicServerUrl,
        // GitHub App manifests distinguish the one-time post-creation return
        // from user-authorization callbacks. This route owns both purposes and
        // dispatches them from the signed attempt, so register the exact URL in
        // both fields rather than leaving manifest-created Apps unable to sign in.
        redirect_url: input.callbackUrl,
        callback_urls: [input.userAuthorizationCallbackUrl],
        setup_url: input.setupUrl,
        setup_on_update: false,
        public: false,
        default_permissions: { metadata: "read", members: "read" },
        default_events: [],
    });
}

const GitHubManifestLaunchSchema = z.strictObject({
    v: z.literal(1),
    submitUrl: z.url().check(z.refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "github.com" && Boolean(url.searchParams.get("state"));
    })),
    manifest: z.string().check(z.minLength(1), z.maxLength(65_536)),
});

const GitHubManifestConversionSchema = z.looseObject({
    id: z.number().check(z.int(), z.positive(), z.int()),
    slug: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    client_id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    client_secret: z.string().check(z.trim(), z.minLength(1)),
    // GitHub always sends this field and sends null when the manifest has no
    // webhook, as Happier's never does.
    webhook_secret: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    pem: z.string().check(z.trim(), z.minLength(1)),
    owner: z.looseObject({
        id: z.number().check(z.int(), z.positive(), z.int()),
        login: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    }),
});

export type BeginGitHubAppManifestSetupResult =
    | Readonly<{ status: "ready"; authorizeUrl: string }>
    | Readonly<{ status: GitHubAppManagementRefusal | "github_app_not_configured" }>;

export async function beginGitHubAppManifestSetup(params: GitHubAppManagementAuthorizationInput & Readonly<{
    appName: string;
    githubOwner: Readonly<{ kind: "account" }> | Readonly<{ kind: "organization"; login: string }>;
    env: NodeJS.ProcessEnv;
}>): Promise<BeginGitHubAppManifestSetupResult> {
    const authority = await inTx(async (tx) => await authorizeGitHubAppManagementInTx(tx, params));
    if (authority.status !== "authorized") return { status: authority.status };
    const authentication = projectGitHubAppManagementAuthenticationV1(params);
    const publicServerUrl = resolveConfiguredPublicServerUrl(params.env);
    if (!publicServerUrl) return { status: "github_app_not_configured" };

    const expiresAt = new Date(Date.now() + resolveOauthStateAttemptTtlMsFromEnv(params.env));
    let sid = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
        sid = randomKeyNaked(24);
        try {
            await db.repeatKey.create({
                data: {
                    key: `oauth_state_${sid}`,
                    value: JSON.stringify({
                        provider: GITHUB_CALLBACK_PROVIDER_ID,
                        purpose: GITHUB_MANIFEST_PURPOSE,
                        githubAppManifestSetup: {
                            owner: params.owner,
                            ...(authentication ? { authentication } : {}),
                        },
                        // The shared attempt parser retains these fields for all
                        // callback purposes; manifest conversion does not use them.
                        pkceCodeVerifier: randomBytes(32).toString("base64url"),
                        nonce: randomBytes(32).toString("base64url"),
                    }),
                    expiresAt,
                },
            });
            break;
        } catch {
            sid = "";
        }
    }
    if (!sid) return { status: "github_app_not_configured" };

    let state: string;
    try {
        state = await auth.createOauthStateToken({
            flow: "connect",
            provider: GITHUB_CALLBACK_PROVIDER_ID,
            sid,
            userId: params.actorAccountId,
            purpose: GITHUB_MANIFEST_PURPOSE,
        });
    } catch (error) {
        await db.repeatKey.delete({ where: { key: `oauth_state_${sid}` } }).catch(() => undefined);
        throw error;
    }

    const callbackUrl = `${publicServerUrl}/v1/oauth/github/callback`;
    const userAuthorizationCallbackUrl = managedGitHubAppUserAuthorizationCallbackUrl(publicServerUrl);
    const setupUrl = new URL("/v1/identity/github-apps/manifest-setup/complete", publicServerUrl);
    setupUrl.searchParams.set("state", state);
    const appName = params.appName.trim();
    const manifest = createGitHubAppManifest({
        appName,
        publicServerUrl,
        callbackUrl,
        userAuthorizationCallbackUrl,
        setupUrl: setupUrl.toString(),
    });
    const submitUrl = params.githubOwner.kind === "account"
        ? new URL("https://github.com/settings/apps/new")
        : new URL(`https://github.com/organizations/${encodeURIComponent(params.githubOwner.login.trim())}/settings/apps/new`);
    submitUrl.searchParams.set("state", state);
    const launchValue = JSON.stringify({
        v: 1,
        submitUrl: submitUrl.toString(),
        manifest,
    } satisfies z.input<typeof GitHubManifestLaunchSchema>);
    let launchHandle = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
        launchHandle = randomKeyNaked(24);
        try {
            await db.repeatKey.create({
                data: {
                    key: `${GITHUB_MANIFEST_LAUNCH_PREFIX}${launchHandle}`,
                    value: launchValue,
                    expiresAt,
                },
            });
            break;
        } catch {
            launchHandle = "";
        }
    }
    if (!launchHandle) {
        await db.repeatKey.delete({ where: { key: `oauth_state_${sid}` } }).catch(() => undefined);
        return { status: "github_app_not_configured" };
    }
    const authorizeUrl = new URL("/v1/identity/github-apps/manifest-setup/submit", publicServerUrl);
    authorizeUrl.searchParams.set("handle", launchHandle);
    return { status: "ready", authorizeUrl: authorizeUrl.toString() };
}

export async function consumeGitHubAppManifestLaunch(handleInput: string): Promise<Readonly<{
    submitUrl: string;
    manifest: string;
}> | null> {
    const handle = handleInput.trim();
    if (!handle) return null;
    const key = `${GITHUB_MANIFEST_LAUNCH_PREFIX}${handle}`;
    const row = await db.repeatKey.findUnique({ where: { key } });
    if (!row) return null;
    const consumed = await db.repeatKey.deleteMany({
        where: { key, value: row.value, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) return null;
    let decoded: unknown;
    try {
        decoded = JSON.parse(row.value);
    } catch {
        return null;
    }
    const parsed = GitHubManifestLaunchSchema.safeParse(decoded);
    return parsed.success
        ? { submitUrl: parsed.data.submitUrl, manifest: parsed.data.manifest }
        : null;
}

export async function persistGitHubAppManifestSetupContinuation(input: Readonly<{
    sid: string;
    expiresAt: Date;
    actorAccountId: string;
    owner: ProviderCatalogContext;
    authentication?: GitHubAppManagementAuthenticationV1;
    registration: GitHubAppRegistrationView;
}>): Promise<boolean> {
    if (input.expiresAt.getTime() <= Date.now()) return false;
    try {
        await db.repeatKey.create({
            data: {
                key: `oauth_state_${input.sid}`,
                value: JSON.stringify(GitHubManifestSetupContinuationSchema.parse({
                    v: 1,
                    actorAccountId: input.actorAccountId,
                    owner: input.owner,
                    registrationId: input.registration.id,
                    registrationRevision: input.registration.revision,
                    ...(input.authentication ? { authentication: input.authentication } : {}),
                })),
                expiresAt: input.expiresAt,
            },
        });
        return true;
    } catch {
        return false;
    }
}

export async function completeGitHubAppManifestInstallationSetup(input: Readonly<{
    state: string;
    githubInstallationId: bigint;
    env: NodeJS.ProcessEnv;
}>): Promise<BeginGitHubAppInstallationVerificationResult | Readonly<{
    status: "invalid_state" | "github_installation_evidence_invalid" | "github_app_mismatch";
}>> {
    const state = await auth.verifyOauthStateToken(input.state);
    if (!state || state.purpose !== GITHUB_MANIFEST_PURPOSE || !state.sid || !state.userId) {
        return { status: "invalid_state" };
    }
    const key = `oauth_state_${state.sid}`;
    const row = await db.repeatKey.findUnique({ where: { key } });
    if (!row || row.expiresAt.getTime() <= Date.now()) return { status: "invalid_state" };
    let decoded: unknown;
    try {
        decoded = JSON.parse(row.value);
    } catch {
        return { status: "invalid_state" };
    }
    const parsed = GitHubManifestSetupContinuationSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.actorAccountId !== state.userId) return { status: "invalid_state" };
    const authentication = parsed.data.authentication;
    const authority = await inTx(async (tx) => await authorizeGitHubAppManagementInTx(tx, {
        ...authentication,
        actorAccountId: state.userId!,
        owner: parsed.data.owner,
    }));
    if (authority.status !== "authorized") return { status: authority.status };
    const consumed = await db.repeatKey.deleteMany({
        where: { key, value: row.value, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) return { status: "invalid_state" };

    const runtime = await readGitHubAppRegistrationRuntime(parsed.data.registrationId);
    if (runtime.status !== "resolved") return { status: "not_found" };
    const registration = runtime.runtime.registration;
    if (registration.owner.kind !== parsed.data.owner.kind
        || (registration.owner.kind === "team"
            && parsed.data.owner.kind === "team"
            && registration.owner.teamId !== parsed.data.owner.teamId)) {
        return { status: "not_found" };
    }
    if (registration.revision !== parsed.data.registrationRevision) {
        return { status: "registration_revision_conflict" };
    }
    if (!runtime.runtime.secrets.privateKey) return { status: "github_app_not_configured" };
    const network = await inTx(async (tx) => await resolveManagedIdentityNetworkPolicyInTx(tx, {
        env: input.env,
        timeoutSeconds: 30,
    }));
    let evidence: Awaited<ReturnType<typeof readGitHubAppInstallationEvidence>>;
    try {
        evidence = await readGitHubAppInstallationEvidence({
            githubHost: registration.githubHost,
            githubAppId: registration.githubAppId,
            privateKey: runtime.runtime.secrets.privateKey,
            githubInstallationId: input.githubInstallationId,
            networkPolicy: network.policy,
        });
    } catch {
        return { status: "github_installation_evidence_invalid" };
    }
    // A returned installation id that GitHub will not describe is the same
    // unverified state as a thrown transport failure: the setup callback's
    // `installation_id` is a hint until authenticated evidence confirms it.
    if (!evidence) return { status: "github_installation_evidence_invalid" };
    if (evidence.githubAppId !== registration.githubAppId) {
        return { status: "github_app_mismatch" };
    }
    const current = await db.gitHubAppInstallation.findFirst({
        where: { registrationId: registration.id, githubInstallationId: input.githubInstallationId },
        select: { revision: true },
    });
    return await beginGitHubAppInstallationVerification({
        ...authentication,
        actorAccountId: state.userId,
        owner: parsed.data.owner,
        registrationId: registration.id,
        expectedRegistrationRevision: registration.revision,
        expectedInstallationRevision: current?.revision ?? 0,
        githubInstallationId: input.githubInstallationId,
        githubOrganizationId: evidence.githubOrganizationId,
        env: input.env,
    });
}

function escapeHtmlAttribute(value: string): string {
    return value
        .split("&").join("&amp;")
        .split('"').join("&quot;")
        .split("'").join("&#39;")
        .split("<").join("&lt;")
        .split(">").join("&gt;");
}

export function renderGitHubAppManifestSubmissionPage(
    launch: Readonly<{ submitUrl: string; manifest: string }>,
    nonce: string,
): string {
    const action = escapeHtmlAttribute(launch.submitUrl);
    const manifest = escapeHtmlAttribute(launch.manifest);
    const scriptNonce = escapeHtmlAttribute(nonce);
    return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        `<title>Continue to GitHub</title><style nonce="${scriptNonce}">body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#24292f}button{font:inherit;padding:.7rem 1rem}</style></head>`,
        `<body><h1>Continue to GitHub</h1><p>Happier is opening GitHub to create the App.</p><form id="github-app-manifest" method="post" action="${action}">`,
        `<input type="hidden" name="manifest" value="${manifest}">`,
        '<button type="submit">Continue to GitHub</button></form>',
        `<script nonce="${scriptNonce}">document.getElementById("github-app-manifest").submit()</script></body></html>`,
    ].join("");
}

export type CompleteGitHubAppManifestSetupResult =
    | Readonly<{ status: "created"; registration: GitHubAppRegistrationView }>
    | Readonly<{ status: GitHubAppManagementRefusal | "github_enterprise_origin_not_approved" | "github_manifest_exchange_failed" }>
    | Readonly<{ status: "github_app_already_registered" }>;

export async function completeGitHubAppManifestSetup(
    params: Partial<TeamOperationAuthenticationContext> & Readonly<{
        actorAccountId: string;
        owner: ProviderCatalogContext;
        code: string;
        env: NodeJS.ProcessEnv;
    }>,
): Promise<CompleteGitHubAppManifestSetupResult> {
    const prepared = await inTx(async (tx) => {
        const authority = await authorizeGitHubAppManagementInTx(tx, params);
        if (authority.status !== "authorized") {
            return { status: authority.status };
        }
        return await resolveManagedIdentityNetworkPolicyInTx(tx, { env: params.env, timeoutSeconds: 30 });
    });
    if ("status" in prepared) return prepared;

    const outbound = createOutboundIdentityFetch({ policy: prepared.policy });
    let raw: unknown;
    try {
        const response = await outbound.fetch(
            new URL(`https://api.github.com/app-manifests/${encodeURIComponent(params.code)}/conversions`),
            {
                method: "POST",
                headers: {
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2026-03-10",
                },
            },
        );
        if (!response.ok) return { status: "github_manifest_exchange_failed" };
        raw = await response.json();
    } catch {
        return { status: "github_manifest_exchange_failed" };
    } finally {
        await outbound.close();
    }
    const converted = GitHubManifestConversionSchema.safeParse(raw);
    if (!converted.success) return { status: "github_manifest_exchange_failed" };
    const result = await createGitHubAppRegistration({
        ...params,
        input: {
            githubHost: "https://github.com",
            githubAppId: BigInt(converted.data.id),
            githubClientId: converted.data.client_id,
            githubAppSlug: converted.data.slug,
            githubOwnerId: BigInt(converted.data.owner.id),
            githubOwnerLogin: converted.data.owner.login,
            secrets: {
                v: 1,
                clientSecret: converted.data.client_secret,
                privateKey: converted.data.pem,
                ...(converted.data.webhook_secret ? { webhookSecret: converted.data.webhook_secret } : {}),
            },
        },
    });
    if (result.status === "created") return result;
    // Every administration refusal travels unchanged, so a Team owner who must
    // re-authenticate is told that rather than that the App already exists.
    if (result.status === "forbidden"
        || result.status === "team_authentication_required"
        || result.status === "team_authentication_unavailable") return result;
    return { status: "github_app_already_registered" };
}

/**
 * The user-authorization callback registered on a managed GitHub App. The
 * identity runtime presents exactly this value as `redirect_uri`, and the
 * administration projection shows exactly this value to copy, so the two can
 * never disagree.
 */
export function managedGitHubAppUserAuthorizationCallbackUrl(publicServerUrl: string): string {
    return `${publicServerUrl.replace(/\/$/u, "")}/v1/oauth/github-app/callback`;
}
