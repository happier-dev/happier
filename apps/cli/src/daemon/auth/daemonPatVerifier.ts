import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export const DAEMON_PAT_CACHE_MAX_AGE_MS = 60_000;
// This caps untrusted distinct bearer inputs to fixed daemon memory. An LRU
// eviction only forces a fresh server decision; it can never extend authority.
export const DAEMON_PAT_CACHE_MAX_ENTRIES = 256;

export type VerifiedDaemonPat = Readonly<{
    ok: true;
    accountId: string;
    principalId: string;
    credentialId: string;
    expiresAt: Date | null;
    authority: "account_automation";
}>;

export type DaemonPatVerificationFailure = Readonly<{
    ok: false;
    code: "invalid_token" | "auth_unavailable";
}>;

export type DaemonPatVerification = VerifiedDaemonPat | DaemonPatVerificationFailure;

/** Transport-neutral seam consumed by the daemon's public Action route. */
export type DaemonPatVerifier = (token: string, signal?: AbortSignal) => Promise<DaemonPatVerification>;

/** The configured Account-server request behind a daemon verifier cache miss. */
export type DaemonPatIntrospector = DaemonPatVerifier;

type CacheEntry = Readonly<{
    accountId: string;
    principalId: string;
    credentialId: string;
    patExpiresAtMs: number | null;
    cacheExpiresAtMonotonicMs: number;
}>;

type DaemonPatVerifierOptions = Readonly<{
    /** The Account to which this daemon connection is already bound. */
    accountId: string;
    introspect: DaemonPatIntrospector;
    /** Wall clock; used only for absolute PAT expiry comparisons. */
    now?: () => number;
    /** Monotonic elapsed clock; owns the bounded positive-cache TTL. */
    monotonicNow?: () => number;
    maxEntries?: number;
}>;

/**
 * Hashes the complete bearer before it reaches the in-memory LRU. The raw PAT
 * is only the transient argument passed to the Account-server introspector.
 */
export function hashDaemonPatCacheKey(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

function verificationFromEntry(entry: CacheEntry): VerifiedDaemonPat {
    return {
        ok: true,
        accountId: entry.accountId,
        principalId: entry.principalId,
        credentialId: entry.credentialId,
        expiresAt: entry.patExpiresAtMs === null ? null : new Date(entry.patExpiresAtMs),
        authority: "account_automation",
    };
}

function verificationFromServer(result: VerifiedDaemonPat): VerifiedDaemonPat {
    return {
        ok: true,
        accountId: result.accountId,
        principalId: result.principalId,
        credentialId: result.credentialId,
        expiresAt: result.expiresAt === null ? null : new Date(result.expiresAt.getTime()),
        authority: "account_automation",
    };
}

function unavailable(): DaemonPatVerificationFailure {
    return { ok: false, code: "auth_unavailable" };
}

function invalidToken(): DaemonPatVerificationFailure {
    return { ok: false, code: "invalid_token" };
}

function awaitWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

/**
 * Produces the sole daemon-side PAT verifier. Successful Account-server
 * responses are kept only in an in-memory bounded LRU for at most 60 seconds of
 * monotonic elapsed time (wall-clock rollback cannot extend them) and never
 * past the PAT's absolute wall-clock expiry; no negative, persistent, refresh,
 * or offline-cache path exists.
 */
export function createDaemonPatVerifier(options: DaemonPatVerifierOptions): DaemonPatVerifier {
    if (!options.accountId.trim()) {
        throw new Error("Daemon PAT verifier requires a bound Account ID");
    }

    const maxEntries = options.maxEntries ?? DAEMON_PAT_CACHE_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
        throw new Error("Daemon PAT verifier cache size must be a positive integer");
    }

    const now = options.now ?? Date.now;
    // Elapsed TTL time must not inherit wall-clock adjustments: a backwards NTP
    // step would otherwise extend the promised <=60s positive cache interval.
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const cache = new Map<string, CacheEntry>();
    const inFlight = new Map<string, Promise<DaemonPatVerification>>();

    const verifyMiss = async (
        token: string,
        cacheKey: string,
        cacheExpiresAtMonotonicMs: number,
    ): Promise<DaemonPatVerification> => {
        let verified: DaemonPatVerification;
        try {
            // A caller's cancellation must not cancel a shared verification
            // that another caller is still awaiting.
            verified = await options.introspect(token);
        } catch {
            return unavailable();
        }

        if (!verified.ok) return verified;
        if (verified.accountId !== options.accountId || verified.authority !== "account_automation") {
            return invalidToken();
        }

        const patExpiresAtMs = verified.expiresAt?.getTime() ?? null;
        if (patExpiresAtMs !== null && !Number.isFinite(patExpiresAtMs)) return unavailable();

        const verifiedAtMs = now();
        if (patExpiresAtMs !== null && patExpiresAtMs <= verifiedAtMs) return invalidToken();
        // The grace window starts when the Account-server decision begins, not
        // when a delayed response arrives. Otherwise introspection latency would
        // silently extend the documented <=60s local revocation window.
        if (monotonicNow() >= cacheExpiresAtMonotonicMs) {
            return verificationFromServer(verified);
        }
        cache.set(cacheKey, {
            accountId: verified.accountId,
            principalId: verified.principalId,
            credentialId: verified.credentialId,
            patExpiresAtMs,
            cacheExpiresAtMonotonicMs,
        });
        while (cache.size > maxEntries) {
            const leastRecentlyUsedKey = cache.keys().next().value;
            if (leastRecentlyUsedKey === undefined) break;
            cache.delete(leastRecentlyUsedKey);
        }
        return verificationFromServer(verified);
    };

    return async (token, signal) => {
        signal?.throwIfAborted();

        const cacheKey = hashDaemonPatCacheKey(token);
        const cached = cache.get(cacheKey);
        if (cached) {
            // The bounded TTL runs on elapsed monotonic time; absolute PAT
            // expiry stays on the wall clock. Both gates must accept a hit.
            const ttlCurrent = monotonicNow() < cached.cacheExpiresAtMonotonicMs;
            const patCurrent = cached.patExpiresAtMs === null || now() < cached.patExpiresAtMs;
            if (ttlCurrent && patCurrent) {
                // A read moves the entry to the LRU tail but never changes its expiry.
                cache.delete(cacheKey);
                cache.set(cacheKey, cached);
                return verificationFromEntry(cached);
            }
            cache.delete(cacheKey);
        }

        let pending = inFlight.get(cacheKey);
        if (!pending) {
            // The same configured bound caps both retained positive results and
            // distinct Account-server decisions awaiting settlement. Existing
            // keys coalesce above this check, so saturation never rejects a
            // caller already sharing an admitted verification.
            if (inFlight.size >= maxEntries) return unavailable();
            const cacheExpiresAtMonotonicMs = monotonicNow() + DAEMON_PAT_CACHE_MAX_AGE_MS;
            pending = verifyMiss(token, cacheKey, cacheExpiresAtMonotonicMs);
            inFlight.set(cacheKey, pending);
            void pending.then(
                () => {
                    if (inFlight.get(cacheKey) === pending) inFlight.delete(cacheKey);
                },
                () => {
                    if (inFlight.get(cacheKey) === pending) inFlight.delete(cacheKey);
                },
            );
        }
        return awaitWithAbortSignal(pending, signal);
    };
}
