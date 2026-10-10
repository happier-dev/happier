import type { ProviderModule } from "@/app/auth/providers/providerModules";
import type { OAuthFlowProvider } from "@/app/oauth/providers/types";
import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { AuthProviderFeatures, AuthProviderResolver } from "@/app/auth/providers/types";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import { prepareIdentityLink, unlinkIdentity } from "@/app/auth/providers/accountIdentityLifecycle";
import { bindDirectoryProvisionedIdentitiesInTx, type DirectoryProvisionedIdentityMatch } from "@/app/teams/directory/provisionedIdentityBinding";
import { inTx } from "@/storage/inTx";
import type { WorkosPlatformConfigResolution } from "@/app/integrations/workos/workosPlatform";

import {
    createWorkosOAuthAdapter,
    type WorkosTeamExternalReferenceV1,
} from "./workosOAuthAdapter";
import { normalizeAndValidateWorkosProfile } from "./normalizeAndValidateWorkosProfile";
import { normalizeVerifiedEmail } from "@happier-dev/protocol";

export type WorkosProviderModuleInput = Readonly<{
    providerInstanceId: string;
    displayName: string;
    enabled: boolean;
    redirectUrl: string;
    externalReference: Readonly<WorkosTeamExternalReferenceV1>;
    platform: WorkosPlatformConfigResolution;
    connectionBinding?: Readonly<{ id: string; revision: number }>;
    /**
     * The exact Team connection this module signs in through. Directory sources
     * hang off that same connection, so it is also the only scope in which a
     * provisioned person may be recognized as this Account.
     */
    teamConnection?: Readonly<{ teamId: string; connectionId: string }>;
}>;

export function resolveWorkosAuthProviderFeatures(
    input: Readonly<{ displayName: string; enabled: boolean; configured: boolean; scope?: "home" | "team" }>,
    policy: AuthPolicy,
): AuthProviderFeatures {
    return {
        enabled: input.enabled,
        configured: input.configured,
        ui: {
            displayName: input.displayName,
            iconHint: "workos",
            supportsProfileBadge: false,
        },
        restrictions: {
            usersAllowlist: false,
            orgsAllowlist: true,
            orgMatch: "any",
        },
        offboarding: {
            enabled: input.scope !== "home" && policy.offboarding.enabled,
            intervalSeconds: policy.offboarding.intervalSeconds,
            mode: policy.offboarding.mode,
            source: "workos_sso",
        },
    };
}

/**
 * Projects the durable, already-validated login stored with an Account identity.
 * This leaf deliberately needs neither provider secrets nor an active Team connection,
 * so linked identities remain presentable after a provider is disabled or offboarded.
 */
export function extractWorkosLinkedProvider(
    { providerLogin }: Parameters<IdentityProvider["extractLinkedProvider"]>[0],
): ReturnType<IdentityProvider["extractLinkedProvider"]> {
    return { displayName: providerLogin, avatarUrl: null, profileUrl: null };
}

export function createWorkosProviderModule(input: WorkosProviderModuleInput): ProviderModule {
    const oauthAdapter = createWorkosOAuthAdapter(input);
    const connectionId = input.externalReference.connectionId;
    const status = oauthAdapter.resolveStatus();

    function normalizeProfile(profile: unknown) {
        if (!connectionId) throw new Error("team_identity_not_configured");
        const normalized = normalizeAndValidateWorkosProfile({
            profile,
            expectedBinding: {
                organizationId: input.externalReference.organizationId,
                connectionId,
            },
        });
        if (!normalized.ok) throw new Error(normalized.error);
        return normalized.value;
    }

    function getDirectoryIdentityMatch(profile: unknown): DirectoryProvisionedIdentityMatch | null {
        if (!input.teamConnection) return null;
        return {
            kind: "workos_directory",
            teamIdentityConnectionId: input.teamConnection.connectionId,
            externalSubjectId: normalizeProfile(profile).idpId,
        };
    }

    const prepareConnect: IdentityProvider["prepareConnect"] = async (params) => {
        const profile = normalizeProfile(params.profile);
        const verifiedMailbox = normalizeVerifiedEmail(profile.email);
        const preparedIdentity = await prepareIdentityLink({
            accountId: params.ctx.uid,
            provider: input.providerInstanceId,
            providerUserId: profile.id,
            providerLogin: profile.email,
            profile: { ...profile },
            token: null,
            presentation: {
                username: params.preferredUsername?.trim().toLowerCase() || null,
            },
            transferFromAccountId: params.transferFromAccountId,
        });
        const teamConnection = input.teamConnection;
        const directoryMatch = getDirectoryIdentityMatch(profile);
        if (!teamConnection || !directoryMatch) return preparedIdentity;
        return {
            ...(verifiedMailbox ? { verifiedMailbox } : {}),
            connectInTx: async (tx) => {
                await preparedIdentity.connectInTx(tx);
                // The link above is the identity proof; the directory owner
                // decides on its own evidence whether a provisioned person is
                // recognized and whether that may become Team access yet.
                await bindDirectoryProvisionedIdentitiesInTx(tx, {
                    accountId: params.ctx.uid,
                    teamId: teamConnection.teamId,
                    match: directoryMatch,
                });
            },
        };
    };

    const identity: IdentityProvider = Object.freeze({
        id: input.providerInstanceId,
        prepareConnect,
        connect: async (params) => {
            const prepared = await prepareConnect(params);
            await inTx(prepared.connectInTx);
        },
        disconnect: async (params) => {
            await unlinkIdentity({ accountId: params.ctx.uid, provider: input.providerInstanceId });
        },
        extractLinkedProvider: extractWorkosLinkedProvider,
    });

    const auth: AuthProviderResolver = Object.freeze({
        id: input.providerInstanceId,
        resolveFeatures: ({ policy }) => resolveWorkosAuthProviderFeatures({
            displayName: input.displayName,
            enabled: status.enabled,
            configured: status.configured,
            scope: input.teamConnection ? "team" : "home",
        }, policy),
        requiresOAuth: true,
        isConfigured: () => status.configured,
        providerKind: "workos_sso",
    });

    const oauth: OAuthFlowProvider = Object.freeze({
            id: input.providerInstanceId,
            ...(input.connectionBinding ? { connectionBinding: input.connectionBinding } : {}),
            accessTokenCustody: "identity_proof_only",
            resolveStatus: () => oauthAdapter.resolveStatus(),
            isConfigured: () => oauthAdapter.resolveStatus().configured,
            resolveRedirectUrl: () => oauthAdapter.resolveRedirectUrl(),
            resolveScope: () => "",
            resolveAuthorizeUrl: async ({ state, codeChallenge, codeChallengeMethod }) => {
                if (!codeChallenge || !codeChallengeMethod) throw new Error("invalid_pkce");
                return await oauthAdapter.resolveAuthorizeUrl({ state, codeChallenge, codeChallengeMethod });
            },
            exchangeCodeForAccessToken: async ({ code, pkceCodeVerifier }) => {
                if (!pkceCodeVerifier) throw new Error("invalid_pkce");
                const exchanged = await oauthAdapter.exchangeCodeForProfile({ code, pkceCodeVerifier });
                return { accessToken: exchanged.accessToken, profile: exchanged.profile };
            },
            fetchProfile: async () => {
                throw new Error("profile_not_available_separately");
            },
            getLogin: (profile) => oauthAdapter.getLogin(profile),
            getProviderUserId: (profile) => oauthAdapter.getProviderUserId(profile),
            getDirectoryIdentityMatch,
        });

    return Object.freeze({
        id: input.providerInstanceId,
        oauth,
        identity,
        auth,
    }) satisfies ProviderModule;
}
