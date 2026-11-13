import { readdir, readlink } from 'node:fs/promises';
import { cpus } from 'node:os';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import type { ProcessCustodySamplingExecFile } from '@/subprocess/supervision/processCustody';
import { createLinuxCensusReader, DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS, type LinuxCensusBoundary } from './linux';
import { readLinuxProcFile } from './linuxProcfs';
import { decodeHelperCensus } from './decodeHelperCensus';
import { ancestorsOf, descendantsOf, indexCensus } from '../tree/processTree';

export type ProcessCensusFreshness = 'shared' | 'fresh';
export type ProcessCensusField = 'argv' | 'cwd' | 'executablePath' | 'ownershipEnvironment' | 'cgroup' | 'memory' | 'cpuTimeUs';
export type ProcessStartIdentity = Readonly<{ startTimeMs: number; native?: string }>;
export { ProcessStartIdentitySchema } from './decodeHelperCensus';
export type ProcessPrincipal = Readonly<{ kind: 'uid' | 'sid'; value: string }>;
export { DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS };
export type DaemonOwnershipEnvironment = Partial<Record<typeof DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS[number], string>>;
export type ProcessCensusRow = Readonly<{
    pid: number; ppid: number | null; pgid?: number;
    /** POSIX session leader PID, needed even after the reading process is reparented. */
    sessionId?: number;
    start: ProcessStartIdentity; principal: ProcessPrincipal | null; name: string;
    executablePath?: string; argv?: readonly string[];
    /** Original Windows command line, preserved for persisted command-hash comparisons. Daemon-private. */
    commandLine?: string;
    cwd?: string; ownerTag?: string; ownershipEnvironment?: DaemonOwnershipEnvironment;
    memory: Readonly<{ bytes: number; kind: 'rss' | 'footprint' | 'private' | 'working_set' }> | null;
    cpuTimeUs: number | null;
    cgroup?: string; jobs?: readonly string[];
    state?: 'running' | 'sleeping' | 'stopped' | 'zombie' | 'other'; tpgid?: number;
}>;
export type ProcessCensusSnapshot =
    | Readonly<{ status: 'ok'; capturedAtMs: number; logicalCpus: number; rows: readonly ProcessCensusRow[];
        jobObservations?: readonly ProcessCensusJobObservation[];
        partial?: readonly Readonly<{ pid: number; missing: readonly string[] }>[] }>
    | Readonly<{ status: 'unavailable'; reason: 'helper_missing' | 'read_failed' | 'self_absent' | 'unsupported_platform' }>;
export type ProcessCensusJobObservation =
    | Readonly<{ name: string; state: 'live'; pids: readonly number[] }>
    | Readonly<{ name: string; state: 'absent'; pids?: readonly number[] }>
    | Readonly<{ name: string; state: 'unavailable' }>;
export type ProcessCensusInput = Readonly<{
    freshness: ProcessCensusFreshness; pids?: readonly number[]; scope?: 'own_principal' | 'all';
    /** Existing custody authority supplies names; observation alone never grants ownership. */
    verifiedJobNames?: readonly string[];
    /** Observations needed by this consumer. Empty selects identity-only reads; omitted preserves the full census. */
    fields?: readonly ProcessCensusField[];
    /** Filtered reads include current target/reader ancestors for signal protection. */
    includeAncestors?: boolean;
    /** Fresh subtree observation. Linux walks every thread's children; native
     * platforms retain their complete inventory before selecting descendants. */
    includeDescendants?: boolean;
    /** Linux: enrich argv/cwd/executable only for these PIDs and their canonical ancestor chains.
     * Keep the full identity/ownership table for native roots and group-peer evidence.
     */
    commandRoots?: readonly number[];
}>;
export type ProcessCensusExecFile = ProcessCustodySamplingExecFile;
export type ProcessCensusDependencies = Readonly<{
    platform?: NodeJS.Platform; selfPid?: number; now?: () => number;
    linuxBoundary?: LinuxCensusBoundary; logicalCpus?: number;
    execFile?: ProcessCensusExecFile; helperExecutablePath?: string | null;
}>;

/** Only in-flight shared rows are retained. Linux's immutable page size is reader-local. */
export function createProcessCensusReader(dependencies: ProcessCensusDependencies = {}) {
    const inFlight = new Map<string, Promise<ProcessCensusSnapshot>>();
    const platform = dependencies.platform ?? process.platform;
    const selfPid = dependencies.selfPid ?? process.pid;
    const readLinux = createLinuxCensusReader(dependencies.linuxBoundary ?? { readFile: readLinuxProcFile, readdir, readlink });
    async function observeNativeCensus<T>(capturedAtMs: number, operation: () => Promise<T>): Promise<T> {
        const startedAtMs = Date.now();
        try { return await operation(); }
        finally {
            const { logger } = await import('@/ui/logger');
            logger.debug('[process-census] Observation phase settled', {
                phase: 'native_census', platform, capturedAtMs, elapsedMs: Date.now() - startedAtMs,
            });
        }
    }
    // Linux's targeted census serves account-free internal CHECK/stop entries.
    // Native helper setup must not initialize an unrelated Account home there.
    type NativeInvoker = ReturnType<typeof import('@/subprocess/supervision/processCustody').createProcessCustodySamplingInvoker>;
    let nativeInvoker: Promise<NativeInvoker> | undefined;
    const invokeNative = async (input: Parameters<NativeInvoker>[0]) => {
        const invoke = await (nativeInvoker ??= import('@/subprocess/supervision/processCustody').then(custody =>
            custody.createProcessCustodySamplingInvoker({
                execFile: (file, args, options) => {
                    const execute = () => (dependencies.execFile ?? execFileWithDeadline)(file, args, options);
                    // Observe actual helper execution, after missing-helper/backoff admission.
                    return args.some(arg => arg.startsWith('--pids=')) ? execute()
                        : observeNativeCensus((dependencies.now ?? Date.now)(), execute);
                },
                resolveExecutable: () => dependencies.helperExecutablePath === undefined
                    ? custody.resolveProcessCustodySupportExecutable(platform) : dependencies.helperExecutablePath,
            })));
        return await invoke(input);
    };
    async function capture(input: ProcessCensusInput): Promise<ProcessCensusSnapshot> {
        const capturedAtMs = (dependencies.now ?? Date.now)();
        const requested = input.pids ? [...new Set(input.pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))] : undefined;
        const verifiedJobNames = [...new Set(input.verifiedJobNames ?? [])];
        if (verifiedJobNames.some(name => typeof name !== 'string' || !name || name.includes('\0'))) return { status: 'unavailable', reason: 'read_failed' };
        if (verifiedJobNames.length && platform !== 'win32') return { status: 'unavailable', reason: 'unsupported_platform' };
        let snapshot: ProcessCensusSnapshot;
        try {
            if (platform === 'linux') {
                const read = () => readLinux({
                    selfPid, pids: requested, capturedAtMs, logicalCpus: dependencies.logicalCpus ?? cpus().length,
                    fields: input.fields, commandRoots: input.commandRoots, includeAncestors: input.includeAncestors,
                    includeDescendants: input.includeDescendants,
                });
                snapshot = requested ? await read() : await observeNativeCensus(capturedAtMs, read);
            } else if (platform === 'darwin' || platform === 'win32') {
                const result = await invokeNative({ command: 'process-census', sampledAt: capturedAtMs, args: [
                    `--caller-pid=${selfPid}`, `--scope=${input.scope ?? 'own_principal'}`,
                    ...(requested && !input.includeDescendants ? [`--pids=${[...new Set([...requested, selfPid])].join(',')}`] : []),
                    ...(input.includeAncestors ? ['--include-ancestors=true'] : []),
                    ...(input.fields?.length === 0 ? ['--identity-only=true'] : []),
                    ...(input.fields?.length ? [`--fields=${[...new Set(input.fields)].join(',')}`] : []),
                    ...verifiedJobNames.map(name => `--job=${name}`),
                ] });
                if (result.state === 'unavailable') return { status: 'unavailable', reason: result.reason === 'helper_missing' ? 'helper_missing' : 'read_failed' };
                snapshot = decodeHelperCensus(result.stdout, selfPid, verifiedJobNames);
            } else return { status: 'unavailable', reason: 'unsupported_platform' };
        } catch {
            return { status: 'unavailable', reason: 'read_failed' };
        }
        if (snapshot.status !== 'ok') return snapshot;
        const self = snapshot.rows.find(row => row.pid === selfPid);
        if (!self) return { status: 'unavailable', reason: 'self_absent' };
        const requestedSet = requested ? new Set([...requested, selfPid]) : null;
        if (requestedSet && input.includeDescendants) {
            // Linux already selected the observed subtree, including children
            // reparented during observation. Do not discard those observations.
            if (platform === 'linux') for (const row of snapshot.rows) requestedSet.add(row.pid);
            else {
                const index = indexCensus(snapshot.rows);
                for (const row of descendantsOf(index, requested!)) requestedSet.add(row.pid);
            }
        }
        if (requestedSet && input.includeAncestors) {
            const index = indexCensus(snapshot.rows);
            for (const pid of [...requestedSet]) for (const ancestor of ancestorsOf(index, pid)) requestedSet.add(ancestor.pid);
        }
        if (requestedSet) for (const observation of snapshot.jobObservations ?? []) {
            if (observation.state === 'live') for (const pid of observation.pids) requestedSet.add(pid);
        }
        const rows = snapshot.rows.filter(row => (!requestedSet || requestedSet.has(row.pid))
            && (input.scope === 'all' || row.principal === null || self.principal === null
                || (row.principal.kind === self.principal.kind && row.principal.value === self.principal.value)));
        return { ...snapshot, rows };
    }
    return (input: ProcessCensusInput): Promise<ProcessCensusSnapshot> => {
        if (input.freshness === 'fresh') return capture(input);
        const key = JSON.stringify([input.scope ?? 'own_principal',
            input.pids ? [...new Set(input.pids)].sort((a, b) => a - b) : null,
            [...new Set(input.verifiedJobNames ?? [])].sort(),
            input.fields ? [...new Set(input.fields)].sort() : null,
            input.commandRoots ? [...new Set(input.commandRoots)].sort((a, b) => a - b) : null, input.includeAncestors === true,
            input.includeDescendants === true]);
        const current = inFlight.get(key);
        if (current) return current;
        const pending = capture(input).finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
        inFlight.set(key, pending);
        return pending;
    };
}

export const readProcessCensus = createProcessCensusReader();
export { indexCensus, ancestorsOf, descendantsOf, protectedSet, membersOfCgroup, membersOfJob, membersOfPgid } from '../tree/processTree';
