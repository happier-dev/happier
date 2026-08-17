import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import {
    MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanContinuationV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';

import {
    qualifySourceObservation,
    type CorpusQualificationRejectionV1,
    type CorpusQualifiedObservationV1,
} from '../corpus/fold/qualify.js';
import type { TriageListLaneHealthV1, TriageListLaneV1 } from './listWindow.js';

/**
 * One materialization pass over the configured source instances.
 *
 * The pass walks pages serially inside each lane and round-robins across lanes,
 * so one deep or slow source cannot consume the whole page budget and make the
 * others invisible. Its continuations live only inside this invocation: there is
 * no checkpoint, resume custody, durable cursor or `deferred` arm, and an
 * interruption simply ends the pass so a later trigger starts at the first page
 * (`core/CORPUS.md` §4.3, `INV-03`).
 *
 * The pass concludes nothing about absence. A finished walk is health evidence,
 * never set-complement evidence, which is why it emits only the three bounded
 * scan-evidence names plus the two honest non-evidence arms.
 *
 * A page is qualified atomically. An admitted source contribution is trusted
 * code holding an admitted operation handle, so a page it returns that violates
 * the host-plugin contract — a local ref outside the published grammar, or a
 * kind its own descriptor never declared — is a defect in that source rather
 * than a bad provider row it was supposed to filter. Tolerance for untrusted
 * provider rows belongs inside the source, which is why salvaging the valid
 * siblings here would publish a conforming-looking lane for a source that is
 * not conforming: its walk evidence would read healthy while its contract
 * defect stayed invisible. The whole page is therefore rejected, the lane is
 * marked failed with the closed `unsupportedContract` class, and neither the
 * page's evidence nor any observation this lane produced in this pass is
 * adopted — so the consumer keeps its last-known-good rather than a silently
 * partial view of a broken source.
 */

/** One configured source instance, bound to the exact admitted `scan` it is read through. */
export type TriageScanLaneV1 = Readonly<{
    sourceInstanceId: string;
    /** The admitted source contribution identity. A source never supplies it. */
    source: PluginContributionIdentity;
    /** The kinds this source's descriptor declares; every local ref is validated against them. */
    declaredKindIds: readonly string[];
    /** The exact configured value, passed unchanged to every invocation. */
    configured: TriageConfiguredSourceInstanceV1;
    scan: (input: TriageScanInputV1, options?: PluginCancellationOptions) => Promise<TriageScanResultV1>;
}>;

export type TriageScanPassResultV1 = Readonly<{
    observations: readonly CorpusQualifiedObservationV1[];
    lanes: readonly TriageListLaneV1[];
}>;

type LaneState = {
    readonly lane: TriageScanLaneV1;
    continuation: TriageScanContinuationV1 | null;
    health: TriageListLaneHealthV1;
    exhausted: boolean;
    active: boolean;
};

/**
 * The lane health a contract violation produces.
 *
 * `unsupportedContract` is the published failure class for exactly this: the
 * source answered, and what it answered is not the V1 contract. The rejection
 * reason is carried as the code so the failure names which invariant broke
 * without echoing any provider value.
 */
function contractFailure(reason: CorpusQualificationRejectionV1): TriageListLaneHealthV1 {
    return {
        kind: 'failed',
        failure: {
            class: 'unsupportedContract',
            code: `triage/${reason}`,
            detail: 'The source returned a page that does not satisfy the V1 observation contract.',
        },
    };
}

function scanInputFor(state: LaneState, pageLimit: number): TriageScanInputV1 {
    return state.continuation === null
        ? { v: 1, instance: state.lane.configured, page: { kind: 'initial', limit: pageLimit } }
        : { v: 1, instance: state.lane.configured, page: { kind: 'continuation', continuation: state.continuation } };
}

export async function runTriageScanPass(input: Readonly<{
    lanes: readonly TriageScanLaneV1[];
    /** Per-page request, bounded by the shared published scan-page maximum. */
    pageLimit: number;
    /** The pass stops rotating once this many observations have been qualified. */
    observationBudget: number;
    nowMs: () => number;
    signal?: AbortSignal;
}>): Promise<TriageScanPassResultV1> {
    const pageLimit = Math.max(1, Math.min(input.pageLimit, MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1));
    const states: LaneState[] = input.lanes.map((lane) => ({
        lane,
        continuation: null,
        // A lane that never ran is not evidence that the walk finished.
        health: { kind: 'unavailable' },
        exhausted: false,
        active: true,
    }));
    const observations: CorpusQualifiedObservationV1[] = [];
    /** Lanes whose page violated the contract; nothing they produced is adopted. */
    const contractFailed = new Set<string>();
    const aborted = (): boolean => input.signal?.aborted ?? false;

    while (states.some((state) => state.active)) {
        if (aborted()) break;
        for (const state of states) {
            if (!state.active) continue;
            if (aborted()) break;
            if (observations.length >= input.observationBudget) {
                // The budget ends the rotation, not the lane: an unexhausted lane
                // keeps `exhausted: false`, so the window reports a resumable
                // partial rather than a healthy empty one.
                state.active = false;
                continue;
            }

            let result: TriageScanResultV1;
            try {
                const options = input.signal ? { signal: input.signal } : undefined;
                result = await state.lane.scan(scanInputFor(state, pageLimit), options);
            } catch {
                // A rejected invocation is not provider evidence about the source.
                state.health = { kind: 'unavailable' };
                state.active = false;
                continue;
            }

            if (result.kind === 'failed') {
                state.health = { kind: 'failed', failure: result.failure };
                state.active = false;
                continue;
            }

            const observedAtMs = input.nowMs();
            const page: CorpusQualifiedObservationV1[] = [];
            let violation: CorpusQualificationRejectionV1 | null = null;
            for (const observation of result.observations) {
                const qualified = qualifySourceObservation({
                    source: state.lane.source,
                    declaredKindIds: state.lane.declaredKindIds,
                    sourceInstanceId: state.lane.sourceInstanceId,
                    observedAtMs,
                    observation,
                });
                if (qualified.status === 'rejected') {
                    violation = qualified.reason;
                    break;
                }
                page.push(qualified.observation);
            }

            if (violation !== null) {
                // The whole page is rejected, and with it every observation this
                // lane produced in this pass. Adopting the survivors would
                // publish a healthy-looking lane for a source whose contract
                // defect the user would never see.
                contractFailed.add(state.lane.sourceInstanceId);
                state.health = contractFailure(violation);
                state.exhausted = false;
                state.active = false;
                continue;
            }

            observations.push(...page);
            state.health = result.evidence;
            if (result.kind === 'complete') {
                state.exhausted = true;
                state.active = false;
                continue;
            }
            state.continuation = result.continuation;
        }
    }

    return Object.freeze({
        observations: Object.freeze(
            observations.filter((observation) => !contractFailed.has(observation.sourceInstanceId)),
        ),
        lanes: Object.freeze(states.map((state) => Object.freeze({
            sourceInstanceId: state.lane.sourceInstanceId,
            source: state.lane.source,
            health: state.health,
            exhausted: state.exhausted,
        }))),
    });
}
