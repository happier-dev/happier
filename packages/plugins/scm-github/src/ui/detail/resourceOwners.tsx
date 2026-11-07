import * as React from 'react';
import { useTabPanelActivity } from '@happier-dev/plugin-ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';

import type {
  GithubFeedbackCommentV1,
  GithubFeedbackRequestV1,
  GithubFeedbackReviewV1,
  GithubFeedbackThreadV1,
} from '../../triage/feedback.js';
import type { GithubProjectedTimelineRowV1 } from '../../triage/detail/projection.js';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubOverviewControllerV1 } from './overviewReader.js';
import {
  useGithubChangedFilesReader,
  useGithubFeedbackConnectionReader,
  useGithubTimelineReader,
  type GithubChangedFileViewV1,
  type GithubChecksControllerV1,
  type GithubPagedControllerV1,
  type GithubReaderActivityV1,
} from './panelReaders.js';

/**
 * One owner per GitHub resource for the lifetime of one open detail.
 *
 * The story's Changes and Checks steps, the Files and Checks tabs, and Activity
 * all show the same four facts: the checks of the head commit, the changed-file
 * walk, the timeline walk and the feedback connections. Each is read by exactly
 * one reader mounted here, at the detail body, and every panel renders from that
 * reader's answer. A tab switch therefore re-renders; it never re-reads.
 *
 * Checks are not a separate read: the Overview's canonical pull-request read already
 * acquires the head's whole check rollup, so `GithubDetailChecksFromOverview` serves
 * every checks consumer from that one answer; a shown checks consumer is Overview read
 * demand (`useGithubChecksDemanded`), so the Overview owner reads once when it must.
 *
 * Demand, not mount, starts a read: a reader is active only while some consumer
 * that needs it is inside its own active tab interval, so a resource no visible
 * panel uses is never requested. Leaving cancels in-flight work; the settled
 * answer stays for the detail's lifetime and is replaced only by a real change
 * signal: an explicit refresh, a new head revision (checks, files) or GitHub's
 * own update time for the entry (timeline, feedback). There is no timer.
 */

type GithubDetailResourceIdV1 = 'checks' | 'files' | 'timeline' | 'comments' | 'threads' | 'reviews' | 'requests';

type GithubReviewDecisionV1 = 'approved' | 'changes-requested' | 'review-required' | null;
type GithubFeedbackConnectionControllerV1<TRow> = GithubPagedControllerV1<TRow> & Readonly<{
  reviewDecision: GithubReviewDecisionV1;
}>;

const DemandContext = React.createContext<((id: GithubDetailResourceIdV1) => () => void) | null>(null);
const DemandStateContext = React.createContext<Readonly<Record<GithubDetailResourceIdV1, number>> | null>(null);
const ChecksContext = React.createContext<GithubChecksControllerV1 | null>(null);
const FilesContext = React.createContext<GithubPagedControllerV1<GithubChangedFileViewV1> | null>(null);
const TimelineContext = React.createContext<GithubPagedControllerV1<GithubProjectedTimelineRowV1> | null>(null);
const FeedbackContext = React.createContext<Readonly<{
  comments: GithubFeedbackConnectionControllerV1<GithubFeedbackCommentV1>;
  threads: GithubFeedbackConnectionControllerV1<GithubFeedbackThreadV1>;
  reviews: GithubFeedbackConnectionControllerV1<GithubFeedbackReviewV1>;
  requests: GithubFeedbackConnectionControllerV1<GithubFeedbackRequestV1>;
}> | null>(null);

type Demand = Readonly<Record<GithubDetailResourceIdV1, number>>;
const NO_DEMAND: Demand = Object.freeze({ checks: 0, files: 0, timeline: 0, comments: 0, threads: 0, reviews: 0, requests: 0 });

function useDemandedActivity(detail: GithubReaderActivityV1, demanded: boolean): GithubReaderActivityV1 {
  const active = detail.active && demanded;
  return React.useMemo(() => ({ active, activeSignal: detail.activeSignal }), [active, detail.activeSignal]);
}

/**
 * Replaces a settled answer when its change signal moves, keeping it on screen
 * meanwhile. A signal that moves before anything settled needs nothing: the
 * first read is already current. The replacement waits for an active reader.
 */
function useReplaceOnChange(signal: unknown, active: boolean, settled: boolean, pending: boolean, refresh: () => void): void {
  const seen = React.useRef(signal);
  const [stale, setStale] = React.useState(false);
  if (!Object.is(seen.current, signal)) {
    seen.current = signal;
    if (settled && !stale) setStale(true);
  }
  React.useEffect(() => {
    if (!stale || !active || pending) return;
    setStale(false);
    refresh();
  }, [active, pending, refresh, stale]);
}

function pagedSettled(controller: GithubPagedControllerV1<unknown>): boolean {
  return controller.state.kind !== 'idle' && controller.state.kind !== 'loading';
}

export function GithubDetailResourcesProvider({ input, activity, children }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  /** The open detail's own interval; each reader narrows it to its demand. */
  activity: GithubReaderActivityV1;
  children: React.ReactNode;
}>): React.ReactElement {
  const [demand, setDemand] = React.useState<Demand>(NO_DEMAND);
  const acquire = React.useCallback((id: GithubDetailResourceIdV1) => {
    setDemand((current) => ({ ...current, [id]: current[id] + 1 }));
    return () => setDemand((current) => ({ ...current, [id]: current[id] - 1 }));
  }, []);

  const head = input.observation.snapshot.reviewRevision?.headSha;
  const updated = input.observation.sourceUpdatedAtMs;

  const filesActivity = useDemandedActivity(activity, demand.files > 0);
  const files = useGithubChangedFilesReader(input, filesActivity);
  useReplaceOnChange(head, filesActivity.active, pagedSettled(files), files.state.pending, files.refresh);

  const timelineActivity = useDemandedActivity(activity, demand.timeline > 0);
  const timeline = useGithubTimelineReader(input, timelineActivity);
  useReplaceOnChange(updated, timelineActivity.active, pagedSettled(timeline), timeline.state.pending, timeline.refresh);

  const commentsActivity = useDemandedActivity(activity, demand.comments > 0);
  const comments = useGithubFeedbackConnectionReader<GithubFeedbackCommentV1>(input, 'comments', commentsActivity);
  useReplaceOnChange(updated, commentsActivity.active, pagedSettled(comments), comments.state.pending, comments.refresh);
  const threadsActivity = useDemandedActivity(activity, demand.threads > 0);
  const threads = useGithubFeedbackConnectionReader<GithubFeedbackThreadV1>(input, 'threads', threadsActivity);
  useReplaceOnChange(updated, threadsActivity.active, pagedSettled(threads), threads.state.pending, threads.refresh);
  const reviewsActivity = useDemandedActivity(activity, demand.reviews > 0);
  const reviews = useGithubFeedbackConnectionReader<GithubFeedbackReviewV1>(input, 'reviews', reviewsActivity);
  useReplaceOnChange(updated, reviewsActivity.active, pagedSettled(reviews), reviews.state.pending, reviews.refresh);
  const requestsActivity = useDemandedActivity(activity, demand.requests > 0);
  const requests = useGithubFeedbackConnectionReader<GithubFeedbackRequestV1>(input, 'requests', requestsActivity);
  useReplaceOnChange(updated, requestsActivity.active, pagedSettled(requests), requests.state.pending, requests.refresh);

  const feedback = React.useMemo(() => ({ comments, threads, reviews, requests }), [comments, threads, reviews, requests]);

  // Each resource has its own context so a settled page re-renders only its consumers.
  return (
    <DemandContext.Provider value={acquire}>
      <DemandStateContext.Provider value={demand}>
        <FilesContext.Provider value={files}>
          <TimelineContext.Provider value={timeline}>
            <FeedbackContext.Provider value={feedback}>{children}</FeedbackContext.Provider>
          </TimelineContext.Provider>
        </FilesContext.Provider>
      </DemandStateContext.Provider>
    </DemandContext.Provider>
  );
}

const CHECKS_NOT_READ: TriageSourceFailureV1 = Object.freeze({ class: 'unknown', code: 'github_checks_unavailable' });

/** True while some checks consumer is inside its active tab interval: Overview read demand. */
export function useGithubChecksDemanded(): boolean {
  return (React.useContext(DemandStateContext)?.checks ?? 0) > 0;
}

/**
 * Serves the detail's checks from the Overview's own answer. Refresh re-reads through
 * that same owner, and a new head resets it there.
 */
export function GithubDetailChecksFromOverview({ overview, children }: Readonly<{
  overview: GithubOverviewControllerV1;
  children: React.ReactNode;
}>): React.ReactElement {
  const { value, refreshing, failure, refresh } = overview;
  const pullRequest = value?.kindId === 'pull-request' ? value : null;
  const view = pullRequest?.checks ?? null;
  const controller = React.useMemo<GithubChecksControllerV1>(() => ({
    state: view !== null ? { kind: 'ready', value: view }
      : failure !== null && !refreshing ? { kind: 'unavailable', failure }
        : pullRequest !== null && !refreshing
          ? { kind: 'unavailable', failure: pullRequest.pullRequestStatus?.checks?.failure ?? CHECKS_NOT_READ }
          : { kind: 'loading' },
    failure: view === null ? null : failure,
    pending: refreshing,
    overviewFailure: view === null && failure !== null && !refreshing,
    refresh: () => { void refresh(); },
  }), [failure, pullRequest, refresh, refreshing, view]);
  return <ChecksContext.Provider value={controller}>{children}</ChecksContext.Provider>;
}

/** Declares this panel needs `id` for as long as its own tab interval is active. */
function useResourceDemand(id: GithubDetailResourceIdV1): void {
  const acquire = React.useContext(DemandContext);
  const { active } = useTabPanelActivity();
  React.useEffect(() => (active && acquire !== null ? acquire(id) : undefined), [acquire, active, id]);
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`${name} is read only inside GithubDetailResourcesProvider.`);
  return value;
}

export function useGithubChecks(): GithubChecksControllerV1 {
  useResourceDemand('checks');
  return required(React.useContext(ChecksContext), 'GitHub checks');
}

export function useGithubChangedFiles(): GithubPagedControllerV1<GithubChangedFileViewV1> {
  useResourceDemand('files');
  return required(React.useContext(FilesContext), 'GitHub changed files');
}

export function useGithubTimeline(): GithubPagedControllerV1<GithubProjectedTimelineRowV1> {
  useResourceDemand('timeline');
  return required(React.useContext(TimelineContext), 'GitHub timeline');
}

export function useGithubFeedbackComments(): GithubFeedbackConnectionControllerV1<GithubFeedbackCommentV1> {
  useResourceDemand('comments');
  return required(React.useContext(FeedbackContext), 'GitHub feedback').comments;
}

export function useGithubFeedbackThreads(): GithubFeedbackConnectionControllerV1<GithubFeedbackThreadV1> {
  useResourceDemand('threads');
  return required(React.useContext(FeedbackContext), 'GitHub feedback').threads;
}

export function useGithubFeedbackReviews(): GithubFeedbackConnectionControllerV1<GithubFeedbackReviewV1> {
  useResourceDemand('reviews');
  return required(React.useContext(FeedbackContext), 'GitHub feedback').reviews;
}

export function useGithubFeedbackRequests(): GithubFeedbackConnectionControllerV1<GithubFeedbackRequestV1> {
  useResourceDemand('requests');
  return required(React.useContext(FeedbackContext), 'GitHub feedback').requests;
}
