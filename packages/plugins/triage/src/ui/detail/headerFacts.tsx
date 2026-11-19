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
 * phone. Every word comes from the PR facts owner the Companion glance and the linked-entry detail also draw, so
 * the three never read two ways.
 *
 * The cells are drawn from the first paint of any pull/merge request, quiet ("—", not read yet) until the source's
 * status read lands, so its arrival fills them in place and moves nothing below. An issue or an error group has none:
 * a linked fix PR is drawn once, by its own step in the story.
 */
export function TriageDetailHeaderFacts(
  props: Readonly<{ header: Pick<TriageDetailHeaderV1, 'pullRequestFacts' | 'attention'>; narrow?: boolean }>,
): React.ReactElement | null {
  const text = usePluginTranslation();
  const { palette } = resolveHappierWorkTheme(usePluginTheme());
  const facts = props.header.pullRequestFacts;
  if (facts === null) return null;
  const status = mergeFact(text, facts.merge, facts.branch?.base ?? null);
  const checks = checksFact(text, facts.checks);
  const review = reviewFact(text, facts.review);
  const people = facts.review.kind === 'unknown' || facts.review.kind === 'none' ? [] : facts.review.people;
  // The reader's own requested review is the one fact on this cell that needs them, said as "you" once. It leads
  // while no decision stands; a decision (changes requested, approved) keeps the lead and "you" goes beneath.
  const mine = props.header.attention?.reviewRequested === true;
  const you = text('plugins.triage.surface.detail.reviewers.you', 'Waiting on you');
  const decided = facts.review.kind === 'changesRequested' || facts.review.kind === 'approved';
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
      value: status.value, ...cellTone(status.tone), detail: status.sub },
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
