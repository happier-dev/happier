import * as privacyKit from "privacy-kit";
import { createHash } from "node:crypto";
import { log } from "@/utils/logging/log";
import {
    isOAuthStateUnavailableError,
    OAuthStateUnavailableError,
} from "./oauthStateErrors";

interface TokenCacheEntry {
    userId: string;
    extras?: any;
    cachedAt: number;
}

interface TokenGeneratorLike {
    new: (payload: any) => Promise<string>;
    publicKey: Uint8Array | number[];
}

interface TokenVerifierLike {
    verify: (token: string) => Promise<any>;
}

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
}>;

class AuthModule {
    private tokenCache = new Map<string, TokenCacheEntry>();
    private tokens: AuthTokens | null = null;
    private oauthStateTokens: OAuthStateTokens | null = null;
    private oauthStateTokensInitPromise: Promise<OAuthStateTokens> | null = null;
    
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

    private resolvePersistentSeedCompatibilityAttempts(env: NodeJS.ProcessEnv): number {
        const raw = (env.HAPPIER_AUTH_SEED_COMPAT_ATTEMPTS ?? "").toString().trim();
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        const attempts = Number.isFinite(parsed) && parsed > 0 ? parsed : 32;
        return Math.max(1, Math.min(64, attempts));
    }

    private isRetryableRuntimeSeedCompatibilityError(error: unknown): boolean {
        if (!error || typeof error !== "object") {
            return false;
        }
        const errorName =
            typeof (error as { name?: unknown }).name === "string"
                ? String((error as { name?: unknown }).name)
                : "";
        const errorMessage =
            typeof (error as { message?: unknown }).message === "string"
                ? String((error as { message?: unknown }).message)
                : "";
        return (
            errorName === "DataError" ||
            /data provided to an operation does not meet requirements/i.test(errorMessage)
        );
    }

    private derivePersistentSeedCandidate(masterSecret: string, attempt: number): string {
        if (attempt === 0) {
            return masterSecret;
        }
        return createHash("sha256")
            .update(`happier-auth-seed-v1:${attempt}:${masterSecret}`)
            .digest("base64url");
    }

    private async createPersistentAuthTokens(masterSecret: string): Promise<AuthTokens> {
        const maxAttempts = this.resolvePersistentSeedCompatibilityAttempts(process.env);
        let lastError: unknown = null;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const seed = this.derivePersistentSeedCandidate(masterSecret, attempt);
            try {
                const generator = await privacyKit.createPersistentTokenGenerator({
                    service: "handy",
                    seed,
                });
                const verifier = await privacyKit.createPersistentTokenVerifier({
                    service: "handy",
                    publicKey: Uint8Array.from(generator.publicKey),
                });
                if (attempt > 0) {
                    log(
                        { module: "auth", level: "warn" },
                        `Persistent auth seed required runtime compatibility derivation (attempt=${attempt + 1})`,
                    );
                }
                return { generator, verifier };
            } catch (error) {
                lastError = error;
                if (
                    attempt < maxAttempts - 1 &&
                    this.isRetryableRuntimeSeedCompatibilityError(error)
                ) {
                    continue;
                }
                throw error;
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error("Failed to initialize persistent auth tokens");
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
            } catch {
                log(
                    { module: "auth", level: "warn" },
                    "OAuth state backend unavailable (ephemeral token init failed)"
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
        
        log({ module: 'auth' }, 'Auth module initialized');
    }
    
    async createToken(userId: string, extras?: any): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload: any = { user: userId };
        if (extras) {
            payload.extras = extras;
        }
        
        const token = await this.tokens.generator.new(payload);
        
        // Cache the token immediately
        this.tokenCache.set(token, {
            userId,
            extras,
            cachedAt: Date.now()
        });
        
        return token;
    }
    
    async verifyToken(token: string): Promise<{ userId: string; extras?: any } | null> {
        // Check cache first
        const cached = this.tokenCache.get(token);
        if (cached) {
            return {
                userId: cached.userId,
                extras: cached.extras
            };
        }
        
        // Cache miss - verify token
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            const verified = await this.tokens.verifier.verify(token);
            if (!verified) {
                return null;
            }
            
            const userId = verified.user as string;
            const extras = verified.extras;
            
            // Cache the result permanently
            this.tokenCache.set(token, {
                userId,
                extras,
                cachedAt: Date.now()
            });
            
            return { userId, extras };
            
        } catch (error) {
            log({ module: 'auth', level: 'error' }, `Token verification failed: ${error}`);
            return null;
        }
    }
    
    invalidateUserTokens(userId: string): void {
        // Remove all tokens for a specific user
        // This is expensive but rarely needed
        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.userId === userId) {
                this.tokenCache.delete(token);
            }
        }
        
        log({ module: 'auth' }, `Invalidated tokens for user: ${userId}`);
    }
    
    invalidateToken(token: string): void {
        this.tokenCache.delete(token);
    }
    
    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }
        
        let oldest = Date.now();
        for (const entry of this.tokenCache.values()) {
            if (entry.cachedAt < oldest) {
                oldest = entry.cachedAt;
            }
        }
        
        return {
            size: this.tokenCache.size,
            oldestEntry: oldest
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

        return await oauthStateTokens.oauthStateGenerator.new({
            user: "oauth-state",
            extras: {
                provider,
                flow,
                sid,
                userId,
                publicKey,
            },
        });
    }

    async verifyOauthStateToken(token: string): Promise<{
        flow: "connect" | "auth";
        provider: string;
        sid: string | null;
        userId: string | null;
        publicKey: string | null;
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

            return {
                flow,
                provider,
                sid: typeof extras.sid === "string" && extras.sid.trim() ? extras.sid.trim() : null,
                userId: typeof extras.userId === "string" && extras.userId.trim() ? extras.userId.trim() : null,
                publicKey:
                    typeof extras.publicKey === "string" && extras.publicKey.trim()
                        ? extras.publicKey.trim()
                        : null,
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
        // Note: Since tokens are cached "forever" as requested,
        // we don't do automatic cleanup. This method exists if needed later.
        const stats = this.getCacheStats();
        log({ module: 'auth' }, `Token cache size: ${stats.size} entries`);
    }
}

// Global instance
export const auth = new AuthModule();
