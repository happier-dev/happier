import { memo, useCallback, useLayoutEffect, useRef, type ReactElement } from 'react';

import type { ReviewCommentProposalWithBodyV1 } from '../hostApi/reviewCommentProposals.public.js';
import { Checkbox } from './Checkbox.js';
import { Field } from './Form.js';
import { Item } from './List.js';
import { usePluginTranslation, type PluginTranslate } from './PluginUiProvider.js';
import { Card } from './Surface.js';

const KEY = 'happier.plugin-ui.reviewPublication';

function severityLabel(text: PluginTranslate, proposal: ReviewCommentProposalWithBodyV1): string | null {
  const severity = proposal.finding?.severity;
  if (severity === undefined) return null;
  if (severity === 'blocker') return text(`${KEY}.severity.blocker`, 'Blocker');
  if (severity === 'nit') return text(`${KEY}.severity.nit`, 'Nit');
  return text(`${KEY}.severity.shouldFix`, 'Should fix');
}

function locationLabel(proposal: ReviewCommentProposalWithBodyV1): string | null {
  const anchor = proposal.anchor;
  const path = proposal.finding?.filePath ?? ('filePath' in anchor ? anchor.filePath : null);
  if (!path) return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const line = proposal.finding?.startLine ?? (anchor.kind === 'line'
    ? anchor.line : anchor.kind === 'range' ? anchor.startLine : null);
  return line ? `${name}:${line}` : name;
}

/** A proposed finding's one-line name: its finding's title, or the first line of its comment. */
export function reviewPublicationFindingTitle(proposal: ReviewCommentProposalWithBodyV1): string {
  return proposal.finding?.title ?? proposal.body.split('\n', 1)[0] ?? proposal.body;
}

const ReviewPublicationFinding = memo(function ReviewPublicationFinding(props: Readonly<{
  proposal: ReviewCommentProposalWithBodyV1;
  posted: boolean;
  showDivider: boolean;
  onIncludedChange: (id: string, included: boolean) => void;
}>): ReactElement {
  const text = usePluginTranslation();
  const title = reviewPublicationFindingTitle(props.proposal);
  const facts = [
    severityLabel(text, props.proposal),
    locationLabel(props.proposal),
    props.posted ? text(`${KEY}.inlineComment`, 'inline comment') : text(`${KEY}.notPosted`, 'not posted'),
  ];
  return <Item
    testID={`review-publication-finding-${props.proposal.id}`}
    title={title}
    subtitle={facts.filter((fact): fact is string => fact !== null).join(' · ')}
    titleNumberOfLines={1}
    showDivider={props.showDivider}
    tone={props.posted ? undefined : 'secondary'}
    icon={<Checkbox checked={props.posted} accessibilityLabel={title}
      onChange={(included) => props.onIncludedChange(props.proposal.id, included)} />}
  />;
});

type ReviewPublicationFindingsProps = Readonly<{
  proposals: readonly ReviewCommentProposalWithBodyV1[];
  selectedIds: readonly string[];
  onSelectedIdsChange: (ids: readonly string[]) => void;
}>;

export const ReviewPublicationFindings = memo(function ReviewPublicationFindings(
  props: ReviewPublicationFindingsProps,
): ReactElement | null {
  const text = usePluginTranslation();
  // Rows receive one stable intent, not the whole changing selection. Resolve that intent against
  // the committed draft at the click, so consecutive choices never use a sibling's old selection.
  const draft = useRef(props);
  useLayoutEffect(() => { draft.current = props; }, [props]);
  const onIncludedChange = useCallback((id: string, included: boolean) => {
    const current = draft.current;
    const selected = new Set(current.selectedIds);
    current.onSelectedIdsChange(included
      ? current.proposals.filter((proposal) => proposal.id === id || selected.has(proposal.id)).map((proposal) => proposal.id)
      : current.selectedIds.filter((selectedId) => selectedId !== id));
  }, []);
  if (props.proposals.length === 0) return null;
  const selected = new Set(props.selectedIds);
  return <Field
    label={text(`${KEY}.findings`, 'Findings')}
    description={text(`${KEY}.findingsCount`, '{selected} of {total} · ignored ones are never posted', {
      selected: props.selectedIds.length, total: props.proposals.length,
    })}
  >
    <Card padding="none">
      {props.proposals.map((proposal, index) => <ReviewPublicationFinding key={proposal.id}
        proposal={proposal} posted={selected.has(proposal.id)} showDivider={index < props.proposals.length - 1}
        onIncludedChange={onIncludedChange} />)}
    </Card>
  </Field>;
});
