import * as privacyKit from "privacy-kit";
import { createHash, randomBytes } from "node:crypto";
import {
    AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
    AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS,
    PasswordCredentialMutationDigestV1Schema,
    AuthTokenProvenanceSchema,
    AuthTokenProvenanceV2Schema,
    readAuthTokenProvenance,
    parseAccountApiTokenBearerV1,
    AccountApiTokenCreateEncryptionV1Schema,
    AccountApiTokenEncryptionAccessV1Schema,
    AuthTokenAuthenticationEvidenceSnapshotV1Schema,
    ApiTokenGrantV1Schema,
    StoredApiTokenGrantV1Schema,
    API_TOKEN_FULL_GRANT_V1,
    EmbedConfigV1Schema,
    StoredEmbedConfigV1Schema,
    evaluateApiTokenGrantV1,
    isApiTokenGrantWithinV1,
    type ApiTokenGrantV1,
    type EmbedConfigV1,
    PluginContributionIdentityV1Schema,
    type AccountApiTokenCreateEncryptionV1,
    type AccountApiTokenEncryptionAccessV1,
    type AccountApiTokenEncryptionAccessResponseV1,
    type AccountStatusV1,
    type AuthTokenAuthority,
    type AuthTokenKind,
    type AuthTokenProvenanceAny,
    type AuthTokenAuthenticationEvidenceV1,
    type ParsedAccountApiTokenBearerV1,
} from "@happier-dev/protocol";
import {
    ExternalActionExecutionAuthorizationBindingV1Schema,
    ExternalActionExecutionAuthorizationV1Schema,
    formatQualifiedPluginActionId,
    parseQualifiedPluginActionId,
    type ExternalActionExecutionAuthorizationBindingV1,
    type ExternalActionExecutionAuthorizationV1,
} from "@happier-dev/protocol/actions";
import {
    VerifiedEphemeralSessionRunnerPrincipalSchema,
    type VerifiedEphemeralSessionRunnerPrincipal,
} from "@happier-dev/protocol/ephemeralRunner/principal";
import { db, getActivePrismaRuntime, isPrismaErrorCode } from "@/storage/db";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { assertAccountActive } from "./accountStatus";
import { isActiveHomeAccountStatus } from "@happier-dev/protocol";
import { inTx, type Tx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { LRUTtlMap } from "@/utils/collections/lru";
import { createSha256SecretDigest, sha256SecretDigestMatches } from "./secretDigest";
import {
    isOAuthStateUnavailableError,
    OAuthStateUnavailableError,
} from "./oauthStateErrors";
import {
    parseAuthenticationEvidenceSnapshot,
    resolveCurrentAuthenticationEvidenceInTx,
} from "./authenticationEvidence";
import { verifyCurrentMaterializedRunnerPrincipal } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { effectiveCredentialAuthority } from "./effectiveCredentialAuthority";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";

interface TokenGeneratorLike {
    new: (payload: Readonly<{
        user?: string;
        extras?: Readonly<Record<string, unknown>>;
    }>) => Promise<string>;
    publicKey: Uint8Array | number[];
}

interface TokenVerifierLike {
    verify: (token: string) => Promise<any>;
}

// Persistent tokens have no expiry. Retain this read-only compatibility window until an
// explicit token epoch or forced re-auth retires tokens issued by privacy-kit 0.0.25 on Bun.
const LEGACY_BUN_SEED_CANDIDATE_COUNT = 64;

interface AuthTokens {
    generator: TokenGeneratorLike;
    verifier: TokenVerifierLike;
}

interface OAuthStateTokens {
    oauthStateVerifier: TokenVerifierLike;
    oauthStateGenerator: TokenGeneratorLike;
}

type OAuthStatePayload = Readonly<{
    flow: "connect" | "auth";
    provider: string;
    sid?: string | null;
    userId?: string | null;
    publicKey?: string | null;
    proofHash?: string | null;
    purpose?: "account_encryption_first_key" | "account_password_enrollment" | "account_directory" | "team_admission" | "github_app_installation_verification" | "github_app_manifest_setup" | null;
    requestDigest?: string | null;
    endpointUrl?: string | null;
    endpointServerIdentityId?: string | null;
    canonicalServerUrl?: string | null;
}>;

type DecodedAuthToken = Readonly<{
    userId: string;
    extras?: unknown;
    tokenEpoch: number;
    provenance: AuthTokenProvenanceAny;
    legacy: boolean;
}>;

export type {
    AuthTokenAuthority,
    AuthTokenKind,
    AuthTokenProvenance,
} from "@happier-dev/protocol";

/** Backward-compatible server spelling retained for existing request callers. */
export type AuthAuthority = AuthTokenAuthority;

/** An explicit, complete mint decision; no endpoint, extras, or token shape
 * may infer it. The canonical kind/authority mapping is owned by the protocol
 * provenance schema. */
export type CreateTokenOptions = Readonly<{
    kind: AuthTokenKind;
    authority: AuthTokenAuthority;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

/**
 * Server-verified PAT facts that may be projected only for the lifetime of
 * the request that authenticated the bearer. The plaintext PAT never leaves
 * the authorization header boundary.
 */
export type VerifiedApiTokenPrincipal = Readonly<{
    accountId: string;
    principalId: string;
    credentialId: string;
    authority: "account_automation";
    expiresAt: Date | null;
    grant: ApiTokenGrantV1;
    parentTokenId: string | null;
    embedConfig: EmbedConfigV1 | null;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

export type VerifiedAuthToken = Readonly<{
    userId: string;
    /** Verified signed credential revocation selector; PATs have their own row lifecycle. */
    tokenEpoch?: number;
    extras?: unknown;
    /** Canonical server-verified credential kind from the signed marker. */
    authTokenKind: AuthTokenKind;
    /** Effective authority after current Account terminal policy. */
    authority: AuthTokenAuthority;
    /** Signed provenance floor, kept separate from effective invocation authority. */
    authTokenMintedAuthority?: AuthTokenAuthority;
    /** Current credentials may carry bounded server-produced authentication facts. */
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    /** True only when the credential was accepted through the named
     * pre-marker ordinary-Home reader. Central admission consumes this fact
     * to deny a legacy credential on Directory-opt-in routes; a current
     * signed or database-minted credential is never legacy. */
    legacy: boolean;
    apiTokenPrincipal?: VerifiedApiTokenPrincipal;
    ephemeralSessionRunnerPrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
}>;

export type AuthTokenVerificationDisposition =
    | Readonly<{ status: "verified"; credential: VerifiedAuthToken }>
    | Readonly<{ status: "invalid" }>
    | Readonly<{
        status: "rejected_restricted";
        authTokenKind: "ephemeral_session_runner";
    }>;

const REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL = {
    status: "rejected_restricted",
    authTokenKind: "ephemeral_session_runner",
} as const;

type AuthTokenInternalVerification =
    | VerifiedAuthToken
    | typeof REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL
    | null;

function isRejectedRestrictedCredential(
    value: AuthTokenInternalVerification,
): value is typeof REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL {
    return value !== null
        && "status" in value
        && value.status === "rejected_restricted";
}

async function verifyCurrentEphemeralSessionRunnerPrincipal(
    accountId: string,
    extras: unknown,
): Promise<VerifiedEphemeralSessionRunnerPrincipal | null> {
    if (typeof extras !== "object" || extras === null || Array.isArray(extras)) return null;
    const parsed = VerifiedEphemeralSessionRunnerPrincipalSchema.safeParse(
        (extras as Readonly<Record<string, unknown>>).ephemeralSessionRunnerPrincipal,
    );
    if (!parsed.success || parsed.data.accountId !== accountId) return null;
    return await verifyCurrentMaterializedRunnerPrincipal(parsed.data);
}

export type CreatedApiToken = Readonly<{
    tokenId: string;
    /** Plaintext is returned only from this mint result and is never persisted. */
    token: string;
    label: string;
    displayPrefix: string;
    createdAt: Date;
    expiresAt: Date | null;
    hasEncryptionAccess: boolean;
    hasUnattendedTeamAccess: boolean;
    grant: ApiTokenGrantV1;
    parentTokenId: string | null;
    activeChildCount: number;
    embedConfig: EmbedConfigV1 | null;
}>;

export type ApiTokenSummary = Readonly<{
    tokenId: string;
    label: string;
    displayPrefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    hasEncryptionAccess: boolean;
    hasUnattendedTeamAccess: boolean;
    grant: ApiTokenGrantV1;
    parentTokenId: string | null;
    activeChildCount: number;
    embedConfig: EmbedConfigV1 | null;
}>;

export class ApiTokenOperationError extends Error {
    constructor(readonly code: "account-disabled" | "invalid_token" | "api_token_id_conflict" | "api_token_encryption_not_ready" | "api_token_encryption_stale" | "api_token_encryption_unavailable" | "credential_authentication_evidence_limit" | "credential_authentication_evidence_unavailable" | "api_token_child_forbidden" | "api_token_child_invalid" | "credential_scope_denied") {
        super(code);
        this.name = "ApiTokenOperationError";
    }
}

function matchesApiTokenEncryptionBinding(
    account: Parameters<typeof deriveAccountEncryptionCurrentnessFromRow>[0],
    access: AccountApiTokenEncryptionAccessV1,
    serverIdentityId: string,
): boolean {
    const result = deriveAccountEncryptionCurrentnessFromRow(account);
    return result.status === "ready"
        && result.currentness.encryptionMode === "e2ee"
        && result.currentness.contentPublicKey !== null
        && privacyKit.encodeBase64(result.currentness.contentPublicKey) === access.contentPublicKey
        && access.serverIdentityId === serverIdentityId;
}

/**
 * PAT-only verification seam for server-owned introspection consumers. It
 * intentionally cannot verify a signed session token.
 */
export type VerifyPatResult =
    | Readonly<{
        ok: true;
        accountId: string;
        principalId: string;
        credentialId: string;
        expiresAt: Date | null;
        authority: "account_automation";
        grant: ApiTokenGrantV1;
        parentTokenId: string | null;
        embedConfig: EmbedConfigV1 | null;
        authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    }>
    | Readonly<{
        ok: false;
        reason: "invalid_token";
    }>;

type VerifiedApiToken = Readonly<{
    accountId: string;
    credentialId: string;
    expiresAt: Date | null;
    grant: ApiTokenGrantV1;
    parentTokenId: string | null;
    embedConfig: EmbedConfigV1 | null;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

type CurrentApiTokenRow = Readonly<{
    id: string;
    accountId: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    authenticationEvidence: unknown;
    accessGrant: unknown;
    embedConfig: unknown;
    parentTokenId: string | null;
    parent: Readonly<{ accountId: string; parentTokenId: string | null; expiresAt: Date | null; embedConfig: unknown }> | null;
    Account: Readonly<{ status: AccountStatusV1 }>;
}>;

const API_TOKEN_CURRENT_FIELDS = {
    id: true, accountId: true, expiresAt: true, lastUsedAt: true,
    authenticationEvidence: true, accessGrant: true, embedConfig: true, parentTokenId: true,
    parent: { select: { accountId: true, parentTokenId: true, expiresAt: true, embedConfig: true } },
    Account: { select: { status: true } },
} as const;

function readApiTokenGrant(value: unknown): ApiTokenGrantV1 {
    const parsed = StoredApiTokenGrantV1Schema.safeParse(value);
    if (!parsed.success) throw new ApiTokenOperationError("invalid_token");
    return parsed.data;
}

function readApiTokenEmbedConfig(value: unknown): EmbedConfigV1 | null {
    return value == null ? null : StoredEmbedConfigV1Schema.parse(value);
}

type CreateApiTokenParams = Readonly<{
    accountId: string; tokenId: string; label: string; expiresAt?: Date | null;
    encryption?: AccountApiTokenCreateEncryptionV1;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    grant?: ApiTokenGrantV1; embedConfig?: EmbedConfigV1;
}>;

export type ApiTokenRevocation = Readonly<{ revoked: boolean; revokedTokenIds: readonly string[] }>;
export type ApiTokenRevokeAllResult = Readonly<{ revokedCount: number; revokedTokenIds: readonly string[] }>;
export type ExternalActionGrantEvaluationContext = Readonly<{ input?: unknown }>;

/** The API adapter maps this canonical creation rejection to `invalid_request`. */
export class InvalidApiTokenExpiryError extends Error {
    constructor() {
        super("API token expiry must be in the future");
    }
}

const API_TOKEN_SECRET_BYTES = 32;
const API_TOKEN_DISPLAY_ID_LENGTH = 8;
// API-token verification may be high frequency. Five minutes bounds each valid
// token to one durable activity write per interval while retaining useful UI
// observability; revocation is still a row deletion checked on every request.
const API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

function isApiTokenCandidate(token: string): boolean {
    return token.startsWith("hap_");
}

function createApiTokenSecretDigest(secret: string): Buffer {
    return createSha256SecretDigest(secret);
}

function apiTokenSecretDigestMatches(storedDigest: string, suppliedSecret: string): boolean {
    return sha256SecretDigestMatches(storedDigest, suppliedSecret);
}

function createApiTokenDisplayPrefix(tokenId: string): string {
    return `hap_v1_${tokenId.slice(0, API_TOKEN_DISPLAY_ID_LENGTH)}`;
}

function createApiTokenBearer(tokenId: string, secret: string): string {
    return `hap_v1_${tokenId}_${secret}`;
}

class AuthModule {
    private tokenCache: LRUTtlMap<string, DecodedAuthToken> | null = null;
    private tokens: AuthTokens | null = null;
    private externalActionExecutionAuthorizationTokens: AuthTokens | null = null;
    private oauthStateTokens: OAuthStateTokens | null = null;
    private oauthStateTokensInitPromise: Promise<OAuthStateTokens> | null = null;

    private resolveAuthTokenCacheTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
        const raw = (env.AUTH_TOKEN_CACHE_TTL_SECONDS ?? "").toString().trim();
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
        const clampedSeconds = Math.max(1, Math.min(86_400, seconds));
        return clampedSeconds * 1000;
    }

    private resolveAuthTokenCacheMaxEntriesFromEnv(env: NodeJS.ProcessEnv): number {
        const raw = (env.AUTH_TOKEN_CACHE_MAX_ENTRIES ?? "").toString().trim();
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        const maxEntries = Number.isFinite(parsed) && parsed >= 0 ? parsed : 4096;
        return Math.max(0, Math.min(200_000, maxEntries));
    }
    
    private resolveOauthStateTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
        const raw = (env.OAUTH_STATE_TTL_SECONDS ?? "").toString().trim();
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
        const clampedSeconds = Math.max(60, Math.min(3600, seconds));
        return clampedSeconds * 1000;
    }

    private requireMasterSecret(env: NodeJS.ProcessEnv): string {
        const masterSecret = (env.HANDY_MASTER_SECRET ?? "").toString().trim();
        if (!masterSecret) {
            throw new Error("HANDY_MASTER_SECRET is required");
        }
        return masterSecret;
    }

    private deriveLegacyBunSeedCandidate(masterSecret: string, attempt: number): string {
        if (attempt === 0) {
            return masterSecret;
        }
        return createHash("sha256")
            .update(`happier-auth-seed-v1:${attempt}:${masterSecret}`)
            .digest("base64url");
    }

    private async createPersistentAuthTokens(masterSecret: string): Promise<AuthTokens> {
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: masterSecret,
        });
        const primaryVerifier = await privacyKit.createPersistentTokenVerifier({
            service: "handy",
            publicKey: Uint8Array.from(generator.publicKey),
        });

        const legacySeedCandidates = Array.from(
            { length: LEGACY_BUN_SEED_CANDIDATE_COUNT },
            (_, attempt) => this.deriveLegacyBunSeedCandidate(masterSecret, attempt),
        );
        const legacyKey =
            await privacyKit.resolveLegacyBunStandardBase64PersistentTokenPublicKey({
                service: "handy",
                seedCandidates: legacySeedCandidates,
            });

        if (!legacyKey || legacyKey.candidateIndex === 0) {
            return { generator, verifier: primaryVerifier };
        }

        const legacyVerifier = await privacyKit.createPersistentTokenVerifier({
            service: "handy",
            publicKey: legacyKey.publicKey,
        });
        log(
            { module: "auth", level: "warn" },
            `Historical Bun auth-token verification enabled (attempt=${legacyKey.candidateIndex})`,
        );

        return {
            generator,
            verifier: {
                verify: async (token: string) =>
                    (await primaryVerifier.verify(token)) ?? (await legacyVerifier.verify(token)),
            },
        };
    }

    private async createPersistentExternalActionExecutionAuthorizationTokens(
        masterSecret: string,
    ): Promise<AuthTokens> {
        const service = "happier-external-action-execution-authorization-v1";
        const generator = await privacyKit.createPersistentTokenGenerator({ service, seed: masterSecret });
        const verifier = await privacyKit.createPersistentTokenVerifier({
            service,
            publicKey: Uint8Array.from(generator.publicKey),
        });
        return { generator, verifier };
    }

    private async getOauthStateTokens(): Promise<OAuthStateTokens> {
        if (this.oauthStateTokens) {
            return this.oauthStateTokens;
        }
        if (this.oauthStateTokensInitPromise) {
            return await this.oauthStateTokensInitPromise;
        }
        const masterSecret = this.requireMasterSecret(process.env);
        const oauthStateTtlMs = this.resolveOauthStateTtlMsFromEnv(process.env);
        this.oauthStateTokensInitPromise = (async () => {
            try {
                const oauthStateGenerator = await privacyKit.createEphemeralTokenGenerator({
                    service: "happier-oauth-state",
                    seed: masterSecret,
                    ttl: oauthStateTtlMs,
                });
                const oauthStateVerifier = await privacyKit.createEphemeralTokenVerifier({
                    service: "happier-oauth-state",
                    publicKey: Uint8Array.from(oauthStateGenerator.publicKey),
                });
                return { oauthStateGenerator, oauthStateVerifier };
            } catch (error) {
                const errorName =
                    error && typeof error === "object" && "name" in error
                        ? String(error.name)
                        : "unknown";
                log(
                    { module: "auth", level: "warn" },
                    `OAuth state backend unavailable (ephemeral token init failed; error=${errorName})`
                );
                throw new OAuthStateUnavailableError();
            }
        })();

        try {
            this.oauthStateTokens = await this.oauthStateTokensInitPromise;
            return this.oauthStateTokens;
        } finally {
            this.oauthStateTokensInitPromise = null;
        }
    }

    async init(): Promise<void> {
        if (this.tokens) {
            return; // Already initialized
        }
        
        log({ module: 'auth' }, 'Initializing auth module...');
        
        const masterSecret = this.requireMasterSecret(process.env);

        const [tokens, externalActionExecutionAuthorizationTokens] = await Promise.all([
            this.createPersistentAuthTokens(masterSecret),
            this.createPersistentExternalActionExecutionAuthorizationTokens(masterSecret),
        ]);
        this.tokens = tokens;
        this.externalActionExecutionAuthorizationTokens = externalActionExecutionAuthorizationTokens;

        const tokenCacheMaxEntries = this.resolveAuthTokenCacheMaxEntriesFromEnv(process.env);
        if (tokenCacheMaxEntries > 0) {
            const tokenCacheTtlMs = this.resolveAuthTokenCacheTtlMsFromEnv(process.env);
            this.tokenCache = new LRUTtlMap({
                maxSize: tokenCacheMaxEntries,
                ttlMs: tokenCacheTtlMs,
            });
        } else {
            this.tokenCache = null;
        }
        
        log({ module: 'auth' }, 'Auth module initialized');
    }
    
    async createToken(
        userId: string,
        extras: unknown | undefined,
        options: CreateTokenOptions,
    ): Promise<string> {
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { tokenEpoch: true, status: true },
        });
        if (!account) {
            throw new Error("Cannot create auth token for an unknown account");
        }

        assertAccountActive(account.status);
        return this.createTokenWithEpoch(userId, account.tokenEpoch, extras, options);
    }

    async mintExternalActionExecutionAuthorization(
        input: ExternalActionExecutionAuthorizationBindingV1,
        context: ExternalActionGrantEvaluationContext = {},
    ): Promise<ExternalActionExecutionAuthorizationV1> {
        if (!this.externalActionExecutionAuthorizationTokens) {
            throw new Error("Auth module not initialized");
        }
        const supplied = ExternalActionExecutionAuthorizationBindingV1Schema.parse(input);
        const principal = await this.verifyCurrentApiTokenPrincipal(supplied);
        if (!principal) throw new ApiTokenOperationError("invalid_token");
        const qualifiedAction = parseQualifiedPluginActionId(supplied.actionId);
        const inputRecord = typeof context.input === "object" && context.input !== null && !Array.isArray(context.input)
            ? context.input as Readonly<Record<string, unknown>> : null;
        const invokedAction = supplied.actionId === "action.invoke"
            ? PluginContributionIdentityV1Schema.safeParse(inputRecord?.action) : null;
        const contributedQualifiedId = qualifiedAction ? supplied.actionId
            : invokedAction?.success ? formatQualifiedPluginActionId(invokedAction.data) : undefined;
        const admission = evaluateApiTokenGrantV1({ grant: principal.grant,
            actionId: qualifiedAction ? "action.invoke" : supplied.actionId, contributedQualifiedId,
            contributedActionAdmission: 'pre_open',
            target: supplied.target, targetMachineId: supplied.machineId,
            ...(supplied.actionId === "session.spawn_new" && context.input !== undefined ? { spawnInput: context.input } : {}),
        });
        if (!admission.ok) throw new ApiTokenOperationError("credential_scope_denied");
        const binding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ ...supplied, grant: principal.grant });
        const token = await this.externalActionExecutionAuthorizationTokens.generator.new({
            user: binding.accountId,
            extras: { externalActionExecutionAuthorizationV1: binding },
        });
        return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token, binding });
    }

    async verifyExternalActionExecutionAuthorization(
        token: string,
    ): Promise<ExternalActionExecutionAuthorizationBindingV1 | null> {
        if (!this.externalActionExecutionAuthorizationTokens) {
            throw new Error("Auth module not initialized");
        }
        try {
            const verified = await this.externalActionExecutionAuthorizationTokens.verifier.verify(token);
            if (typeof verified !== "object" || verified === null || Array.isArray(verified)) return null;
            const payload = verified as Readonly<Record<string, unknown>>;
            const userCandidate = payload.user ?? payload.userId;
            const extras = this.asTokenExtras(payload.extras);
            const binding = ExternalActionExecutionAuthorizationBindingV1Schema.safeParse(
                extras?.externalActionExecutionAuthorizationV1,
            );
            if (!binding.success || userCandidate !== binding.data.accountId) return null;
            return binding.data;
        } catch {
            return null;
        }
    }

    /**
     * Server-internal Personal Home readiness proof. The transient token string is
     * never returned: this owner mints and verifies one ordinary present-user
     * token using the loaded Home secret, then exposes only typed facts.
     */
    async attestPresentUserTokenRoundTrip(): Promise<Readonly<{
        authenticated: true;
    }>> {
        const account = await db.account.findFirst({
            where: { status: "active" },
            orderBy: { id: "asc" },
            select: { id: true },
        });
        if (!account) {
            throw new Error("Personal Home readiness requires an active Account");
        }
        const token = await this.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        const verified = await this.verifyToken(token);
        if (
            !verified
            || verified.userId !== account.id
            || verified.authTokenKind !== "account"
            || verified.authority !== "present_user"
            || verified.legacy
        ) {
            throw new Error("Personal Home authentication readiness attestation failed");
        }
        return { authenticated: true };
    }

    /** Account-auth completion uses the same serializable transaction for the
     * epoch read and the sealed-result CAS. The raw token remains transaction-local. */
    async createTokenInTx(
        tx: Tx,
        userId: string,
        extras: unknown | undefined,
        options: CreateTokenOptions,
    ): Promise<string> {
        const account = await tx.account.findUnique({
            where: { id: userId },
            select: { tokenEpoch: true, status: true },
        });
        if (!account) {
            throw new Error("Cannot create auth token for an unknown account");
        }

        assertAccountActive(account.status);
        return this.createTokenWithEpoch(userId, account.tokenEpoch, extras, options);
    }

    private async createTokenWithEpoch(
        userId: string,
        tokenEpoch: number,
        extras: unknown,
        options: CreateTokenOptions,
    ): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        // Provenance is an explicit mint decision: no endpoint, extras, or
        // token shape may infer or default it. A missing or non-canonical
        // kind/authority pairing fails closed through the protocol owner;
        // API tokens remain exclusively database-minted.
        if (options?.kind === "api_token") {
            throw new Error("API tokens must be minted through createApiToken");
        }
        const provenance = options.authenticationEvidence === undefined
            ? AuthTokenProvenanceSchema.parse({
                v: 1,
                kind: options.kind,
                authority: options.authority,
            })
            : AuthTokenProvenanceV2Schema.parse({
                v: 2,
                kind: options.kind,
                authority: options.authority,
                evidence: options.authenticationEvidence,
            });

        return await this.tokens.generator.new({
            user: userId,
            extras: {
                ...this.asTokenExtras(extras),
                // `provenance` is a JWT top-level claim emitted by the token
                // generator, never caller-controlled nested extras.
                provenance,
                tokenEpoch,
            },
        });
    }

    /**
     * Mints an Account API token. Its plaintext bearer is intentionally
     * returned only here; all subsequent API-token operations use summaries.
     */
    async createApiToken(params: CreateApiTokenParams, nowInput: Date = new Date()): Promise<CreatedApiToken> {
        return this.mintApiToken(params, nowInput);
    }

    async createChildApiToken(params: Readonly<{
        principal: VerifiedApiTokenPrincipal;
        tokenId: string; label: string; expiresAt: Date; grant: ApiTokenGrantV1;
        requireCreatedByChildTokenId?: string;
        resolveSessionMachine?: (sessionId: string) => Promise<string | null>;
    }>): Promise<CreatedApiToken> {
        if (params.principal.parentTokenId !== null) throw new ApiTokenOperationError("api_token_child_forbidden");
        return this.mintApiToken({ accountId: params.principal.accountId, tokenId: params.tokenId,
            label: params.label, expiresAt: params.expiresAt, grant: params.grant }, new Date(), {
            parentTokenId: params.principal.credentialId,
            requireCreatedByChildTokenId: params.requireCreatedByChildTokenId,
            resolveSessionMachine: params.resolveSessionMachine,
        });
    }

    private async mintApiToken(params: CreateApiTokenParams, nowInput: Date, child?: Readonly<{
        parentTokenId: string;
        requireCreatedByChildTokenId?: string;
        resolveSessionMachine?: (sessionId: string) => Promise<string | null>;
    }>): Promise<CreatedApiToken> {
        const accountId = params.accountId.trim();
        const label = params.label.trim();
        if (!accountId) {
            throw new Error("Cannot create an API token without an account id");
        }
        if (!label) {
            throw new Error("Cannot create an API token without a label");
        }
        if ((params.authenticationEvidence?.length ?? 0) > AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS) {
            throw new ApiTokenOperationError("credential_authentication_evidence_limit");
        }

        const now = new Date(nowInput.getTime());
        const expiresAt = params.expiresAt == null
            ? null
            : new Date(params.expiresAt.getTime());
        if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)) {
            throw new InvalidApiTokenExpiryError();
        }

        const encryption = params.encryption
            ? AccountApiTokenCreateEncryptionV1Schema.parse(params.encryption)
            : null;
        const grant = ApiTokenGrantV1Schema.parse(params.grant ?? API_TOKEN_FULL_GRANT_V1);
        let embedConfig = params.embedConfig === undefined ? null : EmbedConfigV1Schema.parse(params.embedConfig);
        const serverIdentityId = encryption ? await getOrCreateServerIdentityId() : null;
        const tokenId = params.tokenId;
        const secret = randomBytes(API_TOKEN_SECRET_BYTES).toString("base64url");
        const displayPrefix = createApiTokenDisplayPrefix(tokenId);
        const secretDigest = createApiTokenSecretDigest(secret).toString("base64url");
        // Discovery may cross Socket.IO's adapter boundary. Keep it outside the
        // interactive transaction, then revalidate the exact access relationship
        // under the same owner fence as the parent grant and child write.
        const resolvedSessionMachines = new Map<string, string | null>();
        if (child && grant.targets && child.resolveSessionMachine) {
            for (const sessionId of grant.targets.sessions) {
                resolvedSessionMachines.set(sessionId, await child.resolveSessionMachine(sessionId));
            }
        }
        const row = await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId);
            const admission = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true } });
            assertAccountActive(admission.status);
            if (child) {
                const parent = await tx.accountApiToken.findFirst({
                    where: { id: child.parentTokenId, accountId },
                    select: { parentTokenId: true, expiresAt: true, accessGrant: true, embedConfig: true },
                });
                if (!parent || (parent.expiresAt && parent.expiresAt <= now)) throw new ApiTokenOperationError("invalid_token");
                if (parent.parentTokenId !== null) throw new ApiTokenOperationError("api_token_child_forbidden");
                if (!expiresAt || (parent.expiresAt && expiresAt > parent.expiresAt)) throw new ApiTokenOperationError("api_token_child_invalid");
                const parentGrant = readApiTokenGrant(parent.accessGrant);
                let attenuationParent = parentGrant;
                // Pure set attenuation cannot infer Session→Machine membership. Resolve only
                // added Sessions through the same current-publisher owner as live admission.
                if (parentGrant.targets && grant.targets) {
                    const verifiedSessions = [...parentGrant.targets.sessions];
                    for (const sessionId of grant.targets.sessions) {
                        if (verifiedSessions.includes(sessionId)) continue;
                        const machineId = resolvedSessionMachines.get(sessionId);
                        if (!machineId || !parentGrant.targets.machines.includes(machineId)
                            || !await hasCurrentSessionScopedMachineAccessInTx({ tx, accountId, machineId, sessionId })) {
                            throw new ApiTokenOperationError("api_token_child_invalid");
                        }
                        verifiedSessions.push(sessionId);
                    }
                    attenuationParent = { ...parentGrant, targets: { ...parentGrant.targets, sessions: verifiedSessions } };
                }
                if (!isApiTokenGrantWithinV1(grant, attenuationParent)) throw new ApiTokenOperationError("api_token_child_invalid");
                if (child.requireCreatedByChildTokenId !== undefined) {
                    const creator = await tx.accountApiToken.findFirst({ where: {
                        id: child.requireCreatedByChildTokenId, accountId, parentTokenId: child.parentTokenId,
                    }, select: { id: true } });
                    if (!creator || !grant.targets || grant.targets.machines.length || !grant.targets.sessions.length) {
                        throw new ApiTokenOperationError("api_token_child_invalid");
                    }
                    const count = await tx.session.count({ where: { accountId, id: { in: grant.targets.sessions },
                        createdByApiTokenId: creator.id } });
                    if (count !== grant.targets.sessions.length) throw new ApiTokenOperationError("api_token_child_invalid");
                }
                embedConfig = readApiTokenEmbedConfig(parent.embedConfig);
            }
            if (encryption) {
                const account = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: {
                    publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true,
                } });
                if (!serverIdentityId || !matchesApiTokenEncryptionBinding(account, encryption.access, serverIdentityId)) {
                    throw new ApiTokenOperationError("api_token_encryption_not_ready");
                }
            }
            const authenticationEvidence = await resolveCurrentAuthenticationEvidenceInTx(tx, {
                env: process.env,
                accountId,
                evidence: params.authenticationEvidence,
            });
            if (params.authenticationEvidence !== undefined && authenticationEvidence.length === 0) {
                throw new ApiTokenOperationError("credential_authentication_evidence_unavailable");
            }
            const authenticationEvidenceSnapshot = authenticationEvidence.length > 0
                ? AuthTokenAuthenticationEvidenceSnapshotV1Schema.parse({ v: 1, evidence: authenticationEvidence })
                : null;
            return await tx.accountApiToken.create({
                data: {
                    id: tokenId,
                    accountId,
                    displayPrefix,
                    secretDigest,
                    label,
                    createdAt: now,
                    expiresAt,
                    accessGrant: grant,
                    ...(child ? { parentTokenId: child.parentTokenId } : {}),
                    ...(!child && embedConfig ? { embedConfig } : {}),
                    ...(encryption ? { encryptionAccess: encryption.access } : {}),
                    ...(authenticationEvidenceSnapshot ? { authenticationEvidence: authenticationEvidenceSnapshot } : {}),
                },
                select: {
                    id: true,
                    label: true,
                    displayPrefix: true,
                    createdAt: true,
                    expiresAt: true,
                    authenticationEvidence: true,
                },
            });
        }).catch((error: unknown) => {
            if (isPrismaErrorCode(error, "P2002")) throw new ApiTokenOperationError("api_token_id_conflict");
            throw error;
        });

        return {
            tokenId: row.id,
            token: createApiTokenBearer(tokenId, secret),
            label: row.label,
            displayPrefix: row.displayPrefix,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            hasEncryptionAccess: encryption !== null,
            hasUnattendedTeamAccess: parseAuthenticationEvidenceSnapshot(row.authenticationEvidence) !== null,
            grant,
            parentTokenId: child?.parentTokenId ?? null,
            activeChildCount: 0,
            embedConfig,
        };
    }

    /** Summaries deliberately omit the bearer secret and its stored digest. */
    async listApiTokens(accountId: string): Promise<readonly ApiTokenSummary[]> {
        const rows = await db.accountApiToken.findMany({
            where: { accountId: accountId.trim(), parentTokenId: null },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                label: true,
                displayPrefix: true,
                createdAt: true,
                lastUsedAt: true,
                expiresAt: true,
                encryptionAccess: true,
                authenticationEvidence: true,
                accessGrant: true, embedConfig: true, parentTokenId: true,
                _count: { select: { children: { where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } } } },
            },
        });
        return rows.map((row) => ({
            tokenId: row.id,
            label: row.label,
            displayPrefix: createApiTokenDisplayPrefix(row.id),
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
            expiresAt: row.expiresAt,
            hasEncryptionAccess: row.encryptionAccess != null,
            hasUnattendedTeamAccess: parseAuthenticationEvidenceSnapshot(row.authenticationEvidence) !== null,
            grant: readApiTokenGrant(row.accessGrant),
            parentTokenId: row.parentTokenId,
            activeChildCount: row._count.children,
            embedConfig: readApiTokenEmbedConfig(row.embedConfig),
        }));
    }

    async updateApiToken(params: Readonly<{
        accountId: string; tokenId: string; label?: string; grant?: ApiTokenGrantV1; embedConfig?: EmbedConfigV1 | null;
    }>): Promise<Readonly<{ apiToken: ApiTokenSummary; revokedTokenIds: readonly string[]; grantChanged: boolean }>> {
        const result = await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId);
            const row = await tx.accountApiToken.findFirst({ where: { id: params.tokenId, accountId: params.accountId, parentTokenId: null },
                select: { accessGrant: true } });
            if (!row) throw new ApiTokenOperationError("invalid_token");
            const grant = params.grant === undefined ? undefined : ApiTokenGrantV1Schema.parse(params.grant);
            const grantChanged = grant !== undefined && JSON.stringify(grant) !== JSON.stringify(readApiTokenGrant(row.accessGrant));
            const children = grantChanged ? await tx.accountApiToken.findMany({ where: { parentTokenId: params.tokenId }, select: { id: true } }) : [];
            if (grantChanged) await tx.accountApiToken.deleteMany({ where: { parentTokenId: params.tokenId } });
            await tx.accountApiToken.update({ where: { id: params.tokenId }, data: {
                ...(params.label !== undefined ? { label: params.label.trim() } : {}),
                ...(grant !== undefined ? { accessGrant: grant } : {}),
                ...(params.embedConfig !== undefined ? { embedConfig: params.embedConfig === null
                    ? getActivePrismaRuntime().DbNull : EmbedConfigV1Schema.parse(params.embedConfig) } : {}),
            } });
            return { grantChanged, revokedTokenIds: children.map((child) => child.id) };
        });
        const apiToken = (await this.listApiTokens(params.accountId)).find((token) => token.tokenId === params.tokenId);
        if (!apiToken) throw new ApiTokenOperationError("invalid_token");
        return { ...result, apiToken };
    }

    /** Selects only the credential authenticated by the request; never admits or repairs keys. */
    async getApiTokenEncryptionAccess(principal: VerifiedApiTokenPrincipal): Promise<AccountApiTokenEncryptionAccessResponseV1> {
        const serverIdentityId = await getOrCreateServerIdentityId();
        return await inTx(async (tx) => {
            const row = await tx.accountApiToken.findFirst({
                where: { id: principal.credentialId, accountId: principal.accountId },
                select: { parentTokenId: true, encryptionAccess: true, expiresAt: true, Account: { select: {
                    status: true, publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true,
                } } },
            });
            if (!row || !isActiveHomeAccountStatus(row.Account.status) || (row.expiresAt && row.expiresAt <= new Date())) throw new ApiTokenOperationError("invalid_token");
            if (row.parentTokenId !== null) throw new ApiTokenOperationError("api_token_encryption_unavailable");
            if (row.encryptionAccess == null) throw new ApiTokenOperationError("api_token_encryption_unavailable");
            const parsed = AccountApiTokenEncryptionAccessV1Schema.safeParse(row.encryptionAccess);
            if (!parsed.success || !matchesApiTokenEncryptionBinding(row.Account, parsed.data, serverIdentityId)) {
                throw new ApiTokenOperationError("api_token_encryption_stale");
            }
            return { v: 1 as const, accountId: principal.accountId, tokenId: principal.credentialId, encryptionAccess: parsed.data };
        });
    }

    /** Revocation is deletion: the next verification cannot find this selector. */
    async revokeApiToken(params: Readonly<{ accountId: string; tokenId: string; parentTokenId?: string }>): Promise<ApiTokenRevocation> {
        return inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId);
            const where = { id: params.tokenId, accountId: params.accountId.trim(),
                ...(params.parentTokenId !== undefined ? { parentTokenId: params.parentTokenId } : {}) };
            const row = await tx.accountApiToken.findFirst({ where, select: { id: true, children: { select: { id: true } } } });
            if (!row) return { revoked: false, revokedTokenIds: [] };
            await tx.accountApiToken.deleteMany({ where });
            return { revoked: true, revokedTokenIds: [row.id, ...row.children.map((child) => child.id)] };
        });
    }

    async revokeChildApiToken(principal: VerifiedApiTokenPrincipal, tokenId: string): Promise<ApiTokenRevocation> {
        if (principal.parentTokenId !== null) throw new ApiTokenOperationError("api_token_child_forbidden");
        return this.revokeApiToken({ accountId: principal.accountId, tokenId, parentTokenId: principal.credentialId });
    }

    /** Used by the present-user Action after its caller policy is registered. */
    async revokeAllApiTokens(accountId: string): Promise<ApiTokenRevokeAllResult> {
        return inTx((tx) => this.revokeAllApiTokensInTx(tx, accountId));
    }

    /** Deletes complete PAT rows in the caller's Account transition. */
    async revokeAllApiTokensInTx(tx: Tx, accountId: string): Promise<ApiTokenRevokeAllResult> {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId);
        const rows = await tx.accountApiToken.findMany({ where: { accountId: accountId.trim() }, select: { id: true } });
        const result = await tx.accountApiToken.deleteMany({
            where: { accountId: accountId.trim() },
        });
        return { revokedCount: result.count, revokedTokenIds: rows.map((row) => row.id) };
    }

    /**
     * Verifies a current signed credential (or a PAT). Signed credentials must
     * carry a supported closed provenance version (evidence-free V1 or
     * evidence-bearing V2); pre-marker credentials are intentionally not
     * accepted on this canonical route-auth path.
     */
    async verifyToken(token: string): Promise<VerifiedAuthToken | null> {
        const result = await this.verifyTokenInternal(token, { allowLegacyHome: false });
        return isRejectedRestrictedCredential(result) ? null : result;
    }

    /**
     * Bounded compatibility reader for pre-marker ordinary Home credentials.
     * This is an explicit migration seam: it never admits PATs, Directory
     * credentials, or malformed/future markers and must not be used by generic
     * route admission.
     */
    async verifyLegacyHomeToken(token: string): Promise<VerifiedAuthToken | null> {
        const verified = await this.verifyTokenInternal(token, { allowLegacyHome: true });
        if (
            isRejectedRestrictedCredential(verified)
            || !verified
            || !verified.legacy
            || (verified.authTokenKind !== "account" && verified.authTokenKind !== "terminal")
        ) {
            return null;
        }
        return verified;
    }

    /** Route/socket compatibility boundary: strict current tokens first, then
     * the explicitly named pre-marker ordinary-Home reader. */
    async verifyTokenForRoute(token: string): Promise<VerifiedAuthToken | null> {
        const disposition = await this.verifyTokenDisposition(token, { allowLegacyHome: true });
        return disposition.status === "verified" ? disposition.credential : null;
    }

    /**
     * Canonical request-boundary disposition. A cryptographically verified
     * restricted Runner credential remains distinguishable after its database
     * currentness is revoked, while malformed and arbitrary bearers stay
     * indistinguishable from other invalid credentials.
     */
    async verifyTokenDisposition(
        token: string,
        options: Readonly<{ allowLegacyHome: boolean }>,
    ): Promise<AuthTokenVerificationDisposition> {
        const strict = await this.verifyTokenInternal(token, { allowLegacyHome: false });
        if (isRejectedRestrictedCredential(strict)) return strict;
        if (strict) return { status: "verified", credential: strict };
        if (!options.allowLegacyHome) return { status: "invalid" };

        const legacy = await this.verifyTokenInternal(token, { allowLegacyHome: true });
        if (isRejectedRestrictedCredential(legacy)) return legacy;
        if (
            legacy
            && legacy.legacy
            && (legacy.authTokenKind === "account" || legacy.authTokenKind === "terminal")
        ) {
            return { status: "verified", credential: legacy };
        }
        return { status: "invalid" };
    }

    private async verifyTokenInternal(
        token: string,
        options: Readonly<{ allowLegacyHome: boolean }>,
    ): Promise<AuthTokenInternalVerification> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        // API tokens have a reserved bearer prefix. A malformed token must not
        // fall through to the signed-token verifier or gain a second auth path.
        if (isApiTokenCandidate(token)) {
            if (options.allowLegacyHome) return null;
            const verifiedPat = await this.verifyPat(token);
            if (!verifiedPat.ok) {
                return null;
            }
            return {
                userId: verifiedPat.principalId,
                authTokenKind: "api_token",
                authority: verifiedPat.authority,
                legacy: false,
                apiTokenPrincipal: {
                    accountId: verifiedPat.accountId,
                    principalId: verifiedPat.principalId,
                    credentialId: verifiedPat.credentialId,
                    authority: verifiedPat.authority,
                    expiresAt: verifiedPat.expiresAt,
                    grant: verifiedPat.grant,
                    parentTokenId: verifiedPat.parentTokenId,
                    embedConfig: verifiedPat.embedConfig,
                    ...(verifiedPat.authenticationEvidence ? { authenticationEvidence: verifiedPat.authenticationEvidence } : {}),
                },
                ...(verifiedPat.authenticationEvidence ? { authenticationEvidence: verifiedPat.authenticationEvidence } : {}),
            };
        }

        let decoded: DecodedAuthToken | null | undefined = this.tokenCache?.get(token);
        if (decoded?.legacy && !options.allowLegacyHome) {
            return null;
        }
        if (!decoded) {
            try {
                const verified = await this.tokens.verifier.verify(token);
                decoded = this.decodeAuthToken(verified, options);
            } catch {
                log({ module: "auth", level: "error" }, "Token verification failed");
                return null;
            }
            if (!decoded) {
                return null;
            }
            // The cache retains only data that passed cryptographic verification.
            this.tokenCache?.set(token, decoded);
        }

        // The account row is authoritative for revocation, including cache hits.
        const account = await this.readCurrentSignedCredentialAccount(db, decoded.userId, decoded.tokenEpoch);
        if (!account) {
            return decoded.provenance.kind === "ephemeral_session_runner"
                ? REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL
                : null;
        }

        const ephemeralSessionRunnerPrincipal = decoded.provenance.kind === "ephemeral_session_runner"
            ? await verifyCurrentEphemeralSessionRunnerPrincipal(decoded.userId, decoded.extras)
            : undefined;
        if (decoded.provenance.kind === "ephemeral_session_runner" && !ephemeralSessionRunnerPrincipal) {
            return REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL;
        }

        return {
            userId: decoded.userId,
            tokenEpoch: decoded.tokenEpoch,
            extras: decoded.extras,
            authTokenKind: decoded.provenance.kind,
            authTokenMintedAuthority: decoded.provenance.authority,
            authority: effectiveCredentialAuthority({
                credentialKind: decoded.provenance.kind,
                mintedAuthority: decoded.provenance.authority,
                terminalPresentUserPolicy: account.terminalPresentUserPolicy,
            }),
            ...(decoded.provenance.v === 2 ? { authenticationEvidence: decoded.provenance.evidence } : {}),
            ...(ephemeralSessionRunnerPrincipal ? { ephemeralSessionRunnerPrincipal } : {}),
            legacy: decoded.legacy,
        };
    }

    /** Same Account revocation owner for a bearer and its signed broker authority. */
    async isSignedCredentialCurrent(
        reader: Pick<Tx, 'account'>,
        accountId: string,
        tokenEpoch: number | undefined,
    ): Promise<boolean> {
        return await this.readCurrentSignedCredentialAccount(reader, accountId, tokenEpoch) !== null;
    }

    private async readCurrentSignedCredentialAccount(
        reader: Pick<Tx, 'account'>,
        accountId: string,
        tokenEpoch: number | undefined,
    ) {
        if (tokenEpoch === undefined) return null;
        const account = await reader.account.findUnique({
            where: { id: accountId },
            select: { tokenEpoch: true, status: true, terminalPresentUserPolicy: true },
        });
        return account && isActiveHomeAccountStatus(account.status) && account.tokenEpoch === tokenEpoch ? account : null;
    }

    /** Verifies the fixed PAT format through its independent credential-row lifecycle. */
    async verifyPat(token: string, signal?: AbortSignal): Promise<VerifyPatResult> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        signal?.throwIfAborted();

        const parsed = parseAccountApiTokenBearerV1(token);
        if (!parsed) {
            return { ok: false, reason: "invalid_token" };
        }

        const verified = await this.verifyParsedApiToken(parsed, signal);
        if (!verified) {
            return { ok: false, reason: "invalid_token" };
        }
        return {
            ok: true,
            accountId: verified.accountId,
            principalId: verified.accountId,
            credentialId: verified.credentialId,
            expiresAt: verified.expiresAt,
            authority: "account_automation",
            grant: verified.grant,
            parentTokenId: verified.parentTokenId,
            embedConfig: verified.embedConfig,
            ...(verified.authenticationEvidence ? { authenticationEvidence: verified.authenticationEvidence } : {}),
        };
    }

    /**
     * The signed external-Action capability selects one already-authenticated
     * PAT by immutable ids. This reader re-checks currentness from the same database row
     * owner as bearer verification without accepting or reconstructing its secret.
     */
    async verifyCurrentApiTokenPrincipal(
        principal: Readonly<{ accountId: string; principalId: string; credentialId: string }>,
        signal?: AbortSignal,
        reader: Pick<Tx, "accountApiToken"> = db,
    ): Promise<VerifiedApiTokenPrincipal | null> {
        signal?.throwIfAborted();
        if (principal.accountId !== principal.principalId) return null;
        const row = await reader.accountApiToken.findFirst({
            where: { id: principal.credentialId, accountId: principal.accountId },
            select: API_TOKEN_CURRENT_FIELDS,
        });
        const verified = await this.verifyCurrentApiTokenRow(row, signal, reader);
        return verified
            ? {
                accountId: verified.accountId,
                principalId: verified.accountId,
                credentialId: verified.credentialId,
                authority: "account_automation",
                expiresAt: verified.expiresAt,
                grant: verified.grant,
                parentTokenId: verified.parentTokenId,
                embedConfig: verified.embedConfig,
                ...(verified.authenticationEvidence
                    ? { authenticationEvidence: verified.authenticationEvidence }
                    : {}),
            }
            : null;
    }

    async signOutEverywhere(userId: string): Promise<number> {
        return inTx((tx) => this.signOutEverywhereInTx(tx, userId));
    }

    async signOutEverywhereInTx(tx: Tx, userId: string): Promise<number> {
        // This owner invalidates signed sessions only. API tokens are explicit
        // long-lived automation credentials and retain their separate
        // revoke-one/revoke-all lifecycle.
        const account = await tx.account.update({
            where: { id: userId },
            data: { tokenEpoch: { increment: 1 } },
            select: { tokenEpoch: true },
        });
        return account.tokenEpoch;
    }

    /** Lifecycle retirement composes both credential owners without opening a nested transaction. */
    async revokeAllAccountCredentialsInTx(tx: Tx, accountId: string): Promise<void> {
        await this.signOutEverywhereInTx(tx, accountId);
        await this.revokeAllApiTokensInTx(tx, accountId);
    }

    private async verifyParsedApiToken(
        parsed: ParsedAccountApiTokenBearerV1,
        signal?: AbortSignal,
    ): Promise<VerifiedApiToken | null> {
        signal?.throwIfAborted();
        const row = await db.accountApiToken.findUnique({
            where: { id: parsed.tokenId },
            select: {
                ...API_TOKEN_CURRENT_FIELDS,
                secretDigest: true,
            },
        });
        signal?.throwIfAborted();
        if (!row || !apiTokenSecretDigestMatches(row.secretDigest, parsed.secret)) {
            return null;
        }

        return this.verifyCurrentApiTokenRow(row, signal);
    }

    private async verifyCurrentApiTokenRow(
        row: CurrentApiTokenRow | null,
        signal?: AbortSignal,
        reader: Pick<Tx, "accountApiToken"> = db,
    ): Promise<VerifiedApiToken | null> {
        signal?.throwIfAborted();
        if (!row || !isActiveHomeAccountStatus(row.Account.status)) return null;
        const now = new Date();
        if (row.expiresAt && row.expiresAt <= now) {
            return null;
        }
        if (row.parentTokenId !== null && (row.expiresAt === null || !row.parent || row.parent.accountId !== row.accountId
            || row.parent.parentTokenId !== null || (row.parent.expiresAt && row.parent.expiresAt <= now))) return null;
        let grant: ApiTokenGrantV1;
        let embedConfig: EmbedConfigV1 | null;
        try {
            grant = readApiTokenGrant(row.accessGrant);
            embedConfig = readApiTokenEmbedConfig(row.parentTokenId === null ? row.embedConfig : row.parent?.embedConfig);
        } catch { return null; }

        await this.recordApiTokenLastUse({
            tokenId: row.id,
            lastUsedAt: row.lastUsedAt,
            now,
            reader,
        });
        signal?.throwIfAborted();
        const authenticationEvidence = parseAuthenticationEvidenceSnapshot(row.authenticationEvidence)?.evidence;
        return {
            accountId: row.accountId,
            credentialId: row.id,
            expiresAt: row.expiresAt,
            grant,
            parentTokenId: row.parentTokenId,
            embedConfig,
            ...(authenticationEvidence ? { authenticationEvidence } : {}),
        };
    }

    private async recordApiTokenLastUse(params: Readonly<{
        tokenId: string;
        lastUsedAt: Date | null;
        now: Date;
        reader: Pick<Tx, "accountApiToken">;
    }>): Promise<void> {
        const threshold = new Date(params.now.getTime() - API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS);
        if (params.lastUsedAt && params.lastUsedAt > threshold) {
            return;
        }

        try {
            await params.reader.accountApiToken.updateMany({
                where: {
                    id: params.tokenId,
                    OR: [
                        { lastUsedAt: null },
                        { lastUsedAt: { lte: threshold } },
                    ],
                },
                data: { lastUsedAt: params.now },
            });
        } catch {
            // Activity metadata must not become an availability dependency for
            // an otherwise valid API token, and this path never logs a bearer.
            log({ module: "auth", level: "warn" }, "API token last-used update failed");
        }
    }

    private decodeAuthToken(
        verified: unknown,
        options: Readonly<{ allowLegacyHome: boolean }>,
    ): DecodedAuthToken | null {
        if (typeof verified !== "object" || verified === null || Array.isArray(verified)) {
            return null;
        }

        const payload = verified as Readonly<Record<string, unknown>>;
        const userCandidate = payload.user ?? payload.userId;
        const userId = typeof userCandidate === "string" ? userCandidate.trim() : "";
        if (!userId) {
            return null;
        }

        const tokenExtras = this.asTokenExtras(payload.extras) ?? {};

        const decodedProvenance = readAuthTokenProvenance(payload, options);
        if (!decodedProvenance) return null;
        const { provenance, legacy } = decodedProvenance;

        const rawTokenEpoch = payload.tokenEpoch ?? tokenExtras.tokenEpoch;
        if (rawTokenEpoch === undefined && !legacy) {
            return null;
        }
        const tokenEpoch = rawTokenEpoch === undefined ? 0 : rawTokenEpoch;
        if (
            typeof tokenEpoch !== "number"
            || !Number.isSafeInteger(tokenEpoch)
            || tokenEpoch < 0
        ) {
            return null;
        }

        return {
            userId,
            extras: this.withoutProvenance(
                this.withoutTokenEpoch(tokenExtras),
                legacy,
            ),
            tokenEpoch,
            provenance,
            legacy,
        };
    }

    private asTokenExtras(value: unknown): Readonly<Record<string, unknown>> | null {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        return value as Readonly<Record<string, unknown>>;
    }

    private withoutTokenEpoch(extras: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
        const { tokenEpoch: _tokenEpoch, ...publicExtras } = extras;
        return publicExtras;
    }

    private withoutProvenance(
        extras: Readonly<Record<string, unknown>>,
        legacy: boolean,
    ): Readonly<Record<string, unknown>> {
        if (legacy) return extras;
        const { provenance: _provenance, ...publicExtras } = extras;
        return publicExtras;
    }
    
    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (!this.tokenCache || this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }

        return {
            size: this.tokenCache.size,
            oldestEntry: this.tokenCache.peekOldestAccessedAt()
        };
    }
    
    async createOauthStateToken(payload: OAuthStatePayload): Promise<string> {
        if (!this.tokens) {
            throw new Error("Auth module not initialized");
        }
        const oauthStateTokens = await this.getOauthStateTokens();

        const provider = payload.provider?.toString().trim().toLowerCase() ?? "";
        if (!provider) {
            throw new Error("Invalid OAuth provider");
        }

        const flow = payload.flow;
        if (flow !== "auth" && flow !== "connect") {
            throw new Error(`Invalid OAuth flow: ${String(flow)}`);
        }
        const sid = payload.sid?.toString().trim() || null;
        const userId = payload.userId?.toString().trim() || null;
        const publicKey = payload.publicKey?.toString().trim() || null;
        const proofHash = payload.proofHash?.toString().trim() || null;
        const purposeRaw = payload.purpose ?? null;
        if (
            purposeRaw !== null
            && purposeRaw !== "account_encryption_first_key"
            && purposeRaw !== "account_password_enrollment"
            && purposeRaw !== "account_directory"
            && purposeRaw !== "team_admission"
            && purposeRaw !== "github_app_installation_verification"
            && purposeRaw !== "github_app_manifest_setup"
        ) {
            // The purpose union is closed and server-controlled. An unknown
            // purpose must never silently downgrade to an ordinary full-auth
            // state.
            throw new Error("Invalid OAuth purpose");
        }
        const purpose = purposeRaw;
        const endpointUrl = payload.endpointUrl?.toString().trim() || null;
        const endpointServerIdentityId =
            payload.endpointServerIdentityId?.toString().trim() || null;
        const canonicalServerUrl =
            payload.canonicalServerUrl?.toString().trim() || null;
        const requestDigestCandidate =
            (purpose === "account_password_enrollment"
                ? PasswordCredentialMutationDigestV1Schema
                : AccountEncryptionMigrateExternalAuthBindingDigestV1Schema)
                .safeParse(
                    payload.requestDigest
                        ?.toString()
                        .trim(),
                );
        const requestDigest =
            requestDigestCandidate.success
                ? requestDigestCandidate.data
                : null;
        if (
            (purpose === "account_encryption_first_key" || purpose === "account_password_enrollment")
            && (
                flow !== "auth"
                || !userId
                || !proofHash
                || !requestDigest
                || publicKey !== null
                || endpointUrl !== null
                || endpointServerIdentityId !== null
                || canonicalServerUrl !== null
            )
        ) {
            throw new Error("Invalid OAuth first-key step-up binding");
        }
        if (
            purpose === "account_directory"
            && (
                flow !== "auth"
                || userId !== null
                || !endpointUrl
                || !endpointServerIdentityId
                || !canonicalServerUrl
                || requestDigest !== null
                || ((publicKey === null) === (proofHash === null))
            )
        ) {
            throw new Error("Invalid OAuth account-directory binding");
        }
        if (
            purpose === "team_admission"
            && (
                flow !== "auth"
                || userId !== null
                || requestDigest !== null
                || endpointUrl !== null
                || endpointServerIdentityId !== null
                || canonicalServerUrl !== null
                || ((publicKey === null) === (proofHash === null))
            )
        ) {
            throw new Error("Invalid OAuth Team-admission binding");
        }
        if (
            (purpose === "github_app_installation_verification" || purpose === "github_app_manifest_setup")
            && (
                flow !== "connect"
                || !userId
                || publicKey !== null
                || proofHash !== null
                || requestDigest !== null
                || endpointUrl !== null
                || endpointServerIdentityId !== null
                || canonicalServerUrl !== null
            )
        ) {
            throw new Error("Invalid GitHub App setup binding");
        }
        if (
            purpose === null
            && (endpointUrl !== null || endpointServerIdentityId !== null || canonicalServerUrl !== null)
        ) {
            // Endpoint binding fields only travel with the directory purpose.
            throw new Error("Invalid OAuth endpoint binding");
        }

        return await oauthStateTokens.oauthStateGenerator.new({
            user: "oauth-state",
            extras: {
                provider,
                flow,
                sid,
                userId,
                publicKey,
                proofHash,
                purpose,
                requestDigest,
                endpointUrl,
                endpointServerIdentityId,
                canonicalServerUrl,
            },
        });
    }

    async verifyOauthStateToken(token: string): Promise<{
        flow: "connect" | "auth";
        provider: string;
        sid: string | null;
        userId: string | null;
        publicKey: string | null;
        proofHash: string | null;
        purpose?: "account_encryption_first_key" | "account_password_enrollment" | "account_directory" | "team_admission" | "github_app_installation_verification" | "github_app_manifest_setup";
        requestDigest?: string;
        endpointUrl?: string;
        endpointServerIdentityId?: string;
        canonicalServerUrl?: string;
    } | null> {
        if (!this.tokens) {
            throw new Error("Auth module not initialized");
        }

        try {
            const oauthStateTokens = await this.getOauthStateTokens();
            const verified: any = await oauthStateTokens.oauthStateVerifier.verify(token);
            if (!verified) {
                return null;
            }

            if (verified.user !== "oauth-state") return null;
            const extras = verified.extras ?? {};
            const provider = typeof extras.provider === "string" ? extras.provider.trim().toLowerCase() : "";
            const flow = extras.flow === "auth" ? "auth" : extras.flow === "connect" ? "connect" : null;
            if (!provider || !flow) return null;
            const purposeRaw =
                typeof extras.purpose === "string" && extras.purpose.trim()
                    ? extras.purpose
                    : null;
            if (
                purposeRaw !== null
                && purposeRaw !== "account_encryption_first_key"
                && purposeRaw !== "account_password_enrollment"
                && purposeRaw !== "account_directory"
                && purposeRaw !== "team_admission"
                && purposeRaw !== "github_app_installation_verification"
                && purposeRaw !== "github_app_manifest_setup"
            ) {
                // Unknown/future purpose markers fail closed instead of
                // degrading the continuation into an ordinary full-auth state.
                return null;
            }
            const purpose = purposeRaw;
            const endpointUrl =
                typeof extras.endpointUrl === "string" && extras.endpointUrl.trim()
                    ? extras.endpointUrl.trim()
                    : null;
            const endpointServerIdentityId =
                typeof extras.endpointServerIdentityId === "string" && extras.endpointServerIdentityId.trim()
                    ? extras.endpointServerIdentityId.trim()
                    : null;
            const canonicalServerUrl =
                typeof extras.canonicalServerUrl === "string" && extras.canonicalServerUrl.trim()
                    ? extras.canonicalServerUrl.trim()
                    : null;
            const userId =
                typeof extras.userId === "string" && extras.userId.trim()
                    ? extras.userId.trim()
                    : null;
            const publicKey =
                typeof extras.publicKey === "string" && extras.publicKey.trim()
                    ? extras.publicKey.trim()
                    : null;
            const proofHash =
                typeof extras.proofHash === "string" && extras.proofHash.trim()
                    ? extras.proofHash.trim()
                    : null;
            const requestDigestCandidate =
                (purpose === "account_password_enrollment"
                    ? PasswordCredentialMutationDigestV1Schema
                    : AccountEncryptionMigrateExternalAuthBindingDigestV1Schema)
                    .safeParse(
                        typeof extras.requestDigest
                            === "string"
                            ? extras.requestDigest.trim()
                            : null,
                    );
            const requestDigest =
                requestDigestCandidate.success
                    ? requestDigestCandidate.data
                    : null;
            if (
                (purpose === "account_encryption_first_key" || purpose === "account_password_enrollment")
                && (
                    flow !== "auth"
                    || !userId
                    || !proofHash
                    || !requestDigest
                    || publicKey !== null
                    || endpointUrl !== null
                    || endpointServerIdentityId !== null
                    || canonicalServerUrl !== null
                )
            ) {
                return null;
            }
            if (
                purpose === "account_directory"
                && (
                    flow !== "auth"
                    || userId !== null
                    || !endpointUrl
                    || !endpointServerIdentityId
                    || !canonicalServerUrl
                    || requestDigest !== null
                    || ((publicKey === null) === (proofHash === null))
                )
            ) {
                return null;
            }
            if (
                purpose === "team_admission"
                && (
                    flow !== "auth"
                    || userId !== null
                    || requestDigest !== null
                    || endpointUrl !== null
                    || endpointServerIdentityId !== null
                    || canonicalServerUrl !== null
                    || ((publicKey === null) === (proofHash === null))
                )
            ) {
                return null;
            }
            if (
                (purpose === "github_app_installation_verification" || purpose === "github_app_manifest_setup")
                && (
                    flow !== "connect"
                    || !userId
                    || publicKey !== null
                    || proofHash !== null
                    || requestDigest !== null
                    || endpointUrl !== null
                    || endpointServerIdentityId !== null
                    || canonicalServerUrl !== null
                )
            ) {
                return null;
            }
            if (
                purpose === null
                && (endpointUrl !== null || endpointServerIdentityId !== null || canonicalServerUrl !== null)
            ) {
                // Endpoint binding fields only travel with the directory purpose.
                return null;
            }

            return {
                flow,
                provider,
                sid: typeof extras.sid === "string" && extras.sid.trim() ? extras.sid.trim() : null,
                userId,
                publicKey,
                proofHash,
                ...(purpose ? { purpose } : {}),
                ...(purpose && requestDigest ? { requestDigest } : {}),
                ...(purpose === "account_directory" && endpointUrl
                    ? { endpointUrl }
                    : {}),
                ...(purpose === "account_directory" && endpointServerIdentityId
                    ? { endpointServerIdentityId }
                    : {}),
                ...(purpose === "account_directory" && canonicalServerUrl
                    ? { canonicalServerUrl }
                    : {}),
            };
        } catch (error) {
            if (isOAuthStateUnavailableError(error)) {
                return null;
            }
            // Avoid logging the raw token or verifier error payloads (which can include sensitive details).
            log({ module: "auth", level: "error" }, "OAuth state token verification failed");
            return null;
        }
    }

    // Cleanup old entries (optional - can be called periodically)
    cleanup(): void {
        this.tokenCache?.pruneExpired();

        const stats = this.getCacheStats();
        log({ module: 'auth' }, `Token cache size: ${stats.size} entries`);
    }
}

// Global instance
export const auth = new AuthModule();
