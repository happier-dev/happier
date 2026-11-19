import * as React from 'react';

import {
  DiffStat,
  Icon,
  Row,
  Stack,
  Text,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { TriageChecksRollupLine } from '@happier-dev/triage-sources/ui';

import type {
  TriageDetailHeaderV1,
  TriageDetailReviewerVerbV1,
} from './header.js';

/** A reviewer group names this many people before it counts the rest. */
const NAMES_SHOWN = 2;

/**
 * Lets a fact that is wider than its line (a long head branch) take the whole line and shrink there instead of
 * overflowing the pane; a fact that fits keeps its own width so the next one can stand beside it.
 */
const FACT_FIT_STYLE_V1 = { maxWidth: '100%' } as const;

const REVIEWER_COPY: Readonly<
  Record<TriageDetailReviewerVerbV1, readonly [key: string, fallback: string]>
> = {
  changesRequested: [
    'plugins.triage.surface.detail.reviewers.changesRequested',
    '{names} requested changes',
  ],
  approved: [
    'plugins.triage.surface.detail.reviewers.approved',
    '{names} approved',
  ],
  pending: [
    'plugins.triage.surface.detail.reviewers.pending',
    'Waiting on {names}',
  ],
  commented: [
    'plugins.triage.surface.detail.reviewers.commented',
    '{names} commented',
  ],
};

/**
 * A change request's facts under the detail header (DESIGN.md: an entity as a header with its facts): the branch
 * pair with its diff size, the one checks outcome, then who reviewed it and where each review stands.
 *
 * Each fact is one unit that wraps whole to the next line on a narrow pane; only the head branch, the longest and
 * least-read name, shortens, and the base branch and the diff size beside it always stay. A source shows only the
 * facts it states: an issue or an error group has none, and the row is absent.
 */
export function TriageDetailHeaderFacts(
  props: Readonly<{ header: TriageDetailHeaderV1 }>,
): React.ReactElement | null {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const { branches, changeFacts } = props.header;
  const diff = changeFacts?.diff ?? null;
  const checks = changeFacts?.checks ?? null;
  const reviewers = changeFacts?.reviewers ?? [];
  if (
    branches === null &&
    diff === null &&
    checks === null &&
    reviewers.length === 0
  )
    return null;
  return (
    <Row gap="medium" align="center" wrap>
      {branches === null && diff === null ? null : (
        <Row gap="xsmall" align="center" style={FACT_FIT_STYLE_V1}>
          {branches === null ? null : (
            <>
              <Icon
                name="branch"
                size="small"
                tone="secondary"
                accessibilityLabel={text(
                  'plugins.triage.surface.detail.facts.branch',
                  'Branch',
                )}
              />
              <Stack grow>
                <Text
                  variant="meta"
                  tone="secondary"
                  value={branches.head}
                  numberOfLines={1}
                />
              </Stack>
              <Text
                variant="meta"
                tone="secondary"
                value={text(
                  'plugins.triage.surface.detail.branchInto',
                  '→ {base}',
                  { base: branches.base },
                )}
                numberOfLines={1}
              />
            </>
          )}
          {diff === null ? null : (
            <DiffStat
              added={diff.additions}
              removed={diff.deletions}
              locale={locale}
            />
          )}
        </Row>
      )}
      {checks === null ? null : (
        <Row gap="xsmall" align="center">
          <Icon
            name="workflow"
            size="small"
            tone="secondary"
            accessibilityLabel={text(
              'plugins.triage.surface.detail.facts.checks',
              'Checks',
            )}
          />
          <TriageChecksRollupLine rollup={checks} variant="meta" />
        </Row>
      )}
      {reviewers.length === 0 ? null : (
        <Row gap="xsmall" align="center" style={FACT_FIT_STYLE_V1}>
          <Icon
            name="review"
            size="small"
            tone="secondary"
            accessibilityLabel={text(
              'plugins.triage.surface.detail.facts.reviewers',
              'Reviewers',
            )}
          />
          <Stack grow>
            <Text
              variant="meta"
              tone="secondary"
              numberOfLines={1}
              value={reviewers
                .map((group) => {
                  const shown = group.names.slice(0, NAMES_SHOWN).join(', ');
                  const names =
                    group.names.length > NAMES_SHOWN
                      ? text(
                          'plugins.triage.surface.detail.reviewers.more',
                          '{names} +{count}',
                          {
                            names: shown,
                            count: String(group.names.length - NAMES_SHOWN),
                          },
                        )
                      : shown;
                  const [key, fallback] = REVIEWER_COPY[group.verb];
                  return text(key, fallback, { names });
                })
                .join(' · ')}
            />
          </Stack>
        </Row>
      )}
    </Row>
  );
}
