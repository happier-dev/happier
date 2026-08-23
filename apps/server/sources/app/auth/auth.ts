import * as privacyKit from "privacy-kit";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
    AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { LRUTtlMap } from "@/utils/collections/lru";
import {
    isOAuthStateUnavailableError,
    OAuthStateUnavailableError,
} from "./oauthStateErrors";

interface TokenGeneratorLike {
    new: (payload: any) => Promise<string>;
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
    purpose?: "account_encryption_first_key" | null;
    requestDigest?: string | null;
}>;

type DecodedAuthToken = Readonly<{
    userId: string;
    extras?: unknown;
    tokenEpoch: number;
}>;

export type AuthTokenKind = "account" | "terminal" | "api_token";
export type AuthAuthority = "present_user" | "account_automation";

export type VerifiedAuthToken = Readonly<{
    userId: string;
    extras?: unknown;
    /**
     * API tokens stamp their server-verified provenance. Signed tokens retain
     * their existing shape; Fastify derives their existing account/terminal
     * provenance from verified extras.
     */
    authTokenKind?: AuthTokenKind;
    authority?: AuthAuthority;
}>;

export type CreatedApiToken = Readonly<{
    tokenId: string;
    /** Plaintext is returned only from this mint result and is never persisted. */
    token: string;
    label: string;
    displayPrefix: string;
    createdAt: Date;
    expiresAt: Date | null;
}>;

export type ApiTokenSummary = Readonly<{
    tokenId: string;
    label: string;
    displayPrefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
}>;

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
    }>
    | Readonly<{
        ok: false;
        reason: "invalid_token";
    }>;

type ParsedApiToken = Readonly<{
    tokenId: string;
    secret: string;
}>;

type VerifiedApiToken = Readonly<{
    accountId: string;
    credentialId: string;
    expiresAt: Date | null;
}>;

const API_TOKEN_PATTERN = /^hap_v1_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const API_TOKEN_SECRET_BYTES = 32;
const API_TOKEN_DISPLAY_ID_LENGTH = 8;
// API-token verification may be high frequency. Five minutes bounds each valid
// token to one durable activity write per interval while retaining useful UI
// observability; revocation is still a row deletion checked on every request.
const API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

function parseApiToken(token: string): ParsedApiToken | null {
    const match = API_TOKEN_PATTERN.exec(token);
    if (!match) return null;
    const tokenId = match[1];
    const secret = match[2];
    return tokenId && secret ? { tokenId, secret } : null;
}

function isApiTokenCandidate(token: string): boolean {
    return token.startsWith("hap_");
}

function createApiTokenSecretDigest(secret: string): Buffer {
    return createHash("sha256").update(secret, "utf8").digest();
}

function apiTokenSecretDigestMatches(storedDigest: string, suppliedSecret: string): boolean {
    const stored = Buffer.from(storedDigest, "base64url");
    const supplied = createApiTokenSecretDigest(suppliedSecret);
    return stored.byteLength === supplied.byteLength && timingSafeEqual(stored, supplied);
}

function createApiTokenDisplayPrefix(tokenId: string): string {
    return `hap_${tokenId.slice(0, API_TOKEN_DISPLAY_ID_LENGTH)}`;
}

function createApiTokenBearer(tokenId: string, secret: string): string {
    return `hap_v1_${tokenId}_${secret}`;
}

class AuthModule {
    private tokenCache: LRUTtlMap<string, DecodedAuthToken> | null = null;
    private tokens: AuthTokens | null = null;
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

        this.tokens = await this.createPersistentAuthTokens(masterSecret);

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
    
    async createToken(userId: string, extras?: any): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { tokenEpoch: true },
        });
        if (!account) {
            throw new Error("Cannot create auth token for an unknown account");
        }

        return await this.tokens.generator.new({
            user: userId,
            extras: {
                ...(this.asTokenExtras(extras) ?? {}),
                tokenEpoch: account.tokenEpoch,
            },
        });
    }

    /**
     * Mints an Account API token. Its plaintext bearer is intentionally
     * returned only here; all subsequent API-token operations use summaries.
     */
    async createApiToken(params: Readonly<{
        accountId: string;
        label: string;
        expiresAt?: Date | null;
    }>): Promise<CreatedApiToken> {
        const accountId = params.accountId.trim();
        const label = params.label.trim();
        if (!accountId) {
            throw new Error("Cannot create an API token without an account id");
        }
        if (!label) {
            throw new Error("Cannot create an API token without a label");
        }

        const now = new Date();
        const expiresAt = params.expiresAt == null
            ? null
            : new Date(params.expiresAt.getTime());
        if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)) {
            throw new Error("API token expiry must be in the future");
        }

        const account = await db.account.findUnique({
            where: { id: accountId },
            select: { id: true },
        });
        if (!account) {
            throw new Error("Cannot create an API token for an unknown account");
        }

        const tokenId = randomUUID();
        const secret = randomBytes(API_TOKEN_SECRET_BYTES).toString("base64url");
        const displayPrefix = createApiTokenDisplayPrefix(tokenId);
        const secretDigest = createApiTokenSecretDigest(secret).toString("base64url");
        const row = await db.accountApiToken.create({
            data: {
                id: tokenId,
                accountId,
                displayPrefix,
                secretDigest,
                label,
                createdAt: now,
                expiresAt,
            },
            select: {
                id: true,
                label: true,
                displayPrefix: true,
                createdAt: true,
                expiresAt: true,
            },
        });

        return {
            tokenId: row.id,
            token: createApiTokenBearer(tokenId, secret),
            label: row.label,
            displayPrefix: row.displayPrefix,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
        };
    }

    /** Summaries deliberately omit the bearer secret and its stored digest. */
    async listApiTokens(accountId: string): Promise<readonly ApiTokenSummary[]> {
        const rows = await db.accountApiToken.findMany({
            where: { accountId: accountId.trim() },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                label: true,
                displayPrefix: true,
                createdAt: true,
                lastUsedAt: true,
                expiresAt: true,
            },
        });
        return rows.map((row) => ({
            tokenId: row.id,
            label: row.label,
            displayPrefix: row.displayPrefix,
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
            expiresAt: row.expiresAt,
        }));
    }

    /** Revocation is deletion: the next verification cannot find this selector. */
    async revokeApiToken(params: Readonly<{ accountId: string; tokenId: string }>): Promise<boolean> {
        const result = await db.accountApiToken.deleteMany({
            where: {
                id: params.tokenId,
                accountId: params.accountId.trim(),
            },
        });
        return result.count > 0;
    }

    /** Used by the present-user Action after its caller policy is registered. */
    async revokeAllApiTokens(accountId: string): Promise<number> {
        const result = await db.accountApiToken.deleteMany({
            where: { accountId: accountId.trim() },
        });
        return result.count;
    }

    async verifyToken(token: string): Promise<VerifiedAuthToken | null> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        // API tokens have a reserved bearer prefix. A malformed token must not
        // fall through to the signed-token verifier or gain a second auth path.
        if (isApiTokenCandidate(token)) {
            const verifiedPat = await this.verifyPat(token);
            if (!verifiedPat.ok) {
                return null;
            }
            return {
                userId: verifiedPat.principalId,
                authTokenKind: "api_token",
                authority: verifiedPat.authority,
            };
        }

        let decoded: DecodedAuthToken | null | undefined = this.tokenCache?.get(token);
        if (!decoded) {
            try {
                const verified = await this.tokens.verifier.verify(token);
                decoded = this.decodeAuthToken(verified);
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
        const account = await db.account.findUnique({
            where: { id: decoded.userId },
            select: { tokenEpoch: true },
        });
        if (!account || decoded.tokenEpoch < account.tokenEpoch) {
            return null;
        }

        return { userId: decoded.userId, extras: decoded.extras };
    }

    /**
     * Verifies only the fixed PAT format for server-side introspection. The
     * typed negative result is deliberately opaque; route boundaries serialize
     * it as the same invalid_token response for every credential failure.
     */
    async verifyPat(token: string, signal?: AbortSignal): Promise<VerifyPatResult> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        signal?.throwIfAborted();

        const parsed = parseApiToken(token);
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
        };
    }

    async signOutEverywhere(userId: string): Promise<number> {
        const account = await db.account.update({
            where: { id: userId },
            data: { tokenEpoch: { increment: 1 } },
            select: { tokenEpoch: true },
        });
        return account.tokenEpoch;
    }

    private async verifyParsedApiToken(
        parsed: ParsedApiToken,
        signal?: AbortSignal,
    ): Promise<VerifiedApiToken | null> {
        signal?.throwIfAborted();
        const row = await db.accountApiToken.findUnique({
            where: { id: parsed.tokenId },
            select: {
                id: true,
                accountId: true,
                secretDigest: true,
                expiresAt: true,
                lastUsedAt: true,
            },
        });
        signal?.throwIfAborted();
        if (!row || !apiTokenSecretDigestMatches(row.secretDigest, parsed.secret)) {
            return null;
        }

        const now = new Date();
        if (row.expiresAt && row.expiresAt <= now) {
            return null;
        }

        // The persistent Account row is the ownership and deletion check for
        // callers outside the Fastify eligibility gate.
        const account = await db.account.findUnique({
            where: { id: row.accountId },
            select: { id: true },
        });
        signal?.throwIfAborted();
        if (!account) {
            return null;
        }

        await this.recordApiTokenLastUse({
            tokenId: row.id,
            lastUsedAt: row.lastUsedAt,
            now,
        });
        signal?.throwIfAborted();
        return {
            accountId: row.accountId,
            credentialId: row.id,
            expiresAt: row.expiresAt,
        };
    }

    private async recordApiTokenLastUse(params: Readonly<{
        tokenId: string;
        lastUsedAt: Date | null;
        now: Date;
    }>): Promise<void> {
        const threshold = new Date(params.now.getTime() - API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS);
        if (params.lastUsedAt && params.lastUsedAt > threshold) {
            return;
        }

        try {
            await db.accountApiToken.updateMany({
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

    private decodeAuthToken(verified: unknown): DecodedAuthToken | null {
        if (typeof verified !== "object" || verified === null || Array.isArray(verified)) {
            return null;
        }

        const payload = verified as Readonly<Record<string, unknown>>;
        const userId = typeof payload.user === "string" ? payload.user.trim() : "";
        if (!userId) {
            return null;
        }

        const tokenExtras = this.asTokenExtras(payload.extras);
        if (!tokenExtras) {
            return null;
        }

        const rawTokenEpoch = tokenExtras.tokenEpoch;
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
            extras: this.withoutTokenEpoch(tokenExtras),
            tokenEpoch,
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
        const purpose =
            payload.purpose === "account_encryption_first_key"
                ? payload.purpose
                : null;
        const requestDigestCandidate =
            AccountEncryptionMigrateExternalAuthBindingDigestV1Schema
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
            purpose === "account_encryption_first_key"
            && (
                flow !== "auth"
                || !userId
                || !proofHash
                || !requestDigest
                || publicKey !== null
            )
        ) {
            throw new Error("Invalid OAuth first-key step-up binding");
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
        purpose?: "account_encryption_first_key";
        requestDigest?: string;
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
            const purpose =
                extras.purpose === "account_encryption_first_key"
                    ? extras.purpose
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
                AccountEncryptionMigrateExternalAuthBindingDigestV1Schema
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
                purpose === "account_encryption_first_key"
                && (
                    flow !== "auth"
                    || !userId
                    || !proofHash
                    || !requestDigest
                    || publicKey !== null
                )
            ) {
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
