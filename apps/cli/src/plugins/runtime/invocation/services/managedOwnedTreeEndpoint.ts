/**
 * Correlates a plugin-runtime managed process to the loopback listener it owns.
 *
 * This lived in `daemon/local/services/managed/registry.ts` until that dormant spine was
 * removed (RU2 surfaces finalization, DEC-6): the registry had no producer, but this
 * selector does — `managedProcessSupervisor.ts` is its live consumer and now its owner.
 * It is deliberately pure: the supervisor supplies inventory candidates from a real scan
 * and this decides which one, if any, belongs to the managed process tree.
 */

export type ManagedEndpointConfidence = 'high' | 'medium' | 'low';

export type ManagedInventoryCandidate = Readonly<{
    id: string;
    port: number;
    confidence: ManagedEndpointConfidence;
    processOwnershipConfidence: ManagedEndpointConfidence;
    provenance?: Readonly<{
        process?: Readonly<{
            pid: number;
            ppid?: number;
            lineagePids?: readonly number[];
            redacted: true;
            command: string;
        }>;
    }>;
}>;

function confidenceRank(confidence: ManagedEndpointConfidence): number {
    if (confidence === 'high') return 3;
    if (confidence === 'medium') return 2;
    return 1;
}

function isCorrelatedProcess(entry: ManagedInventoryCandidate, managedPid: number): boolean {
    const process = entry.provenance?.process;
    if (!process) return false;
    return process.pid === managedPid
        || process.ppid === managedPid
        || process.lineagePids?.includes(managedPid) === true;
}

/**
 * Returns the single candidate owned by `managedPid` (directly, as its parent, or through
 * process lineage) that clears `minimumConfidence`. An exact pid match is treated as `high`
 * regardless of the scanner's ownership grade. Returns `null` when nothing matches **or when
 * more than one does** — ambiguity must never be resolved by picking arbitrarily, because the
 * result becomes a managed service's advertised endpoint.
 */
export function selectManagedOwnedTreeEndpoint(input: Readonly<{
    entries: readonly ManagedInventoryCandidate[];
    managedPid: number;
    minimumConfidence: ManagedEndpointConfidence;
}>): ManagedInventoryCandidate | null {
    const matches = input.entries.filter((entry) => (
        isCorrelatedProcess(entry, input.managedPid)
        && confidenceRank(
            entry.provenance?.process?.pid === input.managedPid
                ? 'high'
                : entry.processOwnershipConfidence,
        )
            >= confidenceRank(input.minimumConfidence)
    ));
    return matches.length === 1 ? matches[0]! : null;
}
