import * as React from 'react';

import {
  Avatar,
  FactStrip,
  HappierPageSheet,
  resolveHappierWorkTheme,
  usePluginTheme,
  usePluginTranslation,
  type HappierFactStripFact,
  type TextTone,
} from '@happier-dev/plugin-ui';

import { resolveTriageRowFactStatusToneV1 } from '@happier-dev/triage-protocol/v1';
import { useChecksRollupLine } from '@happier-dev/triage-sources/ui';
import { checksFact, mergeFact, reviewFact } from '../../sessions/pullRequestGlance/factPresentation.js';
import type { TriageDetailHeaderV1 } from './header.js';

/** A Reviewers cell names this many people before it counts the rest. */
const NAMES_SHOWN = 1;

/** Only the owner's needs-you and failed words speak in colour; every other tone stays ink. */
function cellTone(tone: TextTone): Pick<HappierFactStripFact, 'tone'> {
  return tone === 'danger' ? { tone: 'danger' } : tone === 'warning' ? { tone: 'attention' } : {};
}

/**
 * A change request's glance cells under the detail header (ideas-1118 scene 1, B: the owner's choice): Status,
 * Checks and Reviewers, each a value that leads and a quiet line beneath, ruled apart on one sheet, two to a row on a
 * phone. The contributor supplies its settled detail facts or the native status shared with the Companion glance.
 *
 * The cells keep their place while those reads run. An issue or an error group has no change-request facts:
 * a linked fix PR is drawn once, by its own step in the story.
 */
export function TriageDetailHeaderFacts(
  props: Readonly<{ header: Pick<TriageDetailHeaderV1, 'pullRequestFacts' | 'attention' | 'sourceStatus'>; narrow?: boolean }>,
): React.ReactElement | null {
  const text = usePluginTranslation();
  const { palette } = resolveHappierWorkTheme(usePluginTheme());
  const facts = props.header.pullRequestFacts;
  const source = props.header.sourceStatus;
  const sourceChecks = source?.checks;
  const rollup = typeof sourceChecks === 'object' && sourceChecks !== null ? sourceChecks : null;
  const line = useChecksRollupLine(rollup?.rollup ?? null, false);
  if (facts === null) return null;
  const unavailable = { value: '—', tone: 'secondary' as const,
    sub: text('plugins.triage.surface.detail.facts.unavailable', 'Not available from this source') };
  const status = facts.merge.kind === 'unknown' && facts.merge.reading !== true
    ? unavailable
    : mergeFact(text, facts.merge, facts.branch?.base ?? null);
  const checks = line === null
    ? sourceChecks === 'empty' ? checksFact(text, { kind: 'none' })
      : sourceChecks === 'reading' ? checksFact(text, { kind: 'unknown', reading: true })
      : facts.checks.kind === 'unknown' && facts.checks.reading !== true ? unavailable : checksFact(text, facts.checks)
    : { value: line.lead ?? line.label, tone: line.state === 'failed' ? 'danger' : 'neutral',
        sub: rollup?.failing?.[0]?.name ?? (line.lead === null ? line.line : line.line.replace(/^· /, '')) };
  const sourceMerge = facts.merge.kind === 'unknown' ? source?.merge : null;
  const reviewStatus = source?.review === 'reading' ? { kind: 'unknown' as const, reading: true }
    : source?.review ?? facts.review;
  const review = reviewStatus.kind === 'unknown' && reviewStatus.reading !== true
    ? { ...unavailable, person: null } : reviewFact(text, reviewStatus);
  const people = reviewStatus.kind === 'unknown' || reviewStatus.kind === 'none' ? [] : reviewStatus.people;
  // The reader's own requested review is the one fact on this cell that needs them, said as "you" once. It leads
  // while no decision stands; a decision (changes requested, approved) keeps the lead and "you" goes beneath.
  const mine = props.header.attention?.reviewRequested === true;
  const you = text('plugins.triage.surface.detail.reviewers.you', 'Waiting on you');
  const decided = reviewStatus.kind === 'changesRequested' || reviewStatus.kind === 'approved';
  const reviewers = mine && !decided
    ? { value: you, tone: 'attention' as const, detail: null }
    : { value: review.value, ...cellTone(review.tone), detail: mine ? you
      : people.length > NAMES_SHOWN
        ? text('plugins.triage.surface.detail.reviewers.more', '{names} +{count}', {
          names: people.slice(0, NAMES_SHOWN).join(', '), count: String(people.length - NAMES_SHOWN),
        })
        : review.sub };
  const cells: HappierFactStripFact[] = [
    { key: 'status', testID: 'triage-detail-facts.status', label: text('plugins.triage.surface.detail.facts.status', 'Status'),
      ...(sourceMerge == null ? { value: status.value, ...cellTone(status.tone), detail: status.sub }
        : { value: sourceMerge.value, tone: resolveTriageRowFactStatusToneV1(sourceMerge.tone) }) },
    { key: 'checks', testID: 'triage-detail-facts.checks', label: text('plugins.triage.surface.detail.facts.checks', 'Checks'),
      value: checks.value, ...cellTone(checks.tone), detail: checks.sub },
    { key: 'reviewers', testID: 'triage-detail-facts.reviewers', label: text('plugins.triage.surface.detail.facts.reviewers', 'Reviewers'),
      ...reviewers, lead: review.person === null || (mine && !decided) ? null : <Avatar name={review.person} size="small" /> },
  ];
  return (
    <HappierPageSheet colors={palette} rowDividers={false} testID="triage-detail-facts">
      <FactStrip facts={cells} layout="columns" divided reserveDetail narrow={props.narrow === true} />
    </HappierPageSheet>
  );
}
