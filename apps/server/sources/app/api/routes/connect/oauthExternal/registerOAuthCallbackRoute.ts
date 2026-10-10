import { createHash } from "node:crypto";
import * as privacyKit from "privacy-kit";
import { z } from "zod";

import { type Fastify } from "../../../types";
import { auth } from "@/app/auth/auth";
import { encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { validateUsername } from "@/app/social/usernamePolicy";
import { consumeValidOAuthStateAttempt } from "../connectRoutes.oauthStateAttempt";
import { log } from "@/utils/logging/log";
import { readAuthOauthKeylessFeatureEnv, readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAccountsAvailability } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import { resolveEffectiveHomeAuthMethods } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { shouldDenyPublicSignupProvisioningAction } from "@/app/integrations/publicUrl/publicSignupProvisioningPolicy";
import {
    buildRedirectUrl,
    resolveOAuthPendingTtlMsFromEnv,
    resolveWebAppOAuthReturnUrlFromEnv,
} from "./oauthExternalConfig";
import { isCurrentAccountDirectoryOAuthTarget } from "./accountDirectoryOAuthTarget";
import { OAUTH_NOT_CONFIGURED_ERROR } from "./oauthExternalErrors";
import { oauthExternalRateLimitCallbackPerIp } from "./oauthExternalRateLimits";
import { hasInvalidOAuthSecurityBinding, oauthStateAttemptSchema, type OAuthSecurityBinding } from "./oauthExternalSchemas";
import { resolveOAuthSecurityBinding } from "./oauthSecurityBinding";
import { exchangeOAuthCodeForProfile } from "@/app/oauth/exchangeOAuthCodeForProfile";
import { createIdentityConnectionTestResult } from "./identityConnectionTestResult";
import { describeIdentityConnectionTestDiagnostics } from "./identityConnectionTestDiagnostics";
import {
    resolveGitHubAppInstallationVerificationOAuth,
    verifyGitHubAppInstallationWithAdministratorProfile,
} from "@/app/integrations/github/githubManagedAppLifecycle";
import { parseManagedGitHubUserProfile } from "@/app/integrations/github/githubManagedUserOAuth";
import {
    completeGitHubAppManifestSetup,
    isGitHubAppManifestSetupContinuationValue,
    persistGitHubAppManifestSetupContinuation,
} from "@/app/integrations/github/githubManagedAppManifest";
import { readDirectoryProvisionedIdentityCandidatesInTx } from "@/app/teams/directory/provisionedIdentityBinding";
import { inTx } from "@/storage/inTx";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

async function createConnectPending(params: Readonly<{
    providerId: string;
    userId: string;
    securityBinding: OAuthSecurityBinding;
    profile: unknown;
    accessToken: string;
    refreshToken?: string;
    /** `false` for a provider whose token was only the profile proof; see `OAuthFlowProvider#accessTokenCustody`. */
    retainAccessToken: boolean;
}>): Promise<string> {
    const pendingKey = `oauth_pending_${randomKeyNaked(24)}`;
    let profileJson: string;
    try {
        const encoded = JSON.stringify(params.profile);
        if (typeof encoded !== "string") throw new Error("invalid_profile");
        profileJson = encoded;
    } catch {
        throw new Error("invalid_profile");
    }
    const tokenEnc = params.retainAccessToken
        ? privacyKit.encodeBase64(
            encryptString(["user", params.userId, "connect", params.providerId, "pending", pendingKey], params.accessToken),
        )
        : undefined;
    const profileEnc = privacyKit.encodeBase64(
        encryptString(["user", params.userId, "connect", params.providerId, "pending", pendingKey, "profile"], profileJson),
    );
    const refreshTokenEnc = typeof params.refreshToken === "string" && params.refreshToken.trim()
        ? privacyKit.encodeBase64(encryptString(
            ["user", params.userId, "connect", params.providerId, "pending", pendingKey, "refresh"],
            params.refreshToken,
        ))
        : undefined;
    await db.repeatKey.create({
        data: {
            key: pendingKey,
            value: JSON.stringify({
                flow: "connect",
                provider: params.providerId,
                securityBinding: params.securityBinding,
                userId: params.userId,
                profileEnc,
                ...(tokenEnc ? { accessTokenEnc: tokenEnc } : {}),
                ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
            }),
            expiresAt: new Date(Date.now() + resolveOAuthPendingTtlMsFromEnv(process.env)),
        },
    });
    return pendingKey;
}

export function registerOAuthCallbackRoute(app: Fastify) {
    app.get("/v1/oauth/:provider/callback", {
        config: { rateLimit: oauthExternalRateLimitCallbackPerIp() },
        schema: {
            params: z.object({ provider: z.string() }),
            querystring: z
                .object({
                    state: z.string(),
                    code: z.string().optional(),
                    iss: z.string().optional(),
                    error: z.string().optional(),
                    error_description: z.string().optional(),
                })
                .refine((q) => Boolean(q.code) || Boolean(q.error), {
                    message: "Expected OAuth code or error",
                }),
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const callbackProviderId = request.params.provider.toString().trim().toLowerCase();
        const fallbackWebAppUrl = resolveWebAppOAuthReturnUrlFromEnv(requestHomeEnv, callbackProviderId);

        const { code, state, iss } = request.query;
        const oauthError = (request.query as any)?.error?.toString?.().trim?.() || "";

        const oauthState = await auth.verifyOauthStateToken(state);
        if (!oauthState || oauthState.provider !== callbackProviderId) {
            const stateHash = createHash("sha256").update(state, "utf8").digest("hex").slice(0, 12);
            log({ module: "oauth" }, `Invalid state token (sha256:${stateHash})`);
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, { error: "invalid_state" }));
        }

        const sid = oauthState.sid?.toString().trim() || "";
        if (!sid) {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        const pendingAttempt = await db.repeatKey.findUnique({ where: { key: `oauth_state_${sid}` } });
        if (pendingAttempt && isGitHubAppManifestSetupContinuationValue(pendingAttempt.value)) {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        const attempt = await consumeValidOAuthStateAttempt(sid);
        if (!attempt) {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        let attemptJson: unknown;
        try {
            attemptJson = JSON.parse(attempt.value);
        } catch {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        const attemptParsed = oauthStateAttemptSchema.safeParse(attemptJson);
        if (!attemptParsed.success) {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, {
                flow: oauthState.flow,
                error: hasInvalidOAuthSecurityBinding(attemptJson) ? "auth_provider_configuration_changed" : "invalid_state",
            }));
        }
        const providerId = attemptParsed.data.provider.toString().trim().toLowerCase();
        const expectedCallbackProviderId = attemptParsed.data.callbackProvider?.toString().trim().toLowerCase()
            ?? providerId;
        if (!providerId || expectedCallbackProviderId !== callbackProviderId) {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        const attemptAdmission = attemptParsed.data.securityBinding?.admission;
        if (attemptAdmission?.kind === "team_jit_identity" && attemptAdmission.authAttemptId !== sid) {
            // JIT authority is minted by the state-attempt owner. Preserve that
            // exact attempt identity when the callback turns the consumed state
            // into a pending finalization; do not accept a merely same-Team source.
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        const attemptPurpose = attemptParsed.data.securityBinding?.purpose
            ?? attemptParsed.data.purpose
            ?? null;
        if (
            attemptParsed.data.securityBinding
            && attemptParsed.data.securityBinding.purpose !== (attemptParsed.data.purpose ?? null)
            && attemptParsed.data.purpose !== undefined
        ) {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        const statePurpose = oauthState.purpose ?? null;
        const flowFromState = oauthState.flow;
        const isAccountSecurityAttempt = attemptPurpose === "account_encryption_first_key"
            || attemptPurpose === "account_password_enrollment";
        const isAccountSecurityState = statePurpose === "account_encryption_first_key"
            || statePurpose === "account_password_enrollment";
        if (
            (isAccountSecurityAttempt || isAccountSecurityState)
            && (
                !isAccountSecurityAttempt
                || !isAccountSecurityState
                || statePurpose !== attemptPurpose
                || oauthState.userId !== attemptParsed.data.userId
                || oauthState.proofHash !== attemptParsed.data.proofHash
                || oauthState.requestDigest !== attemptParsed.data.requestDigest
            )
        ) {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, {
                flow: oauthState.flow,
                error: "invalid_state",
            }));
        }
        const isIdentityConnectionTest = attemptPurpose === "identity_connection_test";
        const isTeamAdmission = attemptPurpose === "team_admission";
        // A Team-admission state and its server-written attempt must name the same
        // journey. `createOauthStateToken` models the purpose only for the
        // provisioning (`auth`) shape, where no Account exists yet; the
        // authenticated connect start proves the same journey through that token's
        // required `userId` and the `sid` this callback used to reach the attempt.
        // A state that does name the purpose must still match in either flow.
        if (statePurpose === "team_admission"
            ? !isTeamAdmission
            : isTeamAdmission && flowFromState === "auth") {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, {
                flow: oauthState.flow,
                error: "invalid_state",
            }));
        }
        const isGitHubAppInstallationVerification =
            attemptPurpose === "github_app_installation_verification";
        const isGitHubAppManifestSetup = attemptPurpose === "github_app_manifest_setup";

        const isFirstKeyStepUp = oauthState.purpose === "account_encryption_first_key"
            || oauthState.purpose === "account_password_enrollment";
        const isAccountDirectory =
            oauthState.purpose === "account_directory";
        const accountDirectoryTarget = isAccountDirectory
            && attemptParsed.data.purpose === "account_directory"
            && typeof attemptParsed.data.endpointUrl === "string"
            && attemptParsed.data.endpointUrl === oauthState.endpointUrl
            && typeof attemptParsed.data.endpointServerIdentityId === "string"
            && attemptParsed.data.endpointServerIdentityId
                === oauthState.endpointServerIdentityId
            && typeof attemptParsed.data.canonicalServerUrl === "string"
            && attemptParsed.data.canonicalServerUrl
                === oauthState.canonicalServerUrl
                ? {
                    endpointUrl: attemptParsed.data.endpointUrl,
                    endpointServerIdentityId:
                        attemptParsed.data.endpointServerIdentityId,
                    canonicalServerUrl:
                        attemptParsed.data.canonicalServerUrl,
                }
                : null;
        const accountDirectoryTargetIsCurrent = accountDirectoryTarget
            ? await isCurrentAccountDirectoryOAuthTarget(
                accountDirectoryTarget,
                requestHomeEnv,
            )
            : false;
        if (
            isAccountDirectory !==
                (attemptParsed.data.purpose === "account_directory")
            || (isAccountDirectory && !accountDirectoryTarget)
            || (accountDirectoryTarget && !accountDirectoryTargetIsCurrent)
        ) {
            return reply.redirect(buildRedirectUrl(fallbackWebAppUrl, {
                flow: oauthState.flow,
                error: "invalid_state",
            }));
        }

        const webAppUrl =
            typeof attemptParsed.data.webAppOAuthReturnUrl === "string" && attemptParsed.data.webAppOAuthReturnUrl.trim()
                ? attemptParsed.data.webAppOAuthReturnUrl.trim()
                : fallbackWebAppUrl;

        const flow = oauthState.flow;
        const authMode = flow === "auth" && oauthState.publicKey ? "keyed" : flow === "auth" ? "keyless" : null;
        const redirectBaseParams: Record<string, string> =
            isFirstKeyStepUp
                ? {
                    flow,
                    mode: "keyless",
                    purpose: oauthState.purpose!,
                }
                : accountDirectoryTarget
                    ? {
                        flow,
                        mode: authMode!,
                        purpose: "account_directory",
                        credentialTarget: "account_directory",
                        endpointUrl: accountDirectoryTarget.endpointUrl,
                        endpointServerIdentityId:
                            accountDirectoryTarget.endpointServerIdentityId,
                        canonicalServerUrl:
                            accountDirectoryTarget.canonicalServerUrl,
                    }
                : isIdentityConnectionTest
                    ? { flow, purpose: "identity_connection_test" }
                : isTeamAdmission
                    ? { flow, purpose: "team_admission", admissionReference: sid }
                : isGitHubAppInstallationVerification
                    ? { flow, purpose: "github_app_installation_verification" }
                : isGitHubAppManifestSetup
                    ? { flow, purpose: "github_app_manifest_setup" }
                : flow === "auth" && authMode === "keyless"
                    ? { flow, mode: "keyless" }
                    : { flow };

        // Every current authenticated identity link completes through its pending
        // finalizer. An in-flight attempt from an older writer cannot silently
        // regain the retired callback-side mutation path.
        if (
            flow === "connect"
            && (attemptPurpose === null || isTeamAdmission)
            && attemptParsed.data.connectFinalization !== "credential_adoption_v1"
        ) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_state" }));
        }

        if (isGitHubAppManifestSetup) {
            const binding = attemptParsed.data.githubAppManifestSetup;
            const userId = oauthState.userId;
            if (
                flow !== "connect"
                || oauthState.purpose !== "github_app_manifest_setup"
                || !userId
                || !binding
                || attemptParsed.data.securityBinding !== undefined
            ) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: "invalid_state",
                }));
            }
            if (oauthError) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: oauthError,
                }));
            }
            if (!code) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: "missing_code",
                }));
            }
            const completed = await completeGitHubAppManifestSetup({
                // The server stamped these facts on the request that started
                // the setup; the redirect itself carries no Happier credential.
                ...binding.authentication,
                actorAccountId: userId,
                owner: binding.owner,
                code,
                env: requestHomeEnv,
            });
            if (completed.status !== "created") {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: completed.status === "forbidden"
                        ? "github_app_forbidden"
                        : completed.status,
                }));
            }
            const continuationPersisted = await persistGitHubAppManifestSetupContinuation({
                sid,
                expiresAt: attempt.expiresAt,
                actorAccountId: userId,
                owner: binding.owner,
                ...(binding.authentication ? { authentication: binding.authentication } : {}),
                registration: completed.registration,
            });
            if (!continuationPersisted) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: "github_app_not_configured",
                }));
            }
            return reply.redirect(buildRedirectUrl(webAppUrl, {
                ...redirectBaseParams,
                created: "1",
                registrationId: completed.registration.id,
            }));
        }

        if (isGitHubAppInstallationVerification) {
            const binding = attemptParsed.data.githubAppInstallationVerification;
            const userId = oauthState.userId;
            if (
                flow !== "connect"
                || oauthState.purpose !== "github_app_installation_verification"
                || !userId
                || !binding
                || attemptParsed.data.securityBinding !== undefined
            ) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: "invalid_state",
                }));
            }
            if (oauthError) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: oauthError,
                }));
            }
            if (!code) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: "missing_code",
                }));
            }
            const resolved = await resolveGitHubAppInstallationVerificationOAuth({
                ...binding.authentication,
                actorAccountId: userId,
                binding,
                env: requestHomeEnv,
            });
            if (resolved.status !== "ready") {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: resolved.status === "forbidden" || resolved.status === "not_found"
                        ? "github_app_forbidden"
                        : resolved.status === "github_network_policy_changed"
                            ? resolved.status
                            : resolved.status === "github_enterprise_origin_not_approved"
                                ? resolved.status
                                : "auth_provider_configuration_changed",
                }));
            }
            try {
                const exchanged = await exchangeOAuthCodeForProfile({
                    provider: resolved.provider,
                    env: requestHomeEnv,
                    code,
                    state,
                    iss,
                    pkceCodeVerifier: attemptParsed.data.pkceCodeVerifier,
                    expectedNonce: attemptParsed.data.nonce,
                });
                const profile = parseManagedGitHubUserProfile(exchanged.profile);
                const verified = await verifyGitHubAppInstallationWithAdministratorProfile({
                    ...binding.authentication,
                    actorAccountId: userId,
                    owner: binding.owner,
                    registrationId: binding.registrationId,
                    expectedRegistrationRevision: binding.registrationRevision,
                    expectedRegistrationSecurityRevision: binding.registrationSecurityRevision,
                    expectedInstallationRevision: binding.installationRevision,
                    expectedNetworkPolicyFingerprint: binding.networkPolicyFingerprint,
                    githubInstallationId: BigInt(binding.githubInstallationId),
                    githubOrganizationId: BigInt(binding.githubOrganizationId),
                    administrator: {
                        githubUserId: BigInt(profile.id),
                        githubUserLogin: profile.login,
                    },
                });
                if (verified.status !== "verified") {
                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        error: verified.status === "registration_revision_conflict"
                            ? "auth_provider_configuration_changed"
                            : verified.status,
                    }));
                }
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    verified: "1",
                    registrationId: binding.registrationId,
                    installationId: verified.installation.id,
                }));
            } catch {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: "github_administrator_evidence_unavailable",
                }));
            }
        }

        const boundRuntime = await resolveOAuthSecurityBinding({
            env: requestHomeEnv,
            providerId,
            binding: attemptParsed.data.securityBinding,
            purpose: attemptPurpose,
            stage: "oauth_callback",
        });
        if (!boundRuntime) {
            return reply.redirect(buildRedirectUrl(webAppUrl, {
                ...redirectBaseParams,
                error: "auth_provider_configuration_changed",
            }));
        }
        const { provider, securityBinding } = boundRuntime;
        if (isAccountDirectory && securityBinding.provider.source === "managed") {
            return reply.redirect(buildRedirectUrl(webAppUrl, {
                ...redirectBaseParams,
                error: "auth_provider_configuration_changed",
            }));
        }
        const effectiveHomeMethods = securityBinding.provider.context.kind === "home"
            ? await resolveEffectiveHomeAuthMethods({ env: requestHomeEnv })
            : null;
        const isHomeActionEnabled = (
            actionId: "login" | "provision",
            mode: "keyed" | "keyless",
        ): boolean => effectiveHomeMethods?.status === "ready"
            && effectiveHomeMethods.decisions.some((decision) =>
                decision.id === providerId
                && decision.actions.some((action) =>
                    action.id === actionId
                    && action.enabled
                    && (action.mode === mode || action.mode === "either")));
        if (
            flow === "auth"
            && authMode === "keyless"
            && !isTeamAdmission
            && !isFirstKeyStepUp
            && !isAccountDirectory
        ) {
            const keyedAllowed = isHomeActionEnabled("provision", "keyed");
            const keylessAllowed = isHomeActionEnabled("login", "keyless");
            const availability = resolveKeylessAccountsAvailability(requestHomeEnv);
            const keylessConfig = readAuthOauthKeylessFeatureEnv(requestHomeEnv);
            const keylessConfigured = keylessConfig.enabled
                && keylessConfig.providers.includes(providerId);
            if (!availability.ok && keylessConfigured && !keyedAllowed) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: availability.reason === "e2ee-required" ? "e2ee_required" : "keyless_disabled",
                }));
            }
            if (!keylessAllowed && !keyedAllowed) {
                return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "keyless_disabled" }));
            }
        }

        if (oauthError) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: oauthError }));
        }

        const userId =
            flow === "connect" || isFirstKeyStepUp
                ? oauthState.userId
                : null;
        const publicKeyHex = flow === "auth" ? oauthState.publicKey : null;
        const proofHash = flow === "auth" ? oauthState.proofHash : null;
        if (flow === "connect" && !userId) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_state" }));
        }
        if (
            isFirstKeyStepUp
            && (
                !userId
                || !oauthState.requestDigest
                || !proofHash
            )
        ) {
            return reply.redirect(buildRedirectUrl(webAppUrl, {
                ...redirectBaseParams,
                error: "invalid_state",
            }));
        }
        if (flow === "auth" && authMode === "keyed" && !publicKeyHex) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_state" }));
        }
        if (flow === "auth" && authMode === "keyless" && !proofHash) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_state" }));
        }

        if (!code) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "missing_code" }));
        }

        try {
            const { accessToken, refreshToken, profile } = await exchangeOAuthCodeForProfile({
                provider,
                env: requestHomeEnv,
                code,
                state,
                iss,
                pkceCodeVerifier: attemptParsed.data.pkceCodeVerifier,
                expectedNonce: attemptParsed.data.nonce,
            });
            // The upstream exchange is outside the transaction that resolved the
            // attempt. No purpose may retain success from a replaced runtime.
            if (!await resolveOAuthSecurityBinding({
                env: requestHomeEnv, providerId, binding: securityBinding,
                purpose: securityBinding.purpose, stage: "oauth_callback",
            })) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams, error: "auth_provider_configuration_changed",
                }));
            }
            const login = provider.getLogin(profile) ?? "";

            if (isIdentityConnectionTest) {
                if (flow !== "connect" || !userId || securityBinding.purpose !== "identity_connection_test") {
                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        error: "invalid_state",
                    }));
                }
                const providerUserId = provider.getProviderUserId(profile);
                if (!providerUserId) {
                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        error: "invalid_profile",
                    }));
                }
                const expiresAt = new Date(Math.min(
                    attempt.expiresAt.getTime(),
                    Date.now() + resolveOAuthPendingTtlMsFromEnv(requestHomeEnv),
                ));
                const result = await createIdentityConnectionTestResult({
                    initiatorAccountId: userId,
                    securityBinding,
                    providerUserId,
                    diagnostics: await describeIdentityConnectionTestDiagnostics({
                        provider,
                        env: requestHomeEnv,
                        profile,
                        securityBinding,
                    }),
                    testedAt: new Date(),
                    expiresAt,
                });
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    resultHandle: result.resultHandle,
                }));
            }

            if (isFirstKeyStepUp) {
                const providerUserId =
                    provider.getProviderUserId(profile);
                if (!providerUserId) {
                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        error: "invalid_profile",
                    }));
                }
                const linkedIdentity =
                    await db.accountIdentity.findFirst({
                        where: {
                            accountId: userId!,
                            provider: providerId,
                            providerUserId,
                        },
                        select: { id: true },
                    });
                if (!linkedIdentity) {
                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        error: "wrong_identity",
                    }));
                }
                const pendingKey =
                    `oauth_pending_${randomKeyNaked(24)}`;
                const ttlMs =
                    resolveOAuthPendingTtlMsFromEnv(requestHomeEnv);
                await db.repeatKey.create({
                    data: {
                        key: pendingKey,
                        value: JSON.stringify({
                            v: 3,
                            flow: "auth",
                            purpose: oauthState.purpose!,
                            provider: providerId,
                            securityBinding,
                            userId: userId!,
                            providerUserId,
                            proofHash: proofHash!,
                            requestDigest:
                                oauthState.requestDigest!,
                        }),
                        expiresAt:
                            new Date(Date.now() + ttlMs),
                    },
                });
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    pending: pendingKey,
                }));
            }

            if (flow === "auth") {
                const providerUserId = provider.getProviderUserId(profile);
                let pendingSecurityBinding = securityBinding;
                if (isTeamAdmission
                    && providerUserId
                    && securityBinding.provider.context.kind === "team"
                    && securityBinding.connection) {
                    const teamId = securityBinding.provider.context.teamId;
                    const team = await db.team.findUnique({
                        where: { id: teamId },
                        select: { admissionMode: true },
                    });
                    if (team?.admissionMode === "provisioned") {
                        const exactSourceIdentity = provider.getDirectoryIdentityMatch?.(profile) ?? null;
                        const matches = exactSourceIdentity
                            ? await inTx((tx) => readDirectoryProvisionedIdentityCandidatesInTx(tx, {
                                teamId,
                                match: exactSourceIdentity,
                            }))
                            : [];
                        pendingSecurityBinding = {
                            ...securityBinding,
                            admission: matches.length === 1 ? {
                                kind: "team_provisioned_identity",
                                teamId,
                                providerId,
                                connectionId: securityBinding.connection.id,
                                connectionRevision: securityBinding.connection.revision,
                                admissionMode: "provisioned",
                                provisionedIdentityId: matches[0]!.id,
                            } : null,
                        };
                    }
                }
                const alreadyLinked = providerUserId
                    ? await db.accountIdentity.findFirst({
                          where: {
                              provider: providerId,
                              providerUserId,
                          },
                          select: { id: true, accountId: true },
                      })
                    : null;
                const isAlreadyLinked = Boolean(alreadyLinked);

                const loginUsername = login ? login.toLowerCase() : null;
                let suggestedUsername: string | null = null;
                let usernameRequired = false;
                let usernameReason: "invalid_login" | "login_taken" | null = null;

                if (loginUsername) {
                    const loginValidation = validateUsername(loginUsername, requestHomeEnv);
                    if (!loginValidation.ok) {
                        if (!isAlreadyLinked) {
                            usernameRequired = true;
                            usernameReason = "invalid_login";
                        }
                    } else {
                        suggestedUsername = loginValidation.username;
                        if (!isAlreadyLinked) {
                            const taken = await db.account.findFirst({
                                where: { username: suggestedUsername },
                                select: { id: true },
                            });
                            if (taken) {
                                usernameRequired = true;
                                usernameReason = "login_taken";
                            }
                        }
                    }
                } else {
                    if (!isAlreadyLinked) {
                        usernameRequired = true;
                        usernameReason = "invalid_login";
                    }
                }

                const pendingKey = `oauth_pending_${randomKeyNaked(24)}`;
                let profileJson = "";
                try {
                    profileJson = JSON.stringify(profile);
                } catch {
                    return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_profile" }));
                }

                if (authMode === "keyless") {
                    const tokenEnc = provider.accessTokenCustody === "identity_proof_only"
                        ? undefined
                        : privacyKit.encodeBase64(
                            encryptString(["auth", "external", providerId, "pending_v2", pendingKey, "token"], accessToken),
                        );
                    const profileEnc = privacyKit.encodeBase64(
                        encryptString(["auth", "external", providerId, "pending_v2", pendingKey, "profile"], profileJson),
                    );
                    const refreshTokenEnc =
                        typeof refreshToken === "string" && refreshToken.trim()
                            ? privacyKit.encodeBase64(
                                  encryptString(
                                      ["auth", "external", providerId, "pending_v2", pendingKey, "refresh"],
                                      refreshToken,
                                  ),
                              )
                            : undefined;
                    const ttlMs = resolveOAuthPendingTtlMsFromEnv(requestHomeEnv);
                    await db.repeatKey.create({
                        data: {
                            key: pendingKey,
                            value: JSON.stringify({
                                v: 2,
                                ...(accountDirectoryTarget
                                    ? {
                                        authMode: "keyless",
                                        purpose: "account_directory",
                                        ...accountDirectoryTarget,
                                    }
                                    : {}),
                                flow: "auth",
                                provider: providerId,
                                securityBinding: pendingSecurityBinding,
                                proofHash: proofHash!,
                                profileEnc,
                                ...(tokenEnc ? { accessTokenEnc: tokenEnc } : {}),
                                ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
                                suggestedUsername,
                                usernameRequired,
                                usernameReason,
                            }),
                            expiresAt: new Date(Date.now() + ttlMs),
                        },
                    });

                    if (accountDirectoryTarget) {
                        // Do not change authentication mode inside a live
                        // continuation. An unlinked keyless Directory attempt
                        // is completed once with the typed keyed-required
                        // result; the client then starts a fresh keyed attempt.
                        return reply.redirect(buildRedirectUrl(webAppUrl, {
                            ...redirectBaseParams,
                            pending: pendingKey,
                        }));
                    }

                    const encryptionEnv = readEncryptionFeatureEnv(requestHomeEnv);
                    const availability = resolveKeylessAccountsAvailability(requestHomeEnv);

                    const provisioningModes = (() => {
                        const modes: Array<{ value: "plain" | "e2ee"; mode: "keyed" | "keyless" }> = [];
                        const canProvisionPlain =
                            isHomeActionEnabled("provision", "keyless") &&
                            availability.ok &&
                            encryptionEnv.storagePolicy !== "required_e2ee";
                        if (canProvisionPlain) modes.push({ value: "plain", mode: "keyless" });
                        const canProvisionE2ee =
                            isHomeActionEnabled("provision", "keyed") &&
                            encryptionEnv.storagePolicy !== "plaintext_only";
                        if (canProvisionE2ee) modes.push({ value: "e2ee", mode: "keyed" });
                        return modes
                            .filter((entry) => {
                                return !shouldDenyPublicSignupProvisioningAction({
                                    env: requestHomeEnv,
                                    requestIp: request.ip,
                                    methodId: providerId,
                                    mode: entry.mode,
                                });
                            })
                            .map((entry) => entry.value)
                            .join(",");
                    })();

                    const redirectParams: Record<string, string> = {
                        ...redirectBaseParams,
                        storagePolicy: encryptionEnv.storagePolicy,
                        ...(isAlreadyLinked ? {} : { provisioning: "required", provisioningModes }),
                    };
                    if (isAlreadyLinked && alreadyLinked?.accountId) {
                        const account = await db.account.findUnique({
                            where: { id: alreadyLinked.accountId },
                            select: {
                                publicKey: true,
                                encryptionMode: true,
                                contentPublicKey: true,
                                contentPublicKeySig: true,
                            },
                        });
                        if (account) {
                            const currentness =
                                deriveAccountEncryptionCurrentnessFromRow(
                                    account,
                                );
                            redirectParams.accountMode =
                                currentness.status === "ready"
                                    ? currentness.currentness
                                        .encryptionMode
                                    : "e2ee";
                        }
                    }

                    if (usernameRequired) {
                        return reply.redirect(buildRedirectUrl(webAppUrl, {
                            ...redirectParams,
                            status: "username_required",
                            reason: usernameReason ?? "invalid_login",
                            login,
                            pending: pendingKey,
                        }));
                    }
                    return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectParams, pending: pendingKey }));
                }

                const tokenEnc = provider.accessTokenCustody === "identity_proof_only"
                    ? undefined
                    : privacyKit.encodeBase64(
                        encryptString(["auth", "external", providerId, "pending", pendingKey, publicKeyHex!], accessToken),
                    );
                const profileEnc = privacyKit.encodeBase64(
                    encryptString(["auth", "external", providerId, "pending", pendingKey, publicKeyHex!, "profile"], profileJson),
                );
                const refreshTokenEnc =
                    typeof refreshToken === "string" && refreshToken.trim()
                        ? privacyKit.encodeBase64(
                              encryptString(
                                  ["auth", "external", providerId, "pending", pendingKey, publicKeyHex!, "refresh"],
                                  refreshToken,
                              ),
                          )
                        : undefined;
                const ttlMs = resolveOAuthPendingTtlMsFromEnv(requestHomeEnv);
                await db.repeatKey.create({
                    data: {
                        key: pendingKey,
                        value: JSON.stringify({
                            ...(accountDirectoryTarget
                                ? {
                                    v: 2,
                                    authMode: "keyed",
                                    purpose: "account_directory",
                                    ...accountDirectoryTarget,
                                }
                                : {}),
                            flow: "auth",
                            provider: providerId,
                            securityBinding: pendingSecurityBinding,
                            publicKeyHex: publicKeyHex!,
                            profileEnc,
                            ...(tokenEnc ? { accessTokenEnc: tokenEnc } : {}),
                            ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
                            suggestedUsername,
                            usernameRequired,
                            usernameReason,
                        }),
                        expiresAt: new Date(Date.now() + ttlMs),
                    },
                });

                if (usernameRequired) {
                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        status: "username_required",
                        reason: usernameReason ?? "invalid_login",
                        login,
                        pending: pendingKey,
                    }));
                }

                return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, pending: pendingKey }));
            }

            const account = await db.account.findUnique({
                where: { id: userId! },
                select: { username: true },
            });
            const existingUsername = account?.username?.toString().trim() || null;

            const loginUsername = login ? login.toLowerCase() : null;
            if (!existingUsername) {
                let requireUsername = false;
                let usernameReason: "invalid_login" | "login_taken" | null = null;

                if (!loginUsername) {
                    requireUsername = true;
                    usernameReason = "invalid_login";
                } else {
                    const loginValidation = validateUsername(loginUsername, requestHomeEnv);
                    if (!loginValidation.ok) {
                        requireUsername = true;
                        usernameReason = "invalid_login";
                    } else {
                        const taken = await db.account.findFirst({
                            where: { username: loginValidation.username },
                            select: { id: true },
                        });
                        if (taken) {
                            requireUsername = true;
                            usernameReason = "login_taken";
                        }
                    }
                }

                if (requireUsername) {
                    const pendingKey = await createConnectPending({
                        providerId,
                        userId: userId!,
                        securityBinding,
                        profile,
                        accessToken,
                        ...(refreshToken ? { refreshToken } : {}),
                        retainAccessToken: provider.accessTokenCustody !== "identity_proof_only",
                    });

                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        status: "username_required",
                        reason: usernameReason ?? "invalid_login",
                        login,
                        pending: pendingKey,
                    }));
                }
            }

            if (!await resolveOAuthSecurityBinding({
                env: requestHomeEnv, providerId, binding: securityBinding,
                purpose: securityBinding.purpose, stage: "oauth_finalize",
            })) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams, error: "auth_provider_configuration_changed",
                }));
            }
            const username = existingUsername ?? loginUsername;
            if (!username) {
                return reply.redirect(buildRedirectUrl(webAppUrl, {
                    ...redirectBaseParams,
                    error: "invalid_profile",
                }));
            }
            const pendingKey = await createConnectPending({
                providerId,
                userId: userId!,
                securityBinding,
                profile,
                accessToken,
                ...(refreshToken ? { refreshToken } : {}),
                retainAccessToken: provider.accessTokenCustody !== "identity_proof_only",
            });
            return reply.redirect(buildRedirectUrl(webAppUrl, {
                ...redirectBaseParams,
                status: "connected",
                login,
                username,
                pending: pendingKey,
            }));
        } catch (error: unknown) {
            const rawCode = error instanceof Error ? error.message : "server_error";
            const code = rawCode === "auth_provider_unavailable" ? "auth_provider_configuration_changed" : rawCode;
            const safe =
                code === "missing_access_token" ||
                code === "invalid_profile" ||
                code === "profile_fetch_failed" ||
                code === "not-eligible" ||
                code === "auth_provider_configuration_changed" ||
                code === "workos_organization_mismatch" ||
                code === "workos_connection_mismatch" ||
                code === "workos_platform_unavailable" ||
                code === "team_identity_not_configured" ||
                code === OAUTH_NOT_CONFIGURED_ERROR
                    ? code
                    : "server_error";
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: safe }));
        }
    });
}
