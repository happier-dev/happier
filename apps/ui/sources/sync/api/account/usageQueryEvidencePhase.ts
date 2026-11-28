import { projectUsageActivitySourceStatus, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { readUsageSessionInputAvailability } from '@/sync/domains/usage/usageWorkEvidence';
import type { SessionInputEvidence } from './usageQuerySessionInputs';

type EvidenceReadPhase = Readonly<{
    admitted: boolean;
    refused: boolean;
    sources: readonly UsageQuerySourceState[];
}>;

/** The finite evidence read owns its selected inputs and source-phase publication. */
export class UsageQueryEvidencePhase {
    private readonly inputs = new Map<string, SessionInputEvidence | null>();
    private readonly settled = new Set<string>();
    private publishedPhase: EvidenceReadPhase | undefined;
    private readableInputs = 0;
    private refusedInputs = 0;
    private coveredInputs = 0;

    constructor(private readonly selectionCount: number, private readonly readTranscript: boolean,
        private readonly populationObserved = true) {}

    get selected(): ReadonlyMap<string, SessionInputEvidence | null> { return this.inputs; }
    get complete(): boolean { return this.settled.size === this.selectionCount; }

    private updateEvidenceCounts(value: SessionInputEvidence | null, change: number): void {
        if (value === null) { this.refusedInputs += change; return; }
        if (readUsageSessionInputAvailability(value.session) === 'ready') this.readableInputs += change;
        if (value.completeMessageCoverage) this.coveredInputs += change;
    }

    select(id: string, value: SessionInputEvidence | null, complete = false): boolean {
        const previous = this.inputs.get(id);
        const changed = previous !== value;
        // Inputs are immutable admitted snapshots. A changed Session adjusts
        // the finite read's phase totals; it never rechecks the other Sessions.
        if (changed) {
            if (previous !== undefined) this.updateEvidenceCounts(previous, -1);
            this.updateEvidenceCounts(value, 1);
            this.inputs.set(id, value);
        }
        if (complete) this.settled.add(id);
        return changed;
    }

    read(): EvidenceReadPhase | undefined {
        const admitted = this.inputs.size === this.selectionCount;
        const readable = this.populationObserved && this.readableInputs === this.selectionCount;
        const refused = this.refusedInputs > 0;
        const sessionsStatus = projectUsageActivitySourceStatus(true, admitted, readable);
        const transcriptsStatus = projectUsageActivitySourceStatus(this.readTranscript, this.complete,
            readable && this.coveredInputs === this.selectionCount);
        if (this.publishedPhase?.refused === refused
            && this.publishedPhase.sources[0]?.status === sessionsStatus
            && this.publishedPhase.sources[1]?.status === transcriptsStatus) return undefined;
        const phase: EvidenceReadPhase = { admitted, refused, sources: [
            { source: 'how_you_work:sessions', status: sessionsStatus },
            { source: 'how_you_work:transcripts', status: transcriptsStatus },
        ] };
        this.publishedPhase = phase;
        return phase;
    }
}
