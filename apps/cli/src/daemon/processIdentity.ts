import { compareNumericProcessGenerationIdentities } from '@happier-dev/cli-common/processInstance';

import { parseProcessCustodyStartIdentity } from '@/subprocess/supervision/processCustody';
import { createProcessCensusReader, readProcessCensus, type ProcessCensusDependencies } from '@/processes/census/processCensus';
import { censusRowToProcessFact } from '@/processes/census/processFacts';
import type { LocalServiceProcessFact } from './local/services/inventory/provenance';

export type ProcessGenerationWitness = Readonly<{ pid: number; processStartTimeMs: number }>;

export function parseProcessGenerationWitness(value: unknown): ProcessGenerationWitness | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
        || !Number.isSafeInteger(record.processStartTimeMs) || (record.processStartTimeMs as number) < 0) return null;
    return Object.freeze({ pid: record.pid as number, processStartTimeMs: record.processStartTimeMs as number });
}

type SupportedProcessIdentityPlatform = 'darwin' | 'linux' | 'win32';

export type ReadProcessIdentityByPidDependencies = Pick<ProcessCensusDependencies,
    'platform' | 'linuxBoundary' | 'execFile' | 'helperExecutablePath'>;

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

export async function readProcessIdentityByPid(
    pid: number,
    dependencies: ReadProcessIdentityByPidDependencies = {},
): Promise<LocalServiceProcessFact | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;

    const platform = dependencies.platform ?? process.platform;
    if (!isSupportedPlatform(platform)) return null;

    try {
        const read = Object.keys(dependencies).length ? createProcessCensusReader(dependencies) : readProcessCensus;
        // Preserve foreign-principal birth evidence for PID safety; the census withholds its private fields.
        const snapshot = await read({ freshness: 'fresh', pids: [pid, process.pid], scope: 'all' });
        if (snapshot.status !== 'ok') return null;
        const row = snapshot.rows.find(candidate => candidate.pid === pid);
        if (!row) return null;
        const selfPrincipal = snapshot.rows.find(candidate => candidate.pid === process.pid)?.principal ?? null;
        return censusRowToProcessFact(row, selfPrincipal);
    } catch {
        return null;
    }
}
