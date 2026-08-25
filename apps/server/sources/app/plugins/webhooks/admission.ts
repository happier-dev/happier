const REDIS_ACQUIRE_SCRIPT_V1 = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local owner = ARGV[3]
local scopes = #KEYS / 2
for i = 1, scopes do
  local rateKey = KEYS[(i - 1) * 2 + 1]
  local concurrencyKey = KEYS[(i - 1) * 2 + 2]
  local rateLimit = tonumber(ARGV[3 + (i - 1) * 2 + 1])
  local concurrencyLimit = tonumber(ARGV[3 + (i - 1) * 2 + 2])
  local currentRate = tonumber(redis.call('GET', rateKey) or '0')
  if currentRate >= rateLimit then
    local retry = redis.call('PTTL', rateKey)
    if retry < 1 then retry = 1000 end
    return {0, retry, 1}
  end
  redis.call('ZREMRANGEBYSCORE', concurrencyKey, '-inf', now)
  if redis.call('ZCARD', concurrencyKey) >= concurrencyLimit then
    return {0, ttl, 2}
  end
end
for i = 1, scopes do
  local rateKey = KEYS[(i - 1) * 2 + 1]
  local concurrencyKey = KEYS[(i - 1) * 2 + 2]
  local rate = redis.call('INCR', rateKey)
  if rate == 1 then redis.call('PEXPIRE', rateKey, 60000) end
  redis.call('ZADD', concurrencyKey, now + ttl, owner)
  redis.call('PEXPIRE', concurrencyKey, ttl)
end
return {1, 0, 0}
`;

const REDIS_RELEASE_SCRIPT_V1 = `
local owner = ARGV[1]
local removed = 0
for i = 1, #KEYS do
  removed = removed + redis.call('ZREM', KEYS[i], owner)
end
return removed
`;

export type PluginWebhookAdmissionLeaseV1 = Readonly<{ release(): void }>;

/**
 * Working-memory cost of one admitted request, as a multiple of its declared
 * raw body.
 *
 * The raw body is only the first of several representations this process holds
 * simultaneously during the commit transaction: the fixed-size `Uint8Array`,
 * its base64 string, the parsed canonical content, the canonical (or sealed and
 * re-base64-encoded) envelope bytes, and the delivery owner's re-parse of them.
 * Charging the raw length alone therefore understates the resource this
 * reservation exists to bound by roughly an order of magnitude.
 *
 * Measured on this ingestion chain as `heapUsed + arrayBuffers`, in two ways.
 * Peak allocation over the chain (2026-08-23):
 *
 * | declared raw body | plain | E2EE |
 * |---:|---:|---:|
 * | 1 MiB  | 5.03x | 10.38x |
 * | 25 MiB | 5.00x | 10.27x |
 *
 * Retained set with every intermediate simultaneously reachable across a forced
 * collection, re-measured independently (three runs each, `--expose-gc`):
 *
 * | declared raw body | plain | E2EE |
 * |---:|---:|---:|
 * | 1 MiB  | 5.07x | 6.05x |
 * | 25 MiB | 5.00x | 5.89x |
 *
 * The two agree exactly for plain, where nothing on the chain is transient. For
 * E2EE they differ by the sealed copy of the canonical content and its base64
 * outer encoding, which the envelope builder drops once the canonical envelope
 * bytes exist. Concurrent requests can each be at that peak at the same moment,
 * so the peak is what this reservation must charge. The charge is the next
 * integer above the highest measured multiple, keeping it conservative for both
 * Account modes at every admitted body size.
 */
export const PLUGIN_WEBHOOK_WORKING_BYTES_PER_RAW_BYTE_V1 = 11;

/** Working bytes one request of this declared raw length reserves. */
export function chargePluginWebhookWorkingBytesV1(declaredRawBodyBytes: number): number {
    return declaredRawBodyBytes * PLUGIN_WEBHOOK_WORKING_BYTES_PER_RAW_BYTE_V1;
}

/**
 * Process-wide admission for public webhook ingress.
 *
 * The reservation is acquired from the declared `Content-Length` before a
 * single body byte is read, and it charges the measured working memory that
 * length costs rather than the length itself, so the byte ceiling is a real
 * per-replica memory bound instead of a raw-body custody bound.
 */
export function createPluginWebhookProcessAdmissionV1(policy: Readonly<{
    maxRequests: number;
    maxWorkingBytes: number;
}>) {
    if (!Number.isSafeInteger(policy.maxRequests) || policy.maxRequests < 1) {
        throw new TypeError("Plugin webhook process request ceiling must be a positive integer");
    }
    if (!Number.isSafeInteger(policy.maxWorkingBytes) || policy.maxWorkingBytes < 1) {
        throw new TypeError("Plugin webhook process working-memory ceiling must be a positive integer");
    }
    let requests = 0;
    let workingBytes = 0;
    return {
        acquire(declaredRawBodyBytes: number): PluginWebhookAdmissionLeaseV1 | null {
            if (!Number.isSafeInteger(declaredRawBodyBytes) || declaredRawBodyBytes < 0) return null;
            const charge = chargePluginWebhookWorkingBytesV1(declaredRawBodyBytes);
            if (
                requests + 1 > policy.maxRequests
                || workingBytes + charge > policy.maxWorkingBytes
            ) return null;
            requests += 1;
            workingBytes += charge;
            let released = false;
            return {
                release() {
                    if (released) return;
                    released = true;
                    requests -= 1;
                    workingBytes -= charge;
                },
            };
        },
        snapshot(): Readonly<{ requests: number; workingBytes: number }> {
            return { requests, workingBytes };
        },
    };
}

export type PluginWebhookDistributedScopeV1 = Readonly<{
    key: string;
    ratePerMinute: number;
    concurrency: number;
}>;

type RedisEvalClientV1 = Readonly<{
    eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}>;

function readRedisTuple(value: unknown): readonly [number, number, number] | null {
    if (!Array.isArray(value) || value.length < 3) return null;
    const accepted = Number(value[0]);
    const retryAfterMs = Number(value[1]);
    const rejectionCode = Number(value[2]);
    return Number.isFinite(accepted) && Number.isFinite(retryAfterMs) && Number.isFinite(rejectionCode)
        ? [accepted, retryAfterMs, rejectionCode]
        : null;
}

export function createPluginWebhookRedisAdmissionV1(redis: RedisEvalClientV1) {
    return {
        async acquire(
            scopes: readonly PluginWebhookDistributedScopeV1[],
            options: Readonly<{ nowMs: number; ttlMs: number; ownerToken: string }>,
        ): Promise<
            | Readonly<{ ok: true; release(): Promise<void> }>
            | Readonly<{ ok: false; code: "rate" | "concurrency" | "unavailable"; retryAfterMs: number }>
        > {
            if (scopes.length === 0) return { ok: true, async release() {} };
            if (
                !Number.isSafeInteger(options.nowMs)
                || !Number.isSafeInteger(options.ttlMs)
                || options.ttlMs < 1
                || !/^[A-Za-z0-9._:-]{1,128}$/u.test(options.ownerToken)
            ) {
                throw new TypeError("Plugin webhook distributed admission identity is invalid");
            }
            for (const scope of scopes) {
                if (
                    !/^[A-Za-z0-9._:-]{1,256}$/u.test(scope.key)
                    || !Number.isSafeInteger(scope.ratePerMinute)
                    || scope.ratePerMinute < 1
                    || !Number.isSafeInteger(scope.concurrency)
                    || scope.concurrency < 1
                ) {
                    throw new TypeError("Plugin webhook distributed admission scope is invalid");
                }
            }
            const keys = scopes.flatMap((scope) => [
                `happier:webhooks:v1:rate:${scope.key}`,
                `happier:webhooks:v1:concurrency:${scope.key}`,
            ]);
            const policy = scopes.flatMap((scope) => [scope.ratePerMinute, scope.concurrency]);
            try {
                const tuple = readRedisTuple(await redis.eval(
                    REDIS_ACQUIRE_SCRIPT_V1,
                    keys.length,
                    ...keys,
                    options.nowMs,
                    options.ttlMs,
                    options.ownerToken,
                    ...policy,
                ));
                if (!tuple) return { ok: false, code: "unavailable", retryAfterMs: 5_000 };
                if (tuple[0] !== 1) {
                    return {
                        ok: false,
                        code: tuple[2] === 1 ? "rate" : tuple[2] === 2 ? "concurrency" : "unavailable",
                        retryAfterMs: Math.max(1, Math.min(60_000, Math.trunc(tuple[1]))),
                    };
                }
                let released = false;
                const concurrencyKeys = keys.filter((_, index) => index % 2 === 1);
                return {
                    ok: true,
                    async release() {
                        if (released) return;
                        released = true;
                        try {
                            await redis.eval(
                                REDIS_RELEASE_SCRIPT_V1,
                                concurrencyKeys.length,
                                ...concurrencyKeys,
                                options.ownerToken,
                            );
                        } catch {
                            // The bounded TTL is the fail-safe cleanup owner after a partition.
                        }
                    },
                };
            } catch {
                return { ok: false, code: "unavailable", retryAfterMs: 5_000 };
            }
        },
    };
}
