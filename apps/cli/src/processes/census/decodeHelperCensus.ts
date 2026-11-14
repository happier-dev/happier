import { z } from 'zod/mini';
import type { ProcessCensusSnapshot } from './processCensus';

const unsigned = z.number().check(z.int(), z.nonnegative(), z.int());
const principal = z.strictObject({ kind: z.enum(['uid', 'sid']), value: z.string().check(z.minLength(1)) });
const ownershipEnvironment = z.strictObject({
    HAPPIER_HOME_DIR: z.optional(z.string()), HAPPIER_ACTIVE_SERVER_ID: z.optional(z.string()),
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: z.optional(z.string()), HAPPIER_SERVER_URL: z.optional(z.string()),
    HAPPIER_WEBAPP_URL: z.optional(z.string()), HAPPIER_PUBLIC_SERVER_URL: z.optional(z.string()),
});
export const ProcessStartIdentitySchema = z.strictObject({ startTimeMs: unsigned, native: z.optional(z.string()) });
/** One process generation: a pid plus the native start identity it was born with. */
export const ProcessBirthWitnessSchema = z.strictObject({ pid: unsigned.check(z.positive()), start: ProcessStartIdentitySchema });
const rowSchema = z.strictObject({
    pid: unsigned.check(z.positive()), ppid: z.nullable(unsigned), pgid: z.optional(z.number().check(z.int(), z.int())), sessionId: z.optional(unsigned.check(z.positive())),
    start: ProcessStartIdentitySchema,
    principal: z.nullable(principal), name: z.string(),
    executablePath: z.optional(z.string()), argv: z.optional(z.array(z.string())), commandLine: z.optional(z.string()),
    cwd: z.optional(z.string()), ownerTag: z.optional(z.string()), ownershipEnvironment: z.optional(ownershipEnvironment),
    memory: z.nullable(z.strictObject({ bytes: unsigned, kind: z.enum(['rss', 'footprint', 'private', 'working_set']) })),
    cpuTimeUs: z.nullable(unsigned), cgroup: z.optional(z.string()), jobs: z.optional(z.array(z.string())),
    state: z.optional(z.enum(['running', 'sleeping', 'stopped', 'zombie', 'other'])), tpgid: z.optional(z.number().check(z.int(), z.int())),
});
const helperSchema = z.strictObject({
    v: z.literal(1), capturedAtMs: unsigned, logicalCpus: unsigned.check(z.positive()), rows: z.array(rowSchema),
    partial: z.optional(z.array(z.strictObject({ pid: unsigned, missing: z.array(z.string()) }))),
    jobObservations: z.optional(z.array(z.discriminatedUnion('state', [
        z.strictObject({ name: z.string().check(z.minLength(1)), state: z.literal('live'), pids: z.array(unsigned.check(z.positive())).check(z.minLength(1)) }),
        z.strictObject({ name: z.string().check(z.minLength(1)), state: z.literal('absent'), pids: z.optional(z.array(unsigned.check(z.positive())).check(z.maxLength(0))) }),
        z.strictObject({ name: z.string().check(z.minLength(1)), state: z.literal('unavailable') }),
    ]))),
});

export function decodeHelperCensus(output: string, selfPid: number, verifiedJobNames?: readonly string[]): ProcessCensusSnapshot {
    try {
        const decoded = helperSchema.safeParse(JSON.parse(output));
        if (!decoded.success) return { status: 'unavailable', reason: 'read_failed' };
        const data = decoded.data;
        const observed = new Set<string>();
        for (const job of data.jobObservations ?? []) {
            if (observed.has(job.name) || (job.state === 'live' && new Set(job.pids).size !== job.pids.length)) return { status: 'unavailable', reason: 'read_failed' };
            observed.add(job.name);
        }
        if (verifiedJobNames && (observed.size !== verifiedJobNames.length || verifiedJobNames.some(name => !observed.has(name)))) return { status: 'unavailable', reason: 'read_failed' };
        const self = data.rows.find(row => row.pid === selfPid);
        if (!self) return { status: 'unavailable', reason: 'self_absent' };
        const seen = new Set<number>();
        for (const row of data.rows) {
            if (seen.has(row.pid)) return { status: 'unavailable', reason: 'read_failed' };
            seen.add(row.pid);
            const own = row.principal !== null && self.principal !== null
                && row.principal.kind === self.principal.kind && row.principal.value === self.principal.value;
            if (!own && (row.argv !== undefined || row.commandLine !== undefined || row.cwd !== undefined
                || row.executablePath !== undefined || row.ownerTag !== undefined || row.ownershipEnvironment !== undefined)) {
                return { status: 'unavailable', reason: 'read_failed' };
            }
        }
        return { status: 'ok', capturedAtMs: data.capturedAtMs, logicalCpus: data.logicalCpus, rows: data.rows,
            ...(data.jobObservations ? { jobObservations: data.jobObservations } : {}),
            ...(data.partial ? { partial: data.partial } : {}) };
    } catch {
        return { status: 'unavailable', reason: 'read_failed' };
    }
}
