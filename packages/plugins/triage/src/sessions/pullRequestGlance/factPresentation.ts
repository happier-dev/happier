import type { TextTone, usePluginTranslation } from '@happier-dev/plugin-ui';
import type { PullRequestGlanceChecksV1, PullRequestGlanceReviewV1, PullRequestGlanceMergeV1, PullRequestGlanceWatchV1 } from './glanceModel.js';

type Translate = ReturnType<typeof usePluginTranslation>;

export function capitalizeFirst(value: string): string {
  return value.length === 0
    ? value
    : value[0]!.toLocaleUpperCase() + value.slice(1);
}

export function watchLineText(
  text: Translate,
  watch: PullRequestGlanceWatchV1,
  agent: string | null,
): Readonly<{ value: string; tone: TextTone }> {
  const agentName = capitalizeFirst(
    agent ?? text('plugins.triage.prWatch.theAgent', 'the agent'),
  );
  switch (watch.kind) {
    case 'off':
      return {
        value: text('plugins.triage.prGlance.watch.off', 'Not watching'),
        tone: 'secondary',
      };
    case 'watching':
      return {
        value: text('plugins.triage.prGlance.watch.watching', 'Watching'),
        tone: 'neutral',
      };
    case 'fixing':
      return {
        value:
          watch.limit === null
            ? text(
                'plugins.triage.prGlance.watch.fixing',
                '{agent} is fixing this PR',
                { agent: agentName },
              )
            : text(
                'plugins.triage.prGlance.watch.fixingRound',
                '{agent} is fixing · round {round} of {limit}',
                { agent: agentName, round: watch.round, limit: watch.limit },
              ),
        tone: 'neutral',
      };
    case 'exhausted':
      return {
        value: text(
          'plugins.triage.prGlance.watch.exhausted',
          'Stopped after {count} fix rounds',
          { count: watch.rounds },
        ),
        tone: 'warning',
      };
    case 'credentials':
      return {
        value: text(
          'plugins.triage.prGlance.watch.paused',
          'Paused',
        ),
        tone: 'warning',
      };
    case 'paused':
      return {
        value:
          watch.machine === null
            ? text('plugins.triage.prGlance.watch.paused', 'Paused')
            : text(
                'plugins.triage.prGlance.watch.pausedMachine',
                'Paused · {machine} is offline',
                { machine: watch.machine },
              ),
        tone: 'secondary',
      };
    case 'terminal':
      return {
        // The facts already say merged or closed; the line says only what it means for watching.
        value: text('plugins.triage.prGlance.watch.stopped', 'Watching stopped'),
        tone: 'secondary',
      };
  }
}

export function checksFact(
  text: Translate,
  checks: PullRequestGlanceChecksV1,
): Readonly<{
  value: string;
  tone: TextTone;
  sub: string | null;
  lead: 'failed' | 'running' | 'passed' | null;
}> {
  switch (checks.kind) {
    case 'unknown':
      return {
        value: '—',
        tone: 'secondary',
        sub: text('plugins.triage.prGlance.checks.unknown', 'Not read yet'),
        lead: null,
      };
    case 'none':
      return {
        value: text('plugins.triage.prGlance.checks.none', 'No checks'),
        tone: 'secondary',
        sub: null,
        lead: null,
      };
    case 'failing':
      return {
        value: text(
          'plugins.triage.prGlance.checks.failing',
          '{count} failing',
          { count: checks.count },
        ),
        tone: 'danger',
        lead: 'failed',
        sub:
          checks.first === null
            ? null
            : checks.more > 0
              ? text(
                  'plugins.triage.prGlance.checks.firstAndMore',
                  '{name} and {more} more',
                  { name: checks.first, more: checks.more },
                )
              : checks.first,
      };
    case 'running': {
      const done =
        checks.done !== null && checks.total !== null
          ? text(
              'plugins.triage.prGlance.checks.done',
              '{done} of {total} done',
              { done: checks.done, total: checks.total },
            )
          : null;
      const cancelled =
        checks.cancelled > 0
          ? text(
              'plugins.triage.prGlance.checks.cancelled',
              '{count} cancelled',
              { count: checks.cancelled },
            )
          : null;
      return {
        value: text('plugins.triage.prGlance.checks.running', 'Running'),
        tone: 'neutral',
        lead: 'running',
        sub: [done, cancelled].filter(Boolean).join(' · ') || null,
      };
    }
    case 'passed':
      return {
        value:
          checks.count === null
            ? text('plugins.triage.prGlance.checks.passedAll', 'Passed')
            : text('plugins.triage.prGlance.checks.passed', '{count} passed', {
                count: checks.count,
              }),
        tone: 'neutral',
        lead: 'passed',
        sub:
          checks.cancelled > 0
            ? text(
                'plugins.triage.prGlance.checks.cancelled',
                '{count} cancelled',
                { count: checks.cancelled },
              )
            : null,
      };
  }
}

export function reviewFact(
  text: Translate,
  review: PullRequestGlanceReviewV1,
): Readonly<{
  value: string;
  tone: TextTone;
  sub: string | null;
  person: string | null;
}> {
  switch (review.kind) {
    case 'unknown':
      return {
        value: '—',
        tone: 'secondary',
        sub: text('plugins.triage.prGlance.checks.unknown', 'Not read yet'),
        person: null,
      };
    case 'none':
      return {
        value: text('plugins.triage.prGlance.review.none', 'No review yet'),
        tone: 'secondary',
        sub: null,
        person: null,
      };
    case 'changesRequested':
      return {
        value: text(
          'plugins.triage.sessionLinks.changesRequested',
          'Changes requested',
        ),
        tone: 'warning',
        sub: review.people.join(', ') || null,
        person: review.people[0] ?? null,
      };
    case 'approved':
      return {
        value: text('plugins.triage.sessionLinks.approved', 'Approved'),
        tone: 'neutral',
        sub: review.people.join(', ') || null,
        person: review.people[0] ?? null,
      };
    case 'reviewRequired':
      return {
        value: text(
          'plugins.triage.sessionLinks.reviewRequired',
          'Review required',
        ),
        tone: 'neutral',
        sub: review.people.join(', ') || null,
        person: null,
      };
  }
}

export function mergeFact(
  text: Translate,
  merge: PullRequestGlanceMergeV1,
  base: string | null,
): Readonly<{ value: string; tone: TextTone; sub: string | null }> {
  const into =
    base === null
      ? null
      : text('plugins.triage.prGlance.merge.into', 'into {base}', { base });
  switch (merge.kind) {
    case 'unknown':
      return {
        value: '—',
        tone: 'secondary',
        sub: text('plugins.triage.prGlance.checks.unknown', 'Not read yet'),
      };
    case 'merged':
      return {
        value: text('plugins.triage.prGlance.merge.merged', 'Merged'),
        tone: 'neutral',
        sub: into,
      };
    case 'closed':
      return {
        value: text('plugins.triage.prGlance.merge.closed', 'Closed'),
        tone: 'secondary',
        sub: text(
          'plugins.triage.prGlance.merge.closedDetail',
          'without merging',
        ),
      };
    case 'draft':
      return {
        value: text('plugins.triage.prGlance.merge.draft', 'Draft'),
        tone: 'neutral',
        sub: text(
          'plugins.triage.prGlance.merge.draftDetail',
          'not ready for review',
        ),
      };
    case 'conflicts':
      return {
        value: text(
          'plugins.triage.sessionLinks.status.conflicts',
          'Conflicts',
        ),
        tone: 'warning',
        sub:
          base === null
            ? null
            : text(
                'plugins.triage.prGlance.merge.conflictsWith',
                'with {base}',
                { base },
              ),
      };
    case 'stale':
      return {
        value: '—',
        tone: 'secondary',
        sub: text('plugins.triage.prGlance.merge.stale', 'was ready when last read'),
      };
    case 'ready':
      return {
        value: text('plugins.triage.prGlance.merge.ready', 'Ready'),
        tone: 'neutral',
        sub: [merge.partial === true
          ? text('plugins.triage.sessionLinks.status.partial', 'Some status details could not be read.') : null,
          merge.queued
          ? text('plugins.triage.prGlance.merge.queued', 'in the merge queue')
          : merge.autoMerge
            ? text(
                'plugins.triage.prGlance.merge.autoMerge',
                'merges when ready',
              )
            : into].filter(Boolean).join(' · ') || null,
      };
    case 'blocked': {
      const sub = merge.blocker !== undefined ? merge.blocker
        : merge.why === 'checksAndReview'
          ? text(
              'plugins.triage.prGlance.merge.whyChecksAndReview',
              'check and review',
            )
          : merge.why === 'checks'
            ? text('plugins.triage.prGlance.merge.whyChecks', 'failing check')
            : merge.why === 'review'
              ? text(
                  'plugins.triage.prGlance.merge.whyReview',
                  'waiting for review',
                )
              : merge.why === 'running'
                ? text(
                    'plugins.triage.prGlance.merge.whyRunning',
                    'checks still running',
                  )
                : null;
      return {
        value: text('plugins.triage.sessionLinks.status.blocked', 'Blocked'),
        tone: 'neutral',
        sub,
      };
    }
  }
}


