/**
 * Supplies target-specific measurements for the Lane 02.04 §3 primitive gate.
 *
 * Measures the asynchronous Node standard-library `crypto.scrypt` path at the
 * current OWASP Password Storage baseline (N=2^17, r=8, p=1) for verification
 * latency, resident memory, concurrency behaviour, cancellation semantics and
 * the admission point where load shedding has to happen. Run it on the actual
 * deployment image before changing the persisted parameters:
 *
 *   node ./scripts/runTsx.mjs --tsconfig ./tsconfig.exec.json \
 *     ./scripts/benchmarkPasswordHashPrimitive.ts
 */
import { randomBytes, scrypt } from 'node:crypto';
import { cpus, totalmem } from 'node:os';

// OWASP Password Storage Cheat Sheet baseline: N=2^17 (128 MiB), r=8, p=1.
// The sweep also measures the cheaper costs because the baseline has to be
// affordable on the real deployment image before it can be persisted.
const COSTS = (process.env.SCRYPT_COSTS ?? '14,15,16,17')
    .split(',').map((exponent) => 2 ** Number(exponent.trim()));
const R = 8;
// The OWASP ladder trades cost for parallelism at equal work, and `p` does not
// change the 128*N*r working set, so the cheaper-memory rungs are the ones a
// bounded libuv threadpool can actually serve.
const P = Number(process.env.SCRYPT_P ?? '1');
const KEY_LENGTH = 32;

const PASSWORD = 'correct horse battery staple extra';

function footprintBytes(cost: number): number {
    return 128 * cost * R;
}

// Node rejects a run whose 128 * N * r footprint exceeds `maxmem` (default
// 32 MiB), so the ceiling is derived from the parameters plus headroom.
function maxMemBytes(cost: number): number {
    return footprintBytes(cost) + 32 * 1024 * 1024;
}

function hashOnce(cost: number, salt: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        scrypt(PASSWORD, salt, KEY_LENGTH, { N: cost, r: R, p: P, maxmem: maxMemBytes(cost) }, (error) => {
            if (error) reject(error); else resolve();
        });
    });
}

function summarize(samplesMs: readonly number[]): string {
    const sorted = [...samplesMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    return `mean=${mean.toFixed(0)}ms p50=${at(0.5).toFixed(0)}ms p95=${at(0.95).toFixed(0)}ms `
        + `min=${sorted[0].toFixed(0)}ms max=${sorted[sorted.length - 1].toFixed(0)}ms`;
}

async function measureSequential(cost: number, iterations: number): Promise<void> {
    const samples: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
        const salt = new Uint8Array(randomBytes(16));
        const startedAt = performance.now();
        await hashOnce(cost, salt);
        samples.push(performance.now() - startedAt);
    }
    console.log(`  sequential x${iterations}: ${summarize(samples)}`);
}

async function measureConcurrency(cost: number, concurrent: number): Promise<void> {
    global.gc?.();
    const baselineRssBytes = process.memoryUsage().rss;
    let peakRssBytes = baselineRssBytes;
    const sampler = setInterval(() => {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 5);
    const startedAt = performance.now();
    const samples = await Promise.all(Array.from({ length: concurrent }, async () => {
        const salt = new Uint8Array(randomBytes(16));
        const operationStartedAt = performance.now();
        await hashOnce(cost, salt);
        return performance.now() - operationStartedAt;
    }));
    const wallMs = performance.now() - startedAt;
    clearInterval(sampler);
    const rssDeltaKiB = Math.round((peakRssBytes - baselineRssBytes) / 1024);
    console.log(`  concurrent=${concurrent}: wall=${wallMs.toFixed(0)}ms `
        + `throughput=${(concurrent / (wallMs / 1000)).toFixed(2)}/s `
        + `peakRssDelta=${rssDeltaKiB}KiB ${summarize(samples)}`);
}

/**
 * Node exposes no abort signal for `crypto.scrypt`. Confirm that an abandoned
 * caller still pays for the full native run so admission control, not
 * post-dispatch cancellation, is the only place load shedding can work.
 */
async function measureCancellation(cost: number): Promise<void> {
    const salt = new Uint8Array(randomBytes(16));
    const startedAt = performance.now();
    let settledAtMs = 0;
    const inFlight = hashOnce(cost, salt).then(() => { settledAtMs = performance.now() - startedAt; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abandonedAtMs = performance.now() - startedAt;
    await inFlight;
    console.log(`  cancellation: caller abandoned at ${abandonedAtMs.toFixed(0)}ms, `
        + `native work still completed at ${settledAtMs.toFixed(0)}ms `
        + '(no abort signal exists; shed before dispatch)');
}

/**
 * The libuv threadpool is the real dispatch bound. Show what an unbounded
 * arrival burst does to tail latency so the queue ceiling is derived from
 * observed queueing rather than a nearby round number.
 */
async function measureQueueing(cost: number, arrivals: number): Promise<void> {
    const startedAt = performance.now();
    const samples = await Promise.all(Array.from({ length: arrivals }, async () => {
        const salt = new Uint8Array(randomBytes(16));
        const queuedAt = performance.now();
        await hashOnce(cost, salt);
        return performance.now() - queuedAt;
    }));
    console.log(`  burst=${arrivals}: wall=${(performance.now() - startedAt).toFixed(0)}ms ${summarize(samples)}`);
}

async function main(): Promise<void> {
    console.log(`node=${process.version} platform=${process.platform}/${process.arch} `
        + `cpus=${cpus().length} totalmem=${Math.round(totalmem() / 1048576)}MiB `
        + `threadpool=${process.env.UV_THREADPOOL_SIZE ?? '4 (default)'}`);

    for (const cost of COSTS) {
        console.log(`scrypt N=${cost} r=${R} p=${P} keyLength=${KEY_LENGTH} `
            + `footprint=${Math.round(footprintBytes(cost) / 1048576)}MiB `
            + `maxmem=${Math.round(maxMemBytes(cost) / 1048576)}MiB`);
        await hashOnce(cost, new Uint8Array(randomBytes(16))); // warm up OpenSSL + allocator
        await measureSequential(cost, 10);
        for (const concurrent of [1, 2, 4, 8, 16]) {
            await measureConcurrency(cost, concurrent);
        }
        await measureCancellation(cost);
        await measureQueueing(cost, 32);
    }
}

await main();
