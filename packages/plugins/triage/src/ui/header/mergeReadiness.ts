import type { HappierTone } from '@happier-dev/plugin-ui';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';

/**
 * How a source's offered merge reads beside Merge (plan 06, lab 'forge-ci/b4'): one line naming what is left,
 * and the rows it opens. Presentation only. It formats the source's native status and the requirement names the
 * source already decided are unmet; it never decides whether Merge may run — the source's admission does that
 * again at the press, and the provider has the last word.
 */

export type TriageReadinessRowStateV1 =
  | 'met'
  | 'failed'
  | 'needed'
  | 'waiting'
  | 'unknown';

export type TriageReadinessRowV1 = Readonly<{
  id: string;
  state: TriageReadinessRowStateV1;
  title: string;
  detail: string;
}>;

export type TriageMergeReadinessV1 = Readonly<{
  /** The line beside Merge; null when another line (queue, auto-merge) says the state instead. */
  line: Readonly<{
    words: string;
    detail: string | null;
    tone: HappierTone;
    marks: readonly HappierTone[];
  }> | null;
  head: string;
  sub: string | null;
  rows: readonly TriageReadinessRowV1[];
  /** The native queue entry, only while GitHub reports this pull request in it. */
  queue: Readonly<{
    position: number | null;
    etaSeconds: number | null;
  }> | null;
  /** The native auto-merge, only while the source reports it on. */
  autoMerge: Readonly<{ method: NonNullable<NonNullable<TriagePullRequestStatusV1['merge']>['autoMerge']>['method'] }> | null;
  /** When the shown status was last read successfully, and whether the latest refresh failed. */
  checkedAtMs: number | null;
  stale: boolean;
}>;

export type TriageReadinessTextV1 = (
  key: string,
  fallback: string,
  values?: Readonly<Record<string, string>>,
) => string;
export type TriageReadinessCountV1 = (
  key: string,
  count: number,
  english: Readonly<{ one: string; other: string }>,
) => string;

const MARK_TONE: Readonly<Record<TriageReadinessRowStateV1, HappierTone>> =
  Object.freeze({
    met: 'secondary',
    failed: 'danger',
    needed: 'attention',
    waiting: 'muted',
    unknown: 'muted',
  });

function readStatus(
  write: TriageDetailPrimaryWriteV1,
): TriagePullRequestStatusV1 | null {
  const native = write.nativeStatus;
  return native === undefined || native.kind === 'unavailable'
    ? null
    : native.value;
}

function readRows(
  status: TriagePullRequestStatusV1,
  write: TriageDetailPrimaryWriteV1,
  text: TriageReadinessTextV1,
  count: TriageReadinessCountV1,
  source: string,
): TriageReadinessRowV1[] {
  const rows: TriageReadinessRowV1[] = [];
  const base =
    status.branch?.base ?? text('plugins.triage.surface.merge.baseFallback', 'the base branch');
  const merge = status.merge;
  if (merge?.state === 'conflicts') {
    rows.push({
      id: 'conflicts',
      state: 'failed',
      title: text('plugins.triage.surface.merge.row.conflicts', 'No conflicts with {base}', { base }),
      detail: text(
        'plugins.triage.surface.merge.row.conflicts.detail',
        '{source} reports conflicts with {base}',
        { source, base },
      ),
    });
  }
  if (merge?.draft === true) {
    rows.push({
      id: 'draft',
      state: 'needed',
      title: text('plugins.triage.surface.merge.row.draft', 'Ready for review'),
      detail: text(
        'plugins.triage.surface.merge.row.draft.detail',
        'Still a draft, so it can’t merge yet',
      ),
    });
  }
  const checkRows = status.checks?.rows ?? [];
  const required = checkRows.filter((row) => row.required === true);
  if (required.length > 0) {
    const failed = required.filter((row) => row.state === 'failed');
    const pending = required.filter((row) => row.state === 'pending');
    const passed = required.filter((row) => row.state === 'passed').length;
    const of = text('plugins.triage.surface.merge.row.checks.passedOf', '{passed} of {total} passed', {
      passed: String(passed),
      total: String(required.length),
    });
    rows.push(
      failed.length > 0
        ? {
            id: 'checks',
            state: 'failed',
            title: text('plugins.triage.surface.merge.row.checks', 'Required checks'),
            detail: `${of} · ${text('plugins.triage.surface.merge.row.checks.failedNames', '{names} failed', { names: failed.map((row) => row.name).join(', ') })}`,
          }
        : pending.length > 0
          ? {
              id: 'checks',
              state: 'waiting',
              title: text('plugins.triage.surface.merge.row.checks', 'Required checks'),
              detail: `${of} · ${count('surface.merge.row.checks.running', pending.length, { one: '{count} running', other: '{count} running' })}`,
            }
          : passed === required.length
            ? {
                id: 'checks',
                state: 'met',
                title: text('plugins.triage.surface.merge.row.checks', 'Required checks'),
                detail: count('surface.merge.row.checks.allPassed', required.length, {
                  one: 'The required check passed',
                  other: 'All {count} passed',
                }),
              }
            : {
                id: 'checks',
                state: 'unknown',
                title: text('plugins.triage.surface.merge.row.checks', 'Required checks'),
                detail: of,
              },
    );
  } else if (
    checkRows.length > 0 &&
    checkRows.every(
      (row) => row.required === undefined || row.required === null,
    )
  ) {
    rows.push({
      id: 'checks',
      state: 'unknown',
      title: text('plugins.triage.surface.merge.row.checks', 'Required checks'),
      detail: text(
        'plugins.triage.surface.merge.row.checks.unknown',
        '{source} didn’t say which checks are required',
        { source },
      ),
    });
  }
  const review = status.review;
  const names = (verb: string) =>
    review?.reviewers
      .filter((reviewer) => reviewer.verb === verb)
      .map((reviewer) => reviewer.name)
      .join(', ') ?? '';
  if (review?.decision === 'approved') {
    const approvers = names('approved');
    rows.push({
      id: 'review',
      state: 'met',
      title: text('plugins.triage.surface.merge.row.review', 'Review'),
      detail:
        approvers.length > 0
          ? text('plugins.triage.surface.merge.row.review.approvedBy', '{names} approved', {
              names: approvers,
            })
          : text('plugins.triage.surface.merge.row.review.approved', 'Approved'),
    });
  } else if (review?.decision === 'changesRequested') {
    const requesters = names('changesRequested');
    rows.push({
      id: 'review',
      state: 'needed',
      title: text('plugins.triage.surface.merge.row.reviewRequired', 'Review required'),
      detail:
        requesters.length > 0
          ? text(
              'plugins.triage.surface.merge.row.review.changesBy',
              '{names} requested changes · waiting for a new review',
              { names: requesters },
            )
          : text(
              'plugins.triage.surface.merge.row.review.changes',
              'Changes were requested · waiting for a new review',
            ),
    });
  } else if (review?.decision === 'reviewRequired') {
    rows.push({
      id: 'review',
      state: 'needed',
      title: text('plugins.triage.surface.merge.row.reviewRequired', 'Review required'),
      detail: text(
        'plugins.triage.surface.merge.row.review.waiting',
        'Waiting for an approving review',
      ),
    });
  } else if (review === null || review?.incomplete === true) {
    rows.push({
      id: 'review',
      state: 'unknown',
      title: text('plugins.triage.surface.merge.row.review', 'Review'),
      detail: text(
        'plugins.triage.surface.merge.row.review.unknown',
        '{source} didn’t report the review decision',
        { source },
      ),
    });
  }
  if (merge?.nativeState === 'BEHIND') {
    rows.push(
      merge.upToDateRequired === true
        ? {
            id: 'upToDate',
            state: 'needed',
            title: text('plugins.triage.surface.merge.row.upToDate', 'Up to date with {base}', {
              base,
            }),
            detail: text(
              'plugins.triage.surface.merge.row.behind.detail',
              '{source} reports the branch is behind {base}',
              { source, base },
            ),
          }
        : {
            id: 'upToDate',
            state: 'unknown',
            title: text('plugins.triage.surface.merge.row.behind', 'Branch is behind {base}', { base }),
            detail: text(
              'plugins.triage.surface.merge.row.behind.unknown',
              '{source} reports it out of date, not whether this repository requires it to be current',
              { source },
            ),
          },
    );
  } else if (merge?.upToDateRequired === true) {
    rows.push({
      id: 'upToDate',
      state: 'met',
      title: text('plugins.triage.surface.merge.row.upToDate', 'Up to date with {base}', { base }),
      detail: text(
        'plugins.triage.surface.merge.row.upToDate.detail',
        '{source} reports the branch is current',
        { source },
      ),
    });
  }
  // A requirement the source named as unmet that none of the rows above explain (a policy, the queue).
  for (const requirement of write.unmetRequirements ?? []) {
    if (requirement.kind === 'check' || requirement.kind === 'review') continue;
    rows.push({
      id: `${requirement.kind}:${requirement.id}`,
      state: 'needed',
      title: requirement.label,
      detail:
        requirement.kind === 'queue'
          ? text('plugins.triage.surface.merge.row.queue.detail', 'Merges through the merge queue')
          : text('plugins.triage.surface.merge.row.policy.detail', 'A rule on {base}', { base }),
    });
  }
  if (
    merge?.state === 'blocked' &&
    !rows.some((row) => row.state === 'failed' || row.state === 'needed')
  ) {
    rows.push({
      id: 'blocked',
      state: 'needed',
      title: text('plugins.triage.surface.merge.row.blocked', 'Blocked on {source}', { source }),
      detail: text(
        'plugins.triage.surface.merge.row.blocked.detail',
        '{source} reports it can’t merge yet without saying why',
        { source },
      ),
    });
  }
  return rows;
}

export function presentTriageMergeReadinessV1(
  write: TriageDetailPrimaryWriteV1,
  text: TriageReadinessTextV1,
  count: TriageReadinessCountV1,
  source: string,
): TriageMergeReadinessV1 | null {
  const native = write.nativeStatus;
  const status = readStatus(write);
  // Only a write that carries the source's merge status reads as merge readiness; Mark ready and other writes
  // keep the plain control.
  if (native === undefined && write.readiness === undefined) return null;
  const checkedAtMs =
    native === undefined || native.kind === 'unavailable'
      ? null
      : native.checkedAtMs;
  const stale = native?.kind === 'stale' || native?.kind === 'unavailable';
  const footer = { checkedAtMs, stale };
  if (status === null) {
    const reading = write.pending || native === undefined;
    return {
      line: reading
        ? {
            words: text('plugins.triage.surface.merge.line.checking', 'Checking whether it can merge…'),
            detail: null,
            tone: 'secondary',
            marks: [],
          }
        : {
            words: text('plugins.triage.surface.merge.line.unavailable', 'Status unavailable'),
            detail: write.readiness?.reason ?? null,
            tone: 'secondary',
            marks: [],
          },
      head: reading
        ? text('plugins.triage.surface.merge.head.checking', '{source} is still working it out', {
            source,
          })
        : text('plugins.triage.surface.merge.head.unavailable', 'The status couldn’t be read', {
            source,
          }),
      sub: reading
        ? null
        : text(
            'plugins.triage.surface.merge.sub.unavailable',
            'Merge still goes to {source}, which decides.',
            { source },
          ),
      rows: [],
      queue: null,
      autoMerge: null,
      ...footer,
    };
  }
  const merge = status.merge;
  const readiness = status.operations?.readiness ?? 'unknown';
  const base =
    status.branch?.base ?? text('plugins.triage.surface.merge.baseFallback', 'the base branch');
  const rows = readRows(status, write, text, count, source);
  const marks = rows.map((row) => MARK_TONE[row.state]);
  const queue =
    merge?.queue == null
      ? null
      : {
          position: merge.queue.position,
          etaSeconds: merge.queue.estimatedTimeToMergeSeconds ?? null,
        };
  const autoMerge =
    merge?.autoMerge?.enabled === true
      ? { method: merge.autoMerge.method }
      : null;
  const blocking = rows.filter(
    (row) => row.state === 'failed' || row.state === 'needed',
  );
  const base0 = { rows, queue, autoMerge, ...footer };
  if (merge?.draft === true) {
    return {
      ...base0,
      line: {
        words: text('plugins.triage.surface.merge.line.draft', 'Draft'),
        detail: text('plugins.triage.surface.merge.line.draft.detail', 'reviews start when it’s ready'),
        tone: 'secondary',
        marks: [],
      },
      head: text('plugins.triage.surface.merge.head.draft', 'Still a draft'),
      sub: text(
        'plugins.triage.surface.merge.sub.draft',
        'Reviewers aren’t asked and it can’t merge until you mark it ready.',
      ),
    };
  }
  if (merge?.state === 'conflicts') {
    return {
      ...base0,
      line: {
        words: text('plugins.triage.surface.merge.line.conflicts', 'Conflicts with {base}', { base }),
        detail: null,
        tone: 'danger',
        marks,
      },
      head: text('plugins.triage.surface.merge.head.conflicts', 'Resolve the conflicts first'),
      sub: text(
        'plugins.triage.surface.merge.sub.conflicts',
        '{source} can’t merge until the conflicts are resolved.',
        { source },
      ),
    };
  }
  if (readiness === 'blocked' && blocking.length > 0) {
    const failedChecks = (status.checks?.rows ?? []).filter(
      (row) => row.required === true && row.state === 'failed',
    ).length;
    const reviewNeeded = rows.some(
      (row) => row.id === 'review' && row.state === 'needed',
    );
    const others = blocking.filter(
      (row) => row.id !== 'checks' && row.id !== 'review',
    ).length;
    const clauses = [
      ...(failedChecks > 0
        ? [
            count('surface.merge.line.checksFailing', failedChecks, {
              one: '{count} check failing',
              other: '{count} checks failing',
            }),
          ]
        : []),
      ...(reviewNeeded
        ? [text('plugins.triage.surface.merge.line.approvalNeeded', '1 approval needed')]
        : []),
      ...(others > 0
        ? [
            count('surface.merge.line.otherNeeded', others, {
              one: '{count} requirement left',
              other: '{count} requirements left',
            }),
          ]
        : []),
    ];
    return {
      ...base0,
      line: {
        words: clauses[0] ?? '',
        detail: clauses.length > 1 ? clauses.slice(1).join(' · ') : null,
        tone: failedChecks > 0 ? 'danger' : 'neutral',
        marks,
      },
      head: count('surface.merge.head.blocked', blocking.length, {
        one: '1 thing before you can merge',
        other: '{count} things before you can merge',
      }),
      sub: count('surface.merge.sub.blocked', blocking.length, {
        one: 'Merge is refused until it’s done.',
        other: 'Merge is refused until they’re done.',
      }),
    };
  }
  const waiting = rows.find(
    (row) => row.id === 'checks' && row.state === 'waiting',
  );
  if (readiness === 'blocked' && waiting !== undefined) {
    const pending = (status.checks?.rows ?? []).filter(
      (row) => row.required === true && row.state === 'pending',
    ).length;
    return {
      ...base0,
      line: {
        words: count('surface.merge.line.waiting', pending, {
          one: 'Waiting on 1 check',
          other: 'Waiting on {count} checks',
        }),
        detail: null,
        tone: 'neutral',
        marks,
      },
      head: count('surface.merge.head.waiting', pending, {
        one: 'Waiting on 1 required check',
        other: 'Waiting on {count} required checks',
      }),
      sub: text('plugins.triage.surface.merge.sub.waiting', 'Everything else is done.'),
    };
  }
  const incomplete =
    status.checks?.incomplete === true ||
    status.review?.incomplete === true ||
    status.projectionTruncated === true;
  if (readiness === 'unknown' && incomplete) {
    return {
      ...base0,
      line: {
        words: text('plugins.triage.surface.merge.line.incomplete', 'Status incomplete'),
        detail: text(
          'plugins.triage.surface.merge.line.incomplete.detail',
          '{source} sent only part of it',
          { source },
        ),
        tone: 'neutral',
        marks,
      },
      head: text(
        'plugins.triage.surface.merge.head.incomplete',
        '{source} sent only part of the status',
        { source },
      ),
      sub: text(
        'plugins.triage.surface.merge.sub.incomplete',
        'Rows show met only where {source} said so. Merge still goes to {source}, which decides.',
        { source },
      ),
    };
  }
  if (readiness === 'unknown' && rows.some((row) => row.id === 'upToDate' && row.state === 'unknown')) {
    return {
      ...base0,
      line: {
        words: text('plugins.triage.surface.merge.line.behind', 'Behind {base}', { base }),
        detail: text(
          'plugins.triage.surface.merge.line.behind.detail',
          '{source} reports it out of date',
          { source },
        ),
        tone: 'neutral',
        marks,
      },
      head: text('plugins.triage.surface.merge.head.behind', 'The branch is behind {base}', { base }),
      sub: text(
        'plugins.triage.surface.merge.sub.behind',
        '{source} doesn’t say whether that blocks merging here, so it isn’t drawn as a block. Merge shows {source}’s answer.',
        { source },
      ),
    };
  }
  if (readiness !== 'ready') {
    return {
      ...base0,
      line: {
        words: text(
          'plugins.triage.surface.merge.line.unknown',
          '{source} didn’t report every requirement',
          { source },
        ),
        detail: null,
        tone: 'neutral',
        marks,
      },
      head: text('plugins.triage.surface.merge.head.unknown', 'Not every requirement was reported'),
      sub: text(
        'plugins.triage.surface.merge.sub.unknown',
        'Nothing here is shown as ready. Merge sends it to {source} as an ordinary merge and shows its answer.',
        { source },
      ),
    };
  }
  if (native?.kind === 'stale') {
    // A retained success is a last-known fact, never current: Ready is only ever said about a current read.
    return {
      ...base0,
      line: {
        words: text('plugins.triage.surface.merge.line.stale', 'Status out of date'),
        detail: text('plugins.triage.surface.merge.line.stale.detail', '{source} couldn’t be reached', {
          source,
        }),
        tone: 'secondary',
        marks,
      },
      head: text('plugins.triage.surface.merge.head.stale', 'The status may be out of date'),
      sub: incomplete
        ? text('plugins.triage.surface.merge.sub.incomplete',
            'Rows show met only where {source} said so. Merge still goes to {source}, which decides.', { source })
        : text(
            'plugins.triage.surface.merge.sub.stale',
            'The last read said every requirement was met, but it couldn’t be refreshed. Merge still goes to {source}, which decides.',
            { source },
          ),
    };
  }
  return {
    ...base0,
    line: {
      words: text('plugins.triage.surface.merge.line.ready', 'Ready'),
      detail: incomplete
        ? text('plugins.triage.surface.merge.line.incomplete.detail', '{source} sent only part of it', { source })
        : text('plugins.triage.surface.merge.line.ready.detail', 'all requirements met'),
      tone: 'neutral',
      marks,
    },
    head: text('plugins.triage.surface.merge.head.ready', 'Ready to merge'),
    sub:
      merge?.queueRequired === true
        ? text(
            'plugins.triage.surface.merge.sub.readyQueue',
            '{base} merges through a queue, which runs the checks again with the pull requests ahead of this one.',
            { base },
          )
        : null,
  };
}
