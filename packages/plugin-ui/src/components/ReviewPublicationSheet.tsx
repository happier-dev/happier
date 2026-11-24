import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import type { ReviewPublicationSummaryPartsV1 } from '@happier-dev/plugin-sdk/reviews';

import type { ReviewCommentProposalWithBodyV1 } from '../hostApi/reviewCommentProposals.public.js';
import { Checkbox } from './Checkbox.js';
import { Field, Select, Toggle } from './Form.js';
import { Item } from './List.js';
import { Row, Stack } from './Layout.js';
import {
  usePluginTranslation,
  type PluginTranslate,
} from './PluginUiProvider.js';
import { ReviewPublicationSummaryPreview } from './ReviewPublicationSummaryPreview.js';
import { SettingRow } from './Setting.js';
import { Card } from './Surface.js';
import { Text } from './Text.js';

export type ReviewPublicationSheetProps = Readonly<{
  /** The forge's name as the person knows it ("GitHub", "GitLab"). */
  forgeName: string;
  verdict: Readonly<{
    options: readonly Readonly<{ value: string; label: string }>[];
    value: string;
    onChange: (value: string) => void;
  }>;
  /** The forge's own summary editor (plain field or Markdown editor); the sheet names it "Summary". */
  summary: ReactNode;
  /** The proposed findings the person can post or leave out. */
  proposals: readonly ReviewCommentProposalWithBodyV1[];
  /**
   * The proposals the publication plan posts. The forge owns this list and builds its plan (the input of its
   * Publish Action) from it, so what is checked here is exactly what is sent.
   */
  selectedIds: readonly string[];
  onSelectedIdsChange: (ids: readonly string[]) => void;
  /** Present only when the round has a saved Walkthrough to fold under the summary. */
  walkthrough?: Readonly<{
    included: boolean;
    onChange: (included: boolean) => void;
    stopCount: number;
  }> | null;
  /** The producer's typed parts for the summary the plan posts; null while the plan carries no summary. */
  preview: ReviewPublicationSummaryPartsV1 | null;
  /** Inline comments the plan posts (its entries), for the preview's header. */
  inlineCommentCount: number;
  /** Read states and warnings the forge owns (proposals loading or failed, summary required). */
  notices?: ReactNode;
  /** The forge's Publish control(s), titled by {@link reviewPublicationPublish}. */
  actions: ReactNode;
  testID?: string;
}>;

const KEY = 'happier.plugin-ui.reviewPublication';

/**
 * The Publish control's title and whether it may publish, from the plan the forge built: "Publish 2 comments"
 * counts the plan's entries. With findings proposed and none checked there is nothing to publish; a review with no
 * proposed findings still publishes its verdict and summary alone ("Publish review").
 */
export function reviewPublicationPublish(
  text: PluginTranslate,
  plan: Readonly<{ proposalCount: number; entryCount: number }>,
): Readonly<{ title: string; blocked: boolean }> {
  if (plan.proposalCount === 0)
    return {
      title: text(`${KEY}.publishReview`, 'Publish review'),
      blocked: false,
    };
  return {
    title:
      plan.entryCount === 1
        ? text(`${KEY}.publishOne`, 'Publish 1 comment')
        : text(`${KEY}.publishMany`, 'Publish {count} comments', {
            count: plan.entryCount,
          }),
    blocked: plan.entryCount === 0,
  };
}

/** A proposal the person has not chosen yet starts checked unless it is a nit. */
function includedByDefault(proposal: ReviewCommentProposalWithBodyV1): boolean {
  return proposal.finding?.severity !== 'nit';
}

const INITIAL_SELECTION: Readonly<{ choices: ReadonlyMap<string, boolean>; cleared: boolean }> = {
  choices: new Map(),
  cleared: false,
};

/** Keep explicit choices across pages. Clearing the draft leaves later proposals unchecked too. */
export function useReviewPublicationSelection(
  proposals: readonly ReviewCommentProposalWithBodyV1[],
): readonly [selectedIds: readonly string[], setSelectedIds: (ids: readonly string[]) => void] {
  const [selection, setSelection] = useState(INITIAL_SELECTION);
  const selectedIds = useMemo(
    () => proposals.filter((proposal) => selection.choices.get(proposal.id)
      ?? (!selection.cleared && includedByDefault(proposal))).map((proposal) => proposal.id),
    [selection, proposals],
  );
  const setSelectedIds = useCallback((ids: readonly string[]) => {
    const chosen = new Set(ids);
    setSelection((current) => {
      const choices = new Map(current.choices);
      for (const proposal of proposals) choices.set(proposal.id, chosen.has(proposal.id));
      return { choices, cleared: current.cleared || chosen.size === 0 };
    });
  }, [proposals]);
  return [selectedIds, setSelectedIds];
}

function severityLabel(
  text: PluginTranslate,
  proposal: ReviewCommentProposalWithBodyV1,
): string | null {
  const severity = proposal.finding?.severity;
  if (severity === undefined) return null;
  // The published summary's three groups (blockers, nits, and everything else as "Should fix").
  if (severity === 'blocker') return text(`${KEY}.severity.blocker`, 'Blocker');
  if (severity === 'nit') return text(`${KEY}.severity.nit`, 'Nit');
  return text(`${KEY}.severity.shouldFix`, 'Should fix');
}

function locationLabel(
  proposal: ReviewCommentProposalWithBodyV1,
): string | null {
  const anchor = proposal.anchor;
  const path =
    proposal.finding?.filePath ??
    ('filePath' in anchor ? anchor.filePath : null);
  if (!path) return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const line =
    proposal.finding?.startLine ??
    (anchor.kind === 'line'
      ? anchor.line
      : anchor.kind === 'range'
        ? anchor.startLine
        : null);
  return line ? `${name}:${line}` : name;
}

/** A proposed finding's one-line name: its finding's title, or the first line of its comment. */
export function reviewPublicationFindingTitle(proposal: ReviewCommentProposalWithBodyV1): string {
  return (
    proposal.finding?.title ?? proposal.body.split('\n', 1)[0] ?? proposal.body
  );
}

/**
 * The Publish sheet's body, shared by every forge (lab ideas-1118-reviews scene 4 "Publish sheet"): review type,
 * summary, the findings to post (the ones left out stay listed as not posted), the folded Walkthrough, and the
 * exact preview of what will be posted. It draws the forge's plan inputs and owns no selection of its own.
 */
export function ReviewPublicationSheet(
  props: ReviewPublicationSheetProps,
): ReactElement {
  const text = usePluginTranslation();
  const selected = new Set(props.selectedIds);
  const walkthrough = props.walkthrough;
  return (
    <Stack gap="medium" testID={props.testID}>
      <Field label={text(`${KEY}.reviewType`, 'Review type')}>
        <Select
          label={text(`${KEY}.reviewType`, 'Review type')}
          presentation="segmented"
          fill
          options={props.verdict.options}
          value={props.verdict.value}
          onChange={(value) => {
            if (typeof value === 'string') props.verdict.onChange(value);
          }}
        />
      </Field>
      <Field label={text(`${KEY}.summary`, 'Summary')}>{props.summary}</Field>
      {props.notices}
      {props.proposals.length > 0 ? (
        <Field
          label={text(`${KEY}.findings`, 'Findings')}
          description={text(`${KEY}.findingsCount`, '{selected} of {total} · ignored ones are never posted', {
            selected: props.selectedIds.length,
            total: props.proposals.length,
          })}
        >
        <Card padding="none">
          {props.proposals.map((proposal, index) => {
            const posted = selected.has(proposal.id);
            const facts = [
              severityLabel(text, proposal),
              locationLabel(proposal),
              posted ? text(`${KEY}.inlineComment`, 'inline comment') : text(`${KEY}.notPosted`, 'not posted'),
            ];
            return (
              <Item
                key={proposal.id}
                testID={`review-publication-finding-${proposal.id}`}
                title={reviewPublicationFindingTitle(proposal)}
                subtitle={facts.filter((fact): fact is string => fact !== null).join(' · ')}
                titleNumberOfLines={1}
                showDivider={index < props.proposals.length - 1}
                tone={posted ? undefined : 'secondary'}
                icon={<Checkbox
                  checked={posted}
                  accessibilityLabel={reviewPublicationFindingTitle(proposal)}
                  onChange={(next) => props.onSelectedIdsChange(next
                    ? props.proposals.filter((candidate) => candidate.id === proposal.id || selected.has(candidate.id))
                      .map((candidate) => candidate.id)
                    : props.selectedIds.filter((id) => id !== proposal.id))}
                />}
              />
            );
          })}
        </Card>
        </Field>
      ) : null}
      {walkthrough ? (
        <SettingRow
          title={text(`${KEY}.includeWalkthrough`, 'Include the walkthrough')}
          hint={walkthrough.stopCount === 1
            ? text(`${KEY}.includeWalkthroughHintOne`, 'Folded under the summary · 1 stop, its title and first sentence')
            : text(`${KEY}.includeWalkthroughHintMany`, 'Folded under the summary · {count} stops, titles and first sentences',
              { count: walkthrough.stopCount })}
          onPress={() => walkthrough.onChange(!walkthrough.included)}
          control={
            <Toggle
              label={text(
                `${KEY}.includeWalkthrough`,
                'Include the walkthrough',
              )}
              value={walkthrough.included}
              onChange={walkthrough.onChange}
            />
          }
        />
      ) : null}
      {props.preview ? (
        <Field label={text(`${KEY}.preview`, 'Preview')}>
          <Card
            padding="medium"
            testID={
              props.testID === undefined ? undefined : `${props.testID}-preview`
            }
          >
            <Stack gap="small">
              <Row gap="small" justify="space-between" wrap>
                <Text
                  variant="meta"
                  tone="secondary"
                  valueKey={`${KEY}.previewOn`}
                  fallback="Preview of the summary on {forge}"
                  values={{ forge: props.forgeName }}
                />
                <Text
                  variant="meta"
                  tone="secondary"
                  valueKey={
                    props.inlineCommentCount === 1
                      ? `${KEY}.inlineCommentsOne`
                      : `${KEY}.inlineCommentsMany`
                  }
                  fallback={
                    props.inlineCommentCount === 1
                      ? '1 inline comment'
                      : '{count} inline comments'
                  }
                  values={{ count: props.inlineCommentCount }}
                />
              </Row>
              <ReviewPublicationSummaryPreview parts={props.preview} />
            </Stack>
          </Card>
        </Field>
      ) : null}
      {props.actions}
    </Stack>
  );
}
