import { raceWithTimeout, type RaceWithTimeoutResult } from '@happier-dev/plugin-sdk/async';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import {
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
 * contract violation: it is bounded by this owner's private per-lane deadline
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
    /** One absolute budget and signal for this lane's whole walk. */
    deadlineStartedAtMs: number | null;
    deadline: AbortController;
    signal: AbortSignal;
};

/**
 * Optional owner-test/external absolute bound for one source lane's whole walk.
 *
 * A source answering every page instantly while never converging still needs
 * the structural non-progress exits beside the continuation arm below, because
 * that shape can stay entirely inside one millisecond and starve the event loop
 * rather than hanging one Action.
 *
 * When a real caller supplies `passDeadlineMs`, it is one absolute deadline per
 * lane, not one deadline per page. Production otherwise follows the canonical
 * caller signal instead of inventing a latency policy in this provider layer.
 */

/**
 * Every way one returned page can fail the V1 page contract: the per-observation
 * qualification reasons, plus the page-level bound only this caller knows.
 *
 * An exact same-position zero-progress page is deliberately NOT here. It stays
 * inside the published page contract; the aggregate settles that transient
 * provider state without accusing the source of malformed output.
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
const SCAN_PASS_DEADLINE_FAILURE_V1: TriageListLaneHealthV1 = Object.freeze({
    kind: 'failed',
    failure: Object.freeze({
        class: 'transient',
        code: 'triage/scanPassDeadline',
        detail: 'The source did not answer before the aggregate pass deadline.',
    }),
});

/**
 * The lane health an exact zero-progress continuation produces.
 *
 * It is the same shape as the lane deadline above, and for the same reason:
 * both are aggregate settlement rather than invariants the source broke.
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
function stalledWalkFailure(): TriageListLaneHealthV1 {
    return {
        kind: 'failed',
        failure: {
            class: 'transient',
            code: 'triage/stalledWalk',
            detail: 'The source returned the same continuation without consuming provider position.',
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
    /** Positive per-page request chosen for this aggregate invocation. */
    pageLimit: number;
    /** The pass stops rotating once this many observations have been qualified. */
    observationBudget: number;
    nowMs: () => number;
    signal?: AbortSignal;
    /** Optional caller/test-supplied absolute duration for one lane's whole pass. */
    passDeadlineMs?: number;
}>): Promise<TriageScanPassResultV1> {
    const pageLimit = Math.max(1, Math.trunc(input.pageLimit));
    const passDeadlineMs = input.passDeadlineMs;
    const states: LaneState[] = input.lanes.map((lane) => {
        const deadline = new AbortController();
        return {
            lane,
            continuation: lane.resume ?? null,
            // A lane that never ran is not evidence that the walk finished.
            health: { kind: 'unavailable' },
            exhausted: false,
            active: true,
            deadlineStartedAtMs: null,
            deadline,
            signal: input.signal
                ? AbortSignal.any([input.signal, deadline.signal])
                : deadline.signal,
        };
    });
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
            if (input.observationBudget - observations.length < pageLimit) {
                // A provider page is atomic: its continuation advances past every
                // row it returns. Asking for a page the caller cannot carry and
                // truncating after the fact would strand the discarded suffix
                // behind an already-advanced frontier. Stop before fetching it;
                // the lane's current continuation remains the next reachable
                // page for a later transport window.
                state.active = false;
                continue;
            }

            // One controller per LANE, not per page. A provider cannot spend a
            // fresh deadline on every continuation, while another lane keeps
            // an independent budget so one unanswered source never consumes
            // every other source's chance to answer.
            const nowMs = performance.now();
            state.deadlineStartedAtMs ??= nowMs;
            const remainingMs = passDeadlineMs === undefined
                ? null
                : Math.max(0, passDeadlineMs - (nowMs - state.deadlineStartedAtMs));
            if (remainingMs === 0) {
                // Do not start another provider page after this lane has spent
                // its absolute budget. An already-resolved page can otherwise
                // win `Promise.race` against a zero-delay timer forever.
                state.deadline.abort();
                state.health = SCAN_PASS_DEADLINE_FAILURE_V1;
                state.active = false;
                continue;
            }
            const options: PluginCancellationOptions = { signal: state.signal };
            let settled: RaceWithTimeoutResult<TriageScanResultV1>;
            try {
                const pending = state.lane.scan(scanInputFor(state, pageLimit), options);
                settled = remainingMs === null
                    ? { type: 'resolved', value: await pending }
                    : await raceWithTimeout(pending, remainingMs);
            } catch (error) {
                // A synchronous throw is the same defect as a rejection.
                settled = { type: 'rejected', error };
            }

            if (settled.type === 'timeout') {
                // We are done with this lane, so stop the provider work we
                // stopped waiting for. Every page received the same signal.
                state.deadline.abort();
                // Neither an answer nor a failure. The lane leaves the rotation
                // as a classified transient failure, and every page it already
                // gave stays: an unanswered page is not evidence against the
                // ones that answered.
                state.health = SCAN_PASS_DEADLINE_FAILURE_V1;
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
                // Unexhausted is not resumable. The only continuation this lane
                // holds is the one that PRODUCED this settling page, and
                // `complete` says there is no page after it — so offering it
                // back would hand `actions/listEntries.ts` a window
                // continuation whose next read returns this same page and this
                // same stop, forever. Incomplete coverage is reported by
                // `exhausted: false`; a stop is a page to ask for, and there is
                // none.
                state.continuation = null;
                state.active = false;
                continue;
            }

            // Exact zero progress can settle immediately. An advancing cursor,
            // however, may legitimately traverse any number of empty provider
            // containers before reaching a row; counting those pages against an
            // observation-derived ceiling made deep repositories unreachable.
            if (
                page.length === 0
                && charged === 0
                && state.continuation !== null
                && state.continuation.token === result.continuation.token
            ) {
                state.health = stalledWalkFailure();
                state.exhausted = false;
                state.active = false;
                continue;
            }
            state.continuation = result.continuation;
            // A trusted source can answer synchronously. Yielding between prompt
            // advancing pages lets the lane's one absolute deadline and caller
            // cancellation run instead of allowing an infinite microtask chain
            // to starve the daemon. Time remains the bound; this adds no count.
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        }
    }

    // Retire every lane signal after its last possible consumer. Resolved
    // providers have already answered; unresolved providers were aborted at
    // their timeout above. This also releases caller-signal composition.
    for (const state of states) state.deadline.abort();

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
