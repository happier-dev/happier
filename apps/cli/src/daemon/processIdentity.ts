import { compareNumericProcessGenerationIdentities, processGenerationMatches, processGenerationProvesReuse } from '@happier-dev/cli-common/processInstance';

import { parseProcessCustodyStartIdentity } from '@/subprocess/supervision/processCustody';
import { createProcessCensusReader, readProcessCensus, type ProcessCensusDependencies, type ProcessCensusSnapshot, type ProcessStartIdentity } from '@/processes/census/processCensus';
import { censusRowToProcessFact } from '@/processes/census/processFacts';
import { equalProcessStart } from './processes/ownership/types';
import type { LocalServiceProcessFact } from './local/services/inventory/provenance';
import { readProcessRunState, type ProcessRunState } from './processRunState';
import type { DaemonSessionMarker } from './sessionRegistry';

export type ProcessGenerationWitness = Readonly<{ pid: number; processStartTimeMs: number }>;
export type ProcessGenerationLiveness = 'verified_running' | 'verified_stopped' | 'unknown';

export function parseProcessGenerationWitness(value: unknown): ProcessGenerationWitness | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
        || !Number.isSafeInteger(record.processStartTimeMs) || (record.processStartTimeMs as number) < 0) return null;
    return Object.freeze({ pid: record.pid as number, processStartTimeMs: record.processStartTimeMs as number });
}

/** A legacy PID without a birth witness can prove death, but never a live generation. */
export async function inspectProcessGeneration(
    ownerProcess: Readonly<{ pid: number; processStartTimeMs?: number }>,
    dependencies: Readonly<{
        readProcessRunState?: typeof readProcessRunState;
        readProcessIdentityByPid?: typeof readProcessIdentityByPid;
    }> = {},
): Promise<ProcessGenerationLiveness> {
    if (!Number.isSafeInteger(ownerProcess.pid) || ownerProcess.pid <= 0) return 'unknown';
    if (ownerProcess.processStartTimeMs === undefined) {
        const state = await (dependencies.readProcessRunState ?? readProcessRunState)(ownerProcess.pid).catch(() => null);
        return state === 'dead' || state === 'zombie' ? 'verified_stopped' : 'unknown';
    }
    return (await verifyProcessLiveness({
        ...ownerProcess,
        readRunState: dependencies.readProcessRunState,
        readProcessIdentityByPidFn: dependencies.readProcessIdentityByPid,
    })).status;
}

type SupportedProcessIdentityPlatform = 'darwin' | 'linux' | 'win32';

export type ReadProcessIdentityByPidDependencies = Pick<ProcessCensusDependencies,
    'platform' | 'linuxBoundary' | 'execFile' | 'helperExecutablePath'>;

export { ProcessBirthWitnessSchema } from '@/processes/census/decodeHelperCensus';
export type ProcessBirthWitness = Readonly<{ pid: number; start: ProcessStartIdentity }>;
export type ProcessBirthInspection =
    | Readonly<{ status: 'same'; witness: ProcessBirthWitness }>
    | Readonly<{ status: 'reused' | 'absent' }>
    | Readonly<{ status: 'unknown'; reason: Extract<ProcessCensusSnapshot, { status: 'unavailable' }>['reason']
        | 'birth_unreadable' | 'native_birth_missing' }>;

/** Native birth evidence is shared unchanged with the process-tree terminator. */
async function observeProcessBirth(
    pid: number,
    dependencies: ReadProcessIdentityByPidDependencies,
): Promise<ProcessBirthInspection> {
    const platform = dependencies.platform ?? process.platform;
    try {
        const read = Object.keys(dependencies).length ? createProcessCensusReader(dependencies) : readProcessCensus;
        const snapshot = await read({ freshness: 'fresh', pids: [pid], scope: 'all', fields: [] });
        if (snapshot.status !== 'ok') return { status: 'unknown', reason: snapshot.reason };
        const row = snapshot.rows.find(candidate => candidate.pid === pid);
        if (!row) return snapshot.partial?.some(partial => partial.pid === pid && partial.missing.includes('start'))
            ? { status: 'unknown', reason: 'birth_unreadable' } : { status: 'absent' };
        if (row.state === 'zombie') return { status: 'absent' };
        if (platform === 'darwin' && !row.start.native) return { status: 'unknown', reason: 'native_birth_missing' };
        return { status: 'same', witness: { pid, start: row.start } };
    } catch { return { status: 'unknown', reason: 'read_failed' }; }
}

/** Capture once at launch; a Windows Job name remains separate containment evidence. */
export async function captureProcessBirthWitness(
    pid: number,
    dependencies: ReadProcessIdentityByPidDependencies = {},
): Promise<ProcessBirthWitness | null> {
    const observation = await observeProcessBirth(pid, dependencies);
    return observation.status === 'same' ? observation.witness : null;
}

/** One fresh native observation decides whether a retained PID still names its captured generation. */
export async function inspectProcessBirthWitness(
    witness: ProcessBirthWitness,
    dependencies: ReadProcessIdentityByPidDependencies = {},
): Promise<ProcessBirthInspection> {
    return compareProcessBirth(witness, await observeProcessBirth(witness.pid, dependencies), dependencies.platform);
}

/** Whether an observation of `witness.pid` is the captured generation (exact native birth on darwin). */
export function compareProcessBirth(
    witness: ProcessBirthWitness,
    observation: ProcessBirthInspection,
    platform: NodeJS.Platform = process.platform,
): ProcessBirthInspection {
    if (observation.status !== 'same') return observation;
    if (observation.witness.pid !== witness.pid || !equalProcessStart(witness.start, observation.witness.start)) return { status: 'reused' };
    if ((witness.start.native && !observation.witness.start.native)
        || (platform === 'darwin' && !witness.start.native)) {
        return { status: 'unknown', reason: 'native_birth_missing' };
    }
    return observation;
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedProcessIdentityPlatform {
    return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

export {
    processGenerationMatches,
    processGenerationProvesReuse,
} from '@happier-dev/cli-common/processInstance';

/**
 * Compare two tagged native-custody identities owned by the processCustody
 * module (Windows job custody, Darwin subsecond start identity). A tag always
 * decides exactly — the whole-second ambiguity below exists only for legacy
 * `ps lstart` records — except when the two sides are not even the same tag
 * family or a pid disagrees, which stays fenced.
 */
function compareTaggedProcessGenerationIdentities(
    expectedIdentity: string,
    observedIdentity: string,
): ProcessGenerationIdentityComparison | null {
    const expectedTagged = parseProcessCustodyStartIdentity(expectedIdentity);
    const observedTagged = parseProcessCustodyStartIdentity(observedIdentity);
    if (!expectedTagged && !observedTagged) return null;
    if (
        expectedTagged?.kind === 'win32-job'
        && observedTagged?.kind === 'win32-job'
    ) {
        // Job names are generation-unique: the same name proves the same
        // custody generation, a different name proves a different one.
        return expectedTagged.jobName === observedTagged.jobName ? 'same' : 'reused';
    }
    if (
        expectedTagged?.kind === 'darwin-proc'
        && observedTagged?.kind === 'darwin-proc'
    ) {
        if (expectedTagged.pid !== observedTagged.pid) return 'ambiguous';
        // The native timeval includes the subsecond field, so an equal pair
        // proves the exact generation and any difference proves reuse — even
        // within one wall-clock second, which is exactly what the legacy
        // whole-second witness could never decide.
        return expectedTagged.sec === observedTagged.sec && expectedTagged.usec === observedTagged.usec
            ? 'same'
            : 'reused';
    }
    // One side tagged and the other a legacy record (or malformed): the pair
    // cannot decide, so custody fences instead of acting.
    return 'ambiguous';
}

export type ProcessGenerationIdentityComparison =
    /** Both sides prove the exact same process generation. */
    | 'same'
    /** Both sides prove the pid now names a different generation. */
    | 'reused'
    /** The evidence cannot decide; custody must fence instead of acting. */
    | 'ambiguous';

/**
 * Compare a persisted generation identity against a fresh observation of the same-number pid.
 *
 * Native tagged custody decides Darwin subsecond generations exactly. Numeric
 * records use cli-common's numeric verdict, which preserves whole-second
 * Darwin ambiguity for destructive custody decisions.
 */
export function compareProcessGenerationIdentities(
    expectedIdentity: string,
    observedIdentity: string,
    platform: NodeJS.Platform = process.platform,
): ProcessGenerationIdentityComparison {
    const taggedComparison = compareTaggedProcessGenerationIdentities(
        expectedIdentity,
        observedIdentity,
    );
    if (taggedComparison !== null) return taggedComparison;
    return compareNumericProcessGenerationIdentities(expectedIdentity, observedIdentity, platform);
}

/** One fresh census supplies every requested PID in a containing lifecycle observation. */
export async function readProcessIdentitiesByPid(
    pids: readonly number[],
    dependencies: ReadProcessIdentityByPidDependencies = {},
): Promise<ReadonlyMap<number, LocalServiceProcessFact>> {
    const requested = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
    if (!requested.length || !isSupportedPlatform(dependencies.platform ?? process.platform)) return new Map();
    try {
        const read = Object.keys(dependencies).length ? createProcessCensusReader(dependencies) : readProcessCensus;
        const snapshot = await read({ freshness: 'fresh', pids: [...new Set([...requested, process.pid])], scope: 'all' });
        if (snapshot.status !== 'ok') return new Map();
        const selfPrincipal = snapshot.rows.find(candidate => candidate.pid === process.pid)?.principal ?? null;
        return new Map(snapshot.rows.map(row => [row.pid, censusRowToProcessFact(row, selfPrincipal)]));
    } catch { return new Map(); }
}

export async function readProcessIdentityByPid(
    pid: number,
    dependencies: ReadProcessIdentityByPidDependencies = {},
): Promise<LocalServiceProcessFact | null> {
    return (await readProcessIdentitiesByPid([pid], dependencies)).get(pid) ?? null;
}


/** Only a fresh, different process-start witness may report proven_reused. */
export type ProcessIdentityVerification = 'verified' | 'proven_reused' | 'unknown';
export type VerifiedProcessLiveness = Readonly<{
    status: ProcessGenerationLiveness;
    pid: number;
    processStartTimeMs?: number;
}>;

type ReadProcessRunState = (pid: number) => Promise<ProcessRunState>;

/** One birth observation and one liveness decision for every generation consumer. */
export async function verifyProcessLiveness(params: Readonly<{
    pid: number;
    processStartTimeMs?: number;
    verifyIdentity?: (pid: number, identity: LocalServiceProcessFact | null) => Promise<ProcessIdentityVerification>;
    readRunState?: ReadProcessRunState;
    readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
}>): Promise<VerifiedProcessLiveness> {
    const processIdentity = { pid: params.pid,
        ...(params.processStartTimeMs === undefined ? {} : { processStartTimeMs: params.processStartTimeMs }) };
    if (!parseProcessGenerationWitness(processIdentity)) return { status: 'unknown', ...processIdentity };
    try {
        const observed = await (params.readProcessIdentityByPidFn ?? readProcessIdentityByPid)(params.pid);
        const runState = params.readRunState
            ? await params.readRunState(params.pid)
            : await readProcessRunState(params.pid, { observedProcess: observed });
        if (runState === 'dead' || runState === 'zombie') return { status: 'verified_stopped', ...processIdentity };
        if (runState !== 'servable') return { status: 'unknown', ...processIdentity };
        const comparison = observed?.processStartTimeMs === undefined ? 'ambiguous'
            : compareProcessGenerationIdentities(
                params.pid + ':' + params.processStartTimeMs,
                observed.pid + ':' + observed.processStartTimeMs,
            );
        const verification = params.verifyIdentity
            ? await params.verifyIdentity(params.pid, observed)
            : comparison === 'same' ? 'verified' : comparison === 'reused' ? 'proven_reused' : 'unknown';
        return { status: verification === 'verified' ? 'verified_running'
            : verification === 'proven_reused' ? 'verified_stopped' : 'unknown', ...processIdentity };
    } catch { return { status: 'unknown', ...processIdentity }; }
}

export async function verifySessionMarkerProcessLiveness(
    marker: Pick<DaemonSessionMarker, 'pid' | 'processCommandHash' | 'processStartTimeMs'>,
    deps: Readonly<{
        readRunState?: ReadProcessRunState;
        verifyHappyProcessIdentity?: typeof import('./pidSafety').isPidSafeHappySessionProcess;
        readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
    }> = {},
): Promise<VerifiedProcessLiveness> {
    return await verifyProcessLiveness({
        pid: marker.pid,
        processStartTimeMs: marker.processStartTimeMs,
        readRunState: deps.readRunState,
        readProcessIdentityByPidFn: deps.readProcessIdentityByPidFn,
        verifyIdentity: async (pid, observed): Promise<ProcessIdentityVerification> => {
            const verified = deps.verifyHappyProcessIdentity
                ? await deps.verifyHappyProcessIdentity({ pid,
                    expectedProcessStartTimeMs: marker.processStartTimeMs,
                    expectedProcessCommandHash: marker.processCommandHash })
                : observed?.pid === pid && processGenerationMatches(marker.processStartTimeMs, observed.processStartTimeMs);
            if (verified) return 'verified';
            return observed?.pid === pid && processGenerationProvesReuse(marker.processStartTimeMs, observed.processStartTimeMs)
                ? 'proven_reused' : 'unknown';
        },
    });
}
