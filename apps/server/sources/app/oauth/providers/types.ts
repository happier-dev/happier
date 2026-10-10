import type { DirectoryProvisionedIdentityMatch } from "@/app/teams/directory/provisionedIdentityBinding";

export type OAuthProviderStatus = Readonly<{
    enabled: boolean;
    configured: boolean;
}>;

export type OAuthTokenExchangeResult = Readonly<{
    accessToken: string;
    /** Provider-validated profile when the upstream exchange returns it atomically with the token. */
    profile?: unknown;
    idToken?: string;
    idTokenClaims?: unknown;
    refreshToken?: string;
}>;

export type OAuthFlowProvider = Readonly<{
    id: string;
    /**
     * Stable callback route registered with an upstream shared application.
     * The persisted attempt still carries the exact provider instance ID.
     */
    callbackProviderId?: string;
    /** Exact scoped connection that the catalog used to construct this runtime. */
    connectionBinding?: Readonly<{ id: string; revision: number }>;
    /**
     * Declared custody of the access token this provider exchanges.
     *
     * `identity_proof_only` means the token's whole purpose was the callback's own profile
     * read: the identity binder stores no token for it (`githubManagedIdentityProvider`
     * links with `token: null`), so the short-lived OAuth continuation row must not retain
     * one either. Providers that omit this keep the token in the continuation because a
     * later eligibility or profile read decrypts it (`github/githubConnect`,
     * `github/loginEligibility`).
     */
    accessTokenCustody?: "identity_proof_only";
    resolveStatus: (env: NodeJS.ProcessEnv) => OAuthProviderStatus;
    isConfigured: (env: NodeJS.ProcessEnv) => boolean;
    resolveRedirectUrl: (env: NodeJS.ProcessEnv) => string | null;
    resolveScope: (params: { env: NodeJS.ProcessEnv; flow: "auth" | "connect" }) => string;
    /** Performs provider-specific, non-mutating runtime validation when administration exposes it. */
    validateConfiguration?: (params: { env: NodeJS.ProcessEnv }) => Promise<void>;
    resolveAuthorizeUrl: (params: {
        env: NodeJS.ProcessEnv;
        state: string;
        scope: string;
        codeChallenge?: string;
        codeChallengeMethod?: "S256";
        nonce?: string;
    }) => Promise<string>;
    exchangeCodeForAccessToken: (params: {
        env: NodeJS.ProcessEnv;
        code: string;
        state?: string;
        iss?: string;
        pkceCodeVerifier?: string;
        expectedNonce?: string;
    }) => Promise<OAuthTokenExchangeResult>;
    fetchProfile: (params: {
        env: NodeJS.ProcessEnv;
        accessToken: string;
        idToken?: string;
        idTokenClaims?: unknown;
    }) => Promise<unknown>;
    getLogin: (profile: unknown) => string | null;
    getProviderUserId: (profile: unknown) => string | null;
    /** Exact directory correlation shared with this provider's identity binder. */
    getDirectoryIdentityMatch?: (profile: unknown) => DirectoryProvisionedIdentityMatch | null;
    /**
     * Safe normalized evidence for an initiating administrator; never raw claims or credentials.
     *
     * `groups.values` are the provider's canonical external Group keys. They stay inside the
     * server: the sanitized administrator result reports only a count, and the exact Team
     * connection's mappings are resolved through
     * `app/teams/memberships/identityConnectionGroupRefresh#selectMatchingExternalGroupIds`,
     * the same comparison sign-in Group refresh uses.
     */
    describeIdentityTest?: (params: { env: NodeJS.ProcessEnv; profile: unknown }) => Promise<Readonly<{
        subjectPresent: boolean;
        loginAvailable: boolean;
        emailAvailable: boolean;
        emailVerified: boolean;
        groups: Readonly<{ state: "complete"; values: readonly string[] }>
            | Readonly<{ state: "absent" | "incomplete" }>;
        eligibility: Readonly<{
            status: "eligible" | "ineligible";
            rules: readonly Readonly<{ kind: "users" | "email_domains" | "groups_any" | "groups_all"; matched: boolean }>[];
        }>;
    }>>;
}>;
