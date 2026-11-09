import { isPluginError, readPluginErrorRequestIdV1, type LoggerService, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
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
import { TriageListInvocationErrorV1Schema } from '../actions/listEntriesProtocol.js';

/**
 * One materialization pass over the configured source instances.
 *
 * The pass walks pages serially inside each lane and admits lanes fairly,
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
 * Every page follows the canonical caller signal through body completion.
 * The pass schedules no wake, imposes no local deadline and retries nothing.
 */

/** One configured source instance, bound to the exact admitted `scan` it is read through. */
export type TriageScanLaneV1 = Readonly<{
    sourceInstanceId: string;
    /** The admitted source contribution identity. A source never supplies it. */
    source: PluginContributionIdentity;
    /** The kinds this source's descriptor declares; every local ref is validated against them. */
    declaredKindIds: readonly string[];
    /** Optional lens selection. Validate all declared kinds before charging selected rows. */
    selectedKindIds?: readonly string[];
    completed?: TriageScanInputV1['completed'];
    query?: string;
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
    /** Geometry retained beside `resume`; omitted for a new lane. */
    pageLimit?: number;
    /** Source-declared native minimum, used only when starting a new walk. */
    minimumScanPageSize?: number;
    scan: (input: TriageScanInputV1, options?: PluginCancellationOptions) => Promise<TriageScanResultV1>;
}>;

/** Where one lane's walk stopped, when it stopped with more to give. */
export type TriageScanPassStopV1 = Readonly<{
    sourceInstanceId: string;
    pageLimit: number;
    /** Omitted for a lane the result budget did not allow us to start. */
    continuation?: TriageScanContinuationV1;
}>;

export type TriageScanPassResultV1 = Readonly<{
    /** Capacity for the result projection, including the first lane's atomic page. */
    observationBudget: number;
    observations: readonly CorpusQualifiedObservationV1[];
    lanes: readonly TriageListLaneV1[];
    /**
     * The lanes the observation budget stopped mid-walk, and the page each one
     * would continue from.
     *
     * An unvisited initial lane or a HEALTHY unfinished lane appears: a lane that exhausted has nothing
     * to continue, and a lane that failed or violated the page
     * contract has nothing worth continuing — its next read starts over, which
     * is what the failure classes already drive. Reporting it is what lets a
     * caller append the next bounded window instead of re-walking from page one.
     */
    stopped: readonly TriageScanPassStopV1[];
}>;

type LaneState = {
    readonly lane: TriageScanLaneV1;
    readonly pageLimit: number;
    continuation: TriageScanContinuationV1 | null;
    health: TriageListLaneHealthV1;
    exhausted: boolean;
};

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
 * The lane health an exact zero-progress continuation produces.
 *
 * It is aggregate settlement rather than an invariant the source broke.
 * A page that stays inside every published bound and asks to be called again is
 * a legal page — an omission-only continuation page, which the contract admits
 * precisely so a source can decode tolerantly, is the ordinary shape of it — so
 * classifying it `unsupportedContract` accused a conforming plugin and, worse,
 * discarded every valid page the same lane had already given.
 *
 * The walk is unfinished, not broken. The lane keeps its pages
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

function scanInputFor(state: LaneState): TriageScanInputV1 {
    const completed = {
        ...(state.lane.completed === undefined ? {} : { completed: state.lane.completed }),
        ...(state.lane.query === undefined ? {} : { query: state.lane.query }),
    };
    return state.continuation === null
        ? { v: 1, instance: state.lane.configured, ...completed, page: { kind: 'initial', limit: state.pageLimit } }
        : { v: 1, instance: state.lane.configured, ...completed, page: { kind: 'continuation', continuation: state.continuation } };
}

export async function runTriageScanPass(input: Readonly<{
    lanes: readonly TriageScanLaneV1[];
    /** Positive per-page request chosen for this aggregate invocation. */
    pageLimit: number;
    /** Requested capacity, promoted when the first lane requires a larger atomic page. */
    observationBudget: number;
    nowMs: () => number;
    logger?: Pick<LoggerService, 'warn'>;
    signal?: AbortSignal;
}>): Promise<TriageScanPassResultV1> {
    const pageLimit = Math.max(1, Math.trunc(input.pageLimit));
    const states: LaneState[] = input.lanes.map((lane) => {
        return {
            lane,
            pageLimit: Math.max(1, Math.trunc(lane.pageLimit
                ?? Math.max(pageLimit, lane.minimumScanPageSize ?? 1))),
            continuation: lane.resume ?? null,
            // A lane that never ran is not evidence that the walk finished.
            health: { kind: 'unavailable' },
            exhausted: false,
        };
    });
    // A fair share can be smaller than one native page. Admit that first page
    // whole rather than returning an unavailable lane without making a read.
    // The descriptor and retained geometry already fit the wire row maximum;
    // return this decision so projection cannot cut rows behind its frontier.
    // A zero budget remains a metadata-only read.
    const observationBudget = input.observationBudget > 0
        ? Math.max(input.observationBudget, states[0]?.pageLimit ?? 0)
        : input.observationBudget;
    const observations: CorpusQualifiedObservationV1[] = [];
    /** Lanes whose page violated the contract; nothing they produced is adopted. */
    const contractFailed = new Set<string>();
    const aborted = (): boolean => input.signal?.aborted ?? false;
    let ready = states.slice();
    // Text search spends one source page per query. Further pages remain explicit
    // Load More demand instead of silently draining a sparse remote result set.
    const searched: LaneState[] = [];
    const pending = new Map<LaneState, Promise<Readonly<{
        state: LaneState;
        settled: PromiseSettledResult<TriageScanResultV1>;
    }>>>();
    let reserved = 0;

    while (ready.length > 0 || pending.size > 0) {
        if (aborted()) break;
        const waiting = ready;
        ready = [];
        for (const state of waiting) {
            if (aborted()) break;
            if (observationBudget - observations.length - reserved < state.pageLimit) {
                // A provider page is atomic: its continuation advances past every
                // row it returns. Reserve its whole limit before starting it,
                // including while another lane is unanswered. A short answer
                // releases unused capacity to the lanes still waiting in order.
                ready.push(state);
                continue;
            }

            const options: PluginCancellationOptions = input.signal ? { signal: input.signal } : {};
            reserved += state.pageLimit;
            pending.set(state, (async () => {
                let settled: PromiseSettledResult<TriageScanResultV1>;
                try {
                    settled = { status: 'fulfilled', value: await state.lane.scan(scanInputFor(state), options) };
                } catch (error) {
                    // A synchronous throw is the same defect as a rejection.
                    settled = { status: 'rejected', reason: error };
                }
                return { state, settled };
            })());
        }
        // No pending page can release more capacity: retain every unfinished
        // frontier for the next transport window instead of truncating a page.
        if (pending.size === 0 || aborted()) break;
        const { state, settled } = await Promise.race(pending.values());
        pending.delete(state);
        reserved -= state.pageLimit;
        // Cancellation remains effective until the provider body has settled.
        if (aborted()) break;
        if (settled.status === 'rejected') {
            // A rejected invocation is not provider evidence about the source.
            const parsed = isPluginError(settled.reason)
                ? TriageListInvocationErrorV1Schema.safeParse({
                    code: settled.reason.code, retryable: settled.reason.retryable,
                    requestId: readPluginErrorRequestIdV1(settled.reason),
                })
                : null;
            const error = parsed?.success
                ? parsed.data
                : { code: 'triage/scanInvocationRejected' };
            state.health = { kind: 'unavailable', error };
            input.logger?.warn('Triage source scan invocation rejected', {
                sourceInstanceId: state.lane.sourceInstanceId,
                sourcePluginId: state.lane.source.pluginId,
                ...error,
            });
            continue;
        }
        const result = settled.value;

        if (result.kind === 'failed') {
            state.health = { kind: 'failed', failure: result.failure };
            continue;
        }

        const charged = chargedAgainstLimit(result);
        if (charged > state.pageLimit) {
            // Over-limit is a source-contract failure of the whole lane, not
            // partially valid data: truncating would publish a conforming
            // page for a source whose accounting is not conforming, and
            // dropping the excess would lose rows silently.
            contractFailed.add(state.lane.sourceInstanceId);
            state.health = contractFailure('pageLimitExceeded');
            state.exhausted = false;
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
            continue;
        }

        // Selection belongs before the result budget: a mixed provider page
        // must not spend task capacity on PRs and strand later tasks behind
        // a cursor that already advanced. Qualification above still checks
        // every returned kind, including those this lens does not display.
        const selectedKindIds = state.lane.selectedKindIds;
        observations.push(...(selectedKindIds === undefined
            ? page
            : page.filter((observation) => selectedKindIds.includes(observation.entryRef.kindId))));
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
            continue;
        }

        // A page continuation is the provider's position, so it must
        // advance independently of whether the page delivered rows or
        // reported omitted observations. An advancing cursor may
        // legitimately traverse any number of empty provider containers;
        // an unchanged one can only replay this page.
        if (
            state.continuation !== null
            && state.continuation.token === result.continuation.token
        ) {
            state.health = stalledWalkFailure();
            state.exhausted = false;
            continue;
        }
        state.continuation = result.continuation;
        if (state.lane.query) searched.push(state);
        else ready.push(state);
    }

    return Object.freeze({
        observationBudget,
        observations: Object.freeze(
            observations.filter((observation) => !contractFailed.has(observation.sourceInstanceId)),
        ),
        lanes: Object.freeze(states.map((state) => Object.freeze({
            sourceInstanceId: state.lane.sourceInstanceId,
            source: state.lane.source,
            health: state.health,
            exhausted: state.exhausted,
        }))),
        // Ready and query-parked lanes have more work; failed and finished lanes
        // left those queues when they settled. Preserve rotation so an unvisited
        // lane runs before an earlier lane's next page. An initial frontier
        // needs no fabricated native cursor.
        stopped: Object.freeze(aborted() ? [] : [...ready, ...searched].map((state) => Object.freeze({
            sourceInstanceId: state.lane.sourceInstanceId,
            pageLimit: state.pageLimit,
            ...(state.continuation === null ? {} : { continuation: state.continuation }),
        }))),
    });
}
