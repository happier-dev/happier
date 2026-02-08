import { parseIntEnv } from "@/config/env";

export type UsernamePolicy = Readonly<{ minLen: number; maxLen: number; pattern: RegExp }>;

function clampPolicy(policy: { minLen: number; maxLen: number; pattern: RegExp }): UsernamePolicy {
    const minLen = Number.isFinite(policy.minLen) && policy.minLen > 0 ? policy.minLen : 3;
    const maxLen = Number.isFinite(policy.maxLen) && policy.maxLen > 0 ? policy.maxLen : 32;
    const normalized = minLen > maxLen ? { minLen: maxLen, maxLen: minLen, pattern: policy.pattern } : policy;
    return Object.freeze({
        minLen: normalized.minLen,
        maxLen: normalized.maxLen,
        pattern: normalized.pattern,
    });
}

let _lastPolicyCacheKey: string | null = null;
let _lastResolvedPolicy: UsernamePolicy | null = null;

export function resolveUsernamePolicyFromEnv(env: NodeJS.ProcessEnv): UsernamePolicy {
    const minLenRaw = (env.FRIENDS_USERNAME_MIN_LEN ?? "3").toString();
    const maxLenRaw = (env.FRIENDS_USERNAME_MAX_LEN ?? "32").toString();
    const rawPattern = (env.FRIENDS_USERNAME_REGEX ?? "^[a-z0-9_-]+$").toString();

    const cacheKey = `${minLenRaw}|${maxLenRaw}|${rawPattern}`;
    if (_lastResolvedPolicy && _lastPolicyCacheKey === cacheKey) {
        return _lastResolvedPolicy;
    }

    let pattern: RegExp;
    try {
        pattern = new RegExp(rawPattern);
    } catch {
        pattern = /^[a-z0-9_-]+$/;
    }

    const resolved = clampPolicy({
        minLen: parseIntEnv(minLenRaw, 3, { min: 1, max: 128 }),
        maxLen: parseIntEnv(maxLenRaw, 32, { min: 1, max: 128 }),
        pattern,
    });

    _lastPolicyCacheKey = cacheKey;
    _lastResolvedPolicy = resolved;
    return resolved;
}

export function normalizeUsername(input: string): string {
    return input.trim().toLowerCase();
}

export function validateUsername(input: string, env: NodeJS.ProcessEnv): { ok: true; username: string } | { ok: false } {
    const policy = resolveUsernamePolicyFromEnv(env);
    const username = normalizeUsername(input);
    if (username.length < policy.minLen) return { ok: false };
    if (username.length > policy.maxLen) return { ok: false };
    if (!policy.pattern.test(username)) return { ok: false };
    return { ok: true, username };
}
