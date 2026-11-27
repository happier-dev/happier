import { z } from "zod/mini";
import { z as mini } from 'zod/mini';
import { supporterGitHubAttemptSchema } from "@/app/supporter/supporterPerks";
import { AccountEncryptionMigrateExternalAuthBindingDigestV1Schema } from '@happier-dev/protocol/account/encryptionMigrate';
import { ManagedGitHubAppOwnerV1Schema } from '@happier-dev/protocol/identity/githubApps';
import { PasswordCredentialMutationDigestV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { GitHubAppManagementAuthenticationV1Schema } from "@/app/integrations/github/githubManagedApp";
import { ProviderReferenceSchema } from "@/app/auth/providers/providerReference";
import { teamOAuthAdmissionSourceSchema } from "@/app/teams/memberships/teamOAuthAdmissionSource";

export const oauthSecurityBindingSchema = z.strictObject({
    provider: ProviderReferenceSchema,
    connection: z.nullable(z.strictObject({
        id: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
        revision: z.number().check(z.int(), z.positive()),
    })),
    admission: z.nullable(teamOAuthAdmissionSourceSchema),
    purpose: z.nullable(z.enum([
        "account_directory",
        "account_encryption_first_key",
        "account_password_enrollment",
        "team_admission",
        "identity_connection_test",
    ])),
}).check(z.superRefine((value, context) => {
    if (value.purpose !== "team_admission" && value.admission !== null) {
        context.addIssue({
            code: "custom",
            path: ["admission"],
            message: "Team admission authority requires the Team admission purpose",
        });
    }
}));

export type OAuthSecurityBinding = z.infer<typeof oauthSecurityBindingSchema>;

/** A malformed new binding must never be interpreted as a released missing-reference record. */
export function hasInvalidOAuthSecurityBinding(value: unknown): boolean {
    return value !== null && typeof value === "object" && "securityBinding" in value
        && !oauthSecurityBindingSchema.safeParse(value.securityBinding).success;
}

export const oauthStateAttemptSchema = z.strictObject({
    provider: z.string(),
    callbackProvider: z.optional(z.string()),
    securityBinding: z.optional(oauthSecurityBindingSchema),
    pkceCodeVerifier: z.string(),
    nonce: z.string(),
    connectFinalization: z.optional(z.literal("credential_adoption_v1")),
    webAppOAuthReturnUrl: z.optional(z.string()),
    purpose: z.optional(z.enum([
        "account_directory",
        "team_admission",
        "identity_connection_test",
        "github_app_installation_verification",
        "github_app_manifest_setup",
        "supporter_github",
    ])),
    supporterGitHub: z.optional(supporterGitHubAttemptSchema),
    userId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    proofHash: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
    requestDigest: z.optional(z.union([
        AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
        PasswordCredentialMutationDigestV1Schema,
    ])),
    githubAppInstallationVerification: z.optional(z.strictObject({
        owner: ManagedGitHubAppOwnerV1Schema,
        registrationId: z.string().check(z.trim(), z.minLength(1)),
        registrationRevision: z.number().check(z.int(), z.positive()),
        registrationSecurityRevision: z.number().check(z.int(), z.positive()),
        installationRevision: z.number().check(z.int(), z.minimum(0)),
        networkPolicyFingerprint: z.string().check(z.trim(), z.minLength(1)),
        githubInstallationId: z.string().check(z.regex(/^[1-9][0-9]*$/u)),
        githubOrganizationId: z.string().check(z.regex(/^[1-9][0-9]*$/u)),
        authentication: mini.optional(GitHubAppManagementAuthenticationV1Schema),
    })),
    githubAppManifestSetup: z.optional(z.strictObject({
        owner: ManagedGitHubAppOwnerV1Schema,
        authentication: mini.optional(GitHubAppManagementAuthenticationV1Schema),
    })),
    endpointUrl: z.optional(z.string().check(z.url())),
    endpointServerIdentityId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    canonicalServerUrl: z.optional(z.string().check(z.url())),
}).check(z.superRefine((value, context) => {
    const isInstallationVerification = value.purpose === "github_app_installation_verification";
    const isManifestSetup = value.purpose === "github_app_manifest_setup";
    const isSupporterGitHub = value.purpose === "supporter_github";
    if (isSupporterGitHub !== (value.supporterGitHub !== undefined)
        || (isSupporterGitHub && (value.provider !== "github" || value.securityBinding !== undefined
            || value.callbackProvider !== undefined || value.connectFinalization !== undefined))) {
        context.addIssue({ code: "custom", message: "GitHub supporter purpose requires its exact binding" });
    }
    const boundPurpose = value.securityBinding?.purpose ?? value.purpose ?? null;
    const isAccountSecurityProof = boundPurpose === "account_encryption_first_key"
        || boundPurpose === "account_password_enrollment";
    const hasAccountSecurityProof = value.userId !== undefined
        || value.proofHash !== undefined
        || value.requestDigest !== undefined;
    if (isInstallationVerification !== (value.githubAppInstallationVerification !== undefined)) {
        context.addIssue({ code: "custom", message: "GitHub App installation purpose requires its exact binding" });
    }
    if (isManifestSetup !== (value.githubAppManifestSetup !== undefined)) {
        context.addIssue({ code: "custom", message: "GitHub App manifest purpose requires its exact binding" });
    }
    if (isAccountSecurityProof) {
        const digestSchema = boundPurpose === "account_password_enrollment"
            ? PasswordCredentialMutationDigestV1Schema
            : AccountEncryptionMigrateExternalAuthBindingDigestV1Schema;
        if (
            value.userId === undefined
            || value.proofHash === undefined
            || !digestSchema.safeParse(value.requestDigest).success
        ) {
            context.addIssue({ code: "custom", message: "Account-security purpose requires its exact proof binding" });
        }
    } else if (hasAccountSecurityProof) {
        context.addIssue({ code: "custom", message: "Account-security proof binding requires its purpose" });
    }
}));

export const connectPendingSchema = z.strictObject({
    flow: z.literal("connect"),
    provider: z.string(),
    securityBinding: z.optional(oauthSecurityBindingSchema),
    userId: z.string(),
    profileEnc: z.string(),
    /** Callback-proven automatic choice; absent retained/prompt continuations protect manual intent. */
    suggestedUsername: z.optional(z.string()),
    /**
     * Absent when the provider declared `accessTokenCustody: "identity_proof_only"`: the
     * continuation carries no token because nothing after the callback reads one.
     */
    accessTokenEnc: z.optional(z.string()),
    refreshTokenEnc: z.optional(z.string()),
});

const authPendingSharedSchema = z.object({
    flow: z.literal("auth"),
    provider: z.string(),
    securityBinding: z.optional(oauthSecurityBindingSchema),
    profileEnc: z.string(),
    /** See `connectPendingSchema`: an identity-proof-only provider persists no token. */
    accessTokenEnc: z.optional(z.string()),
    refreshTokenEnc: z.optional(z.string()),
    suggestedUsername: z.optional(z.nullable(z.string())),
    usernameRequired: z.optional(z.boolean()),
    usernameReason: z.optional(z.nullable(z.string())),
});

const authPendingLegacyKeylessSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(authPendingSharedSchema, {
    authMode: z.literal("keyless"),
    proofHash: z.string(),
}));

const authPendingLegacyKeyedSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(authPendingSharedSchema, {
    publicKeyHex: z.string(),
}));

const authPendingV2Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(authPendingSharedSchema, {
    v: z.literal(2),
    authMode: z.optional(z.enum(["keyed", "keyless"])),
    proofHash: z.optional(z.string()),
    publicKeyHex: z.optional(z.string()),
    purpose: z.optional(z.literal("account_directory")),
    endpointUrl: z.optional(z.string().check(z.url())),
    endpointServerIdentityId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    canonicalServerUrl: z.optional(z.string().check(z.url())),
})).check(z.superRefine((value, ctx) => {
    const isAccountDirectory = value.purpose === "account_directory";
    const hasEndpointUrl = value.endpointUrl !== undefined;
    const hasEndpointServerIdentityId =
        value.endpointServerIdentityId !== undefined;
    const hasCanonicalServerUrl = value.canonicalServerUrl !== undefined;
    if (
        isAccountDirectory !== hasEndpointUrl
        || isAccountDirectory !== hasEndpointServerIdentityId
        || isAccountDirectory !== hasCanonicalServerUrl
    ) {
        ctx.addIssue({
            code: "custom",
            message:
                "Account Directory pending state requires an exact endpoint binding",
        });
    }
    if (!isAccountDirectory) {
        if (
            value.authMode !== undefined
            || value.publicKeyHex !== undefined
            || !value.proofHash
        ) {
            ctx.addIssue({
                code: "custom",
                message: "Ordinary v2 pending state requires its proof binding",
            });
        }
        return;
    }
    if (
        value.authMode === "keyless"
        && value.proofHash
        && value.publicKeyHex === undefined
    ) {
        return;
    }
    if (
        value.authMode === "keyed"
        && value.publicKeyHex !== undefined
        && /^[0-9a-f]{64}$/i.test(value.publicKeyHex)
        && value.proofHash === undefined
    ) {
        return;
    }
    ctx.addIssue({
        code: "custom",
        message:
            "Account Directory pending state requires exactly one keyed or keyless binding",
    });
}));

export const authPendingSchema = z.union([
    authPendingV2Schema,
    authPendingLegacyKeylessSchema,
    authPendingLegacyKeyedSchema,
]);

export const accountEncryptionFirstKeyStepUpPendingSchema = z.strictObject({
        v: z.literal(3),
        flow: z.literal("auth"),
        purpose:
            z.literal("account_encryption_first_key"),
        provider: z.string().check(z.minLength(1)),
        credentialRevision: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(2_147_483_647))),
        nativeIdentityId: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
        securityBinding: z.optional(oauthSecurityBindingSchema),
        userId: z.string().check(z.minLength(1)),
        providerUserId: z.string().check(z.minLength(1)),
        proofHash: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
    }).check(z.refine(value => value.provider === "email_password"
        ? value.credentialRevision !== undefined && value.nativeIdentityId !== undefined && value.securityBinding === undefined
        : value.credentialRevision === undefined && value.nativeIdentityId === undefined));

export const accountPasswordEnrollmentStepUpPendingSchema = z.strictObject({
        v: z.literal(3),
        flow: z.literal("auth"),
        purpose: z.literal("account_password_enrollment"),
        provider: z.string().check(z.minLength(1)),
        securityBinding: oauthSecurityBindingSchema,
        userId: z.string().check(z.minLength(1)),
        providerUserId: z.string().check(z.minLength(1)),
        proofHash: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
        requestDigest: PasswordCredentialMutationDigestV1Schema,
    });

export const oauthAuthPendingSchema = z.union([
    authPendingSchema,
    accountEncryptionFirstKeyStepUpPendingSchema,
    accountPasswordEnrollmentStepUpPendingSchema,
]);
