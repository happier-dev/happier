import { raceWithTimeout, type RaceWithTimeoutResult } from '@happier-dev/plugin-sdk/async';
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
 * the host-plugin contract — a local ref outside the published grammar, a kind
 * its own descriptor never declared, or more rows than the limit this pass
 * submitted — is a defect in that source rather than a bad provider row it was
 * supposed to filter. Tolerance for untrusted provider rows belongs inside the
 * source, which is why salvaging the valid siblings here would publish a
 * conforming-looking lane for a source that is not conforming: its walk
 * evidence would read healthy while its contract defect stayed invisible. The whole page is therefore rejected, the lane is
 * marked failed with the closed `unsupportedContract` class, and neither the
 * page's evidence nor any observation this lane produced in this pass is
 * adopted — so the consumer keeps its last-known-good rather than a silently
 * partial view of a broken source.
 *
 * A page that neither answers nor fails is the third outcome, and it is not a
 * contract violation: it is bounded by this owner's private per-page deadline
 * (`CONTRACT.md` §5.2, `PLAN.md` `REQ-13`). Reaching it settles the lane as a
 * classified `transient` failure and leaves the rotation, and it stops the
 * provider work we stopped waiting for — but it keeps every page that lane
 * already gave, because an unanswered page says nothing about the ones that
 * answered. The pass schedules no wake and retries nothing: a later view or
 * manual trigger asks again, after the shared pacing policy's bounded backoff.
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
    /**
     * Where this lane's walk starts. Omitted starts at the first page; a
     * continuation a previous bounded invocation reported resumes there.
     *
     * It changes nothing about this owner's own custody rule: the value is
     * carried in from the invocation that is about to use it, is never written
     * anywhere, and is gone when the pass returns.
     */
    resume?: TriageScanContinuationV1;
    scan: (input: TriageScanInputV1, options?: PluginCancellationOptions) => Promise<TriageScanResultV1>;
}>;

/** Where one lane's walk stopped, when it stopped with more to give. */
export type TriageScanPassStopV1 = Readonly<{
    sourceInstanceId: string;
    continuation: TriageScanContinuationV1;
}>;

export type TriageScanPassResultV1 = Readonly<{
    observations: readonly CorpusQualifiedObservationV1[];
    lanes: readonly TriageListLaneV1[];
    /**
     * The lanes the observation budget stopped mid-walk, and the page each one
     * would continue from.
     *
     * Only a HEALTHY unfinished lane appears: a lane that exhausted has nothing
     * to continue, and a lane that failed, timed out or violated the page
     * contract has nothing worth continuing — its next read starts over, which
     * is what the failure classes already drive. Reporting it is what lets a
     * caller append the next bounded window instead of re-walking from page one.
     */
    stopped: readonly TriageScanPassStopV1[];
}>;

type LaneState = {
    readonly lane: TriageScanLaneV1;
    continuation: TriageScanContinuationV1 | null;
    health: TriageListLaneHealthV1;
    exhausted: boolean;
    active: boolean;
    /**
     * Provider rows this lane has consumed across the whole walk — qualified
     * observations plus tolerantly-omitted rows. It is the only quantity that
     * bounds a walk whose pages all answer promptly, so it is carried per lane
     * rather than recomputed per page.
     */
    charged: number;
};

/**
 * How long this owner waits for one submitted scan page before it stops
 * waiting.
 *
 * It bounds one `scan` invocation, which is the several provider round trips a
 * source makes to fill one page — so a single request timeout would be too
 * tight — and it is a third of `TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS`, the
 * interval measured from a read's *start* that decides when the next
 * view-triggered pass may run. A page allowed to outlast that interval would
 * still be hanging when the next pass is already eligible.
 *
 * It is private implementation discretion, never public source ABI, a
 * per-source override, or a generic host timer: a source owns its own deadlines
 * for the mounted detail reads and provider operations it starts.
 *
 * The deadline alone does NOT bound the pass, and must not be read as if it
 * did: it bounds how long one page may take, not how many pages a source may
 * offer. A source answering every page instantly while never converging is
 * bounded separately, by the non-progress exits beside the continuation arm
 * below — without them that shape spins entirely inside the microtask queue and
 * starves the event loop rather than hanging one Action.
 *
 * The bounded ceiling it assumes is one lane per deadline, not one page per
 * deadline — a lane that reaches it leaves the rotation — so a pass over N configured
 * instances that all hang settles in N deadlines rather than unboundedly.
 * `pageDeadlineMs` exists so owner tests inject a short one.
 */
const TRIAGE_SCAN_PAGE_DEADLINE_MS = 10_000;

/**
 * Every way one returned page can fail the V1 page contract: the per-observation
 * qualification reasons, plus the page-level bound only this caller knows.
 *
 * A walk this owner stopped because it was not converging is deliberately NOT
 * here. Nothing in the published page contract obliges a source to converge
 * within this aggregate's private budget, so a page that stays inside every
 * published bound and merely asks to be called again has broken no invariant —
 * see `nonConvergingFailure`.
 */
type TriageScanPageViolationV1 = CorpusQualificationRejectionV1 | 'pageLimitExceeded';

/**
 * The lane health a contract violation produces.
 *
 * `unsupportedContract` is the published failure class for exactly this: the
 * source answered, and what it answered is not the V1 contract. The rejection
 * reason is carried as the code so the failure names which invariant broke
 * without echoing any provider value.
 */
function contractFailure(reason: TriageScanPageViolationV1): TriageListLaneHealthV1 {
    return {
        kind: 'failed',
        failure: {
            class: 'unsupportedContract',
            code: `triage/${reason}`,
            detail: 'The source returned a page that does not satisfy the V1 observation contract.',
        },
    };
}

/**
 * The lane health an unanswered page produces.
 *
 * `transient` is the class the shared pacing policy reads as a provider that is
 * busy rather than as a user-actionable refusal, so a later view or manual
 * Refresh retries after a bounded backoff instead of being parked behind a
 * connection the user cannot fix.
 */
const SCAN_PAGE_DEADLINE_FAILURE_V1: TriageListLaneHealthV1 = Object.freeze({
    kind: 'failed',
    failure: Object.freeze({
        class: 'transient',
        code: 'triage/scanPageDeadline',
        detail: 'The source did not answer this scan page before the aggregate deadline.',
    }),
});

/**
 * The lane health this owner's own non-convergence bound produces.
 *
 * It is the same shape as the per-page deadline above, and for the same reason:
 * both are bounds this aggregate owns rather than invariants the source broke.
 * A page that stays inside every published bound and asks to be called again is
 * a legal page — an omission-only continuation page, which the contract admits
 * precisely so a source can decode tolerantly, is the ordinary shape of it — so
 * classifying it `unsupportedContract` accused a conforming plugin and, worse,
 * discarded every valid page the same lane had already given.
 *
 * `transient` is what the shared pacing policy reads as "ask again later", which
 * is exactly right: the walk is unfinished, not broken. The lane keeps its pages
 * and keeps `exhausted: false`, so the window reports a truthful partial.
 */
function nonConvergingFailure(reason: 'stalledWalk' | 'nonProgressingWalk'): TriageListLaneHealthV1 {
    return {
        kind: 'failed',
        failure: {
            class: 'transient',
            code: `triage/${reason}`,
            detail: 'The source did not converge within the bound this pass allows one walk.',
        },
    };
}

/**
 * How much of the submitted limit one returned page spent.
 *
 * A provider row the source omitted while decoding still consumed provider
 * position, so it is charged here exactly as `CONTRACT.md` §5.1 charges it. The
 * published result schema can only enforce the global ceiling; the contextual
 * limit this pass actually submitted is enforced nowhere unless it is enforced
 * here.
 */
function chargedAgainstLimit(result: Extract<TriageScanResultV1, { kind: 'page' | 'complete' }>): number {
    return result.observations.length
        + (result.evidence.kind === 'partial' ? result.evidence.omittedItemCount ?? 0 : 0);
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
    /** Owner-private per-page deadline; owner tests inject a short one. */
    pageDeadlineMs?: number;
}>): Promise<TriageScanPassResultV1> {
    const pageLimit = Math.max(1, Math.min(input.pageLimit, MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1));
    const pageDeadlineMs = input.pageDeadlineMs ?? TRIAGE_SCAN_PAGE_DEADLINE_MS;
    const states: LaneState[] = input.lanes.map((lane) => ({
        lane,
        continuation: lane.resume ?? null,
        // A lane that never ran is not evidence that the walk finished.
        health: { kind: 'unavailable' },
        exhausted: false,
        active: true,
        charged: 0,
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

            // One controller per invocation: it carries our deadline, and it
            // composes with the caller's canonical signal so retirement,
            // reconfiguration and shutdown still reach the source unchanged.
            const deadline = new AbortController();
            const options: PluginCancellationOptions = {
                signal: input.signal
                    ? AbortSignal.any([input.signal, deadline.signal])
                    : deadline.signal,
            };
            let settled: RaceWithTimeoutResult<TriageScanResultV1>;
            try {
                settled = await raceWithTimeout(
                    state.lane.scan(scanInputFor(state, pageLimit), options),
                    pageDeadlineMs,
                );
            } catch (error) {
                // A synchronous throw is the same defect as a rejection.
                settled = { type: 'rejected', error };
            } finally {
                // However this invocation ended, it is over for us. Aborting
                // releases the composed signal and, on a deadline, stops the
                // provider work we stopped waiting for — otherwise the pass
                // that replaces this one starts a second walk beside a first
                // that is still running.
                deadline.abort();
            }

            if (settled.type === 'timeout') {
                // Neither an answer nor a failure. The lane leaves the rotation
                // as a classified transient failure, and every page it already
                // gave stays: an unanswered page is not evidence against the
                // ones that answered.
                state.health = SCAN_PAGE_DEADLINE_FAILURE_V1;
                state.active = false;
                continue;
            }
            if (settled.type === 'rejected') {
                // A rejected invocation is not provider evidence about the source.
                state.health = { kind: 'unavailable' };
                state.active = false;
                continue;
            }
            const result = settled.value;

            if (result.kind === 'failed') {
                state.health = { kind: 'failed', failure: result.failure };
                state.active = false;
                continue;
            }

            const charged = chargedAgainstLimit(result);
            if (charged > pageLimit) {
                // Over-limit is a source-contract failure of the whole lane, not
                // partially valid data: truncating would publish a conforming
                // page for a source whose accounting is not conforming, and
                // dropping the excess would lose rows silently.
                contractFailed.add(state.lane.sourceInstanceId);
                state.health = contractFailure('pageLimitExceeded');
                state.exhausted = false;
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
                /*
                 * `complete` says the source stopped paging. It does NOT say the
                 * walk enumerated the lane's whole set, and the evidence on the
                 * same page is what distinguishes the two: `walkFinished` is the
                 * source's one statement that pagination ran out cleanly, while
                 * `partial` and `moving` are the arms that say it did not — rows
                 * omitted, a ceiling hit, a continuation that could not be
                 * minted, a set mutating underneath the order.
                 *
                 * Claiming exhaustion on any settled arm let those two evidence
                 * arms through as a finished walk, and `listWindow.ts` derives
                 * `coverage` from exactly this member — so an inbox truncated at
                 * a provider's result ceiling was published as `complete`, and
                 * the mounted store's exhausted-replaces branch then deleted
                 * every retained row the truncated page did not name.
                 */
                state.exhausted = result.evidence.kind === 'walkFinished';
                state.active = false;
                continue;
            }

            /*
             * A walk has to end. The per-page deadline bounds how long ONE page
             * may take; it cannot bound a source that answers every page
             * instantly and never finishes, and that shape does not merely hang
             * this Action — the whole loop settles in the microtask queue, so it
             * starves the event loop the daemon runs on.
             *
             * Two exits, both derived from what the page already reports rather
             * than from a new budget:
             *
             *  - A page that qualifies nothing AND charges no provider row has
             *    consumed nothing at all, yet asks to be called again. That is
             *    non-progress by construction, whatever the provider holds.
             *  - Otherwise the walk is bounded by what it could ever need: a
             *    source cannot require more rows than the observation budget it
             *    is filling plus one final page. Past that it is not converging.
             *
             * Neither is a broken published invariant, so neither is a contract
             * failure: every such page stayed inside the limit it was submitted,
             * carried a valid continuation, and said honestly what it omitted.
             * The bound is ours, so the settlement is ours too — a classified
             * `transient` failure that keeps every page the lane already gave
             * and leaves `exhausted: false`, exactly as the per-page deadline
             * does. Discarding the lane's valid pages here punished a conforming
             * source for a budget it was never told about.
             */
            state.charged += charged;
            if (page.length === 0 && charged === 0) {
                state.health = nonConvergingFailure('stalledWalk');
                state.exhausted = false;
                state.active = false;
                continue;
            }
            if (state.charged > input.observationBudget + pageLimit) {
                state.health = nonConvergingFailure('nonProgressingWalk');
                state.exhausted = false;
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
        // A stop is offered only for a lane that is healthy, unfinished and
        // holding the page it would ask for next. Every other lane is either
        // finished, broken, or was never asked — and none of those is a page to
        // continue from.
        stopped: Object.freeze(states.flatMap((state) => (
            state.continuation !== null
                && !state.exhausted
                && state.health.kind !== 'failed'
                && state.health.kind !== 'unavailable'
                && !contractFailed.has(state.lane.sourceInstanceId)
                ? [Object.freeze({
                    sourceInstanceId: state.lane.sourceInstanceId,
                    continuation: state.continuation,
                })]
                : []
        ))),
    });
}
