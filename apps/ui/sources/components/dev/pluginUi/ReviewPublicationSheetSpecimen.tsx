import * as React from 'react';
import {
  Button,
  Form,
  ReviewPublicationSheet,
  reviewPublicationDefaultSelection,
  reviewPublicationPublish,
  usePluginTranslation,
  type ReviewCommentProposalWithBodyV1,
} from '@happier-dev/plugin-ui';
import { buildReviewPublicationSummaryV1 } from '@happier-dev/plugin-sdk/reviews';

type Severity = 'blocker' | 'medium' | 'nit';

function proposal(
  id: string,
  severity: Severity,
  title: string,
  filePath: string,
  line: number,
): ReviewCommentProposalWithBodyV1 {
  // A static fixture: the sheet reads only the id, body, anchor and finding of a proposal.
  return {
    id,
    body: `${title}.`,
    anchor: { kind: 'line', filePath, line, side: 'after' },
    finding: {
      id: `finding-${id}`,
      severity,
      category: 'correctness',
      title,
      summary: `${title}.`,
    },
  } as unknown as ReviewCommentProposalWithBodyV1;
}

const PROPOSALS = [
  proposal(
    'pub-1',
    'blocker',
    'Timer survives a manual reconnect',
    'src/sync/reconnectPolicy.ts',
    57,
  ),
  proposal(
    'pub-2',
    'medium',
    'Jitter can push the first retry past 2 s',
    'src/sync/jitter.ts',
    12,
  ),
  proposal(
    'pub-3',
    'nit',
    'README example uses the old option name',
    'README.md',
    88,
  ),
];

const WALKTHROUGH = [
  {
    title: 'Back off between attempts',
    explanationMarkdown:
      'Reconnect waits longer after each failure instead of retrying in a tight loop.',
  },
  {
    title: 'A manual reconnect starts clean',
    explanationMarkdown:
      'Reconnecting by hand clears the backoff, so it never waits behind an old timer.',
  },
];

const VERDICTS = ['comment', 'approve', 'requestChanges'] as const;

/**
 * The shared Publish sheet as a forge mounts it (lab ideas-1118-reviews scene 4): its own selection and Walkthrough
 * switch build the summary through the canonical producer, and the Publish title counts what the plan would post.
 * Publishing itself is a forge Action, so this button does nothing.
 */
export function ReviewPublicationSheetSpecimen() {
  const text = usePluginTranslation();
  const [verdict, setVerdict] =
    React.useState<(typeof VERDICTS)[number]>('comment');
  const [summary, setSummary] = React.useState(
    'One blocker: the backoff timer survives a manual reconnect, so a second reconnect starts with a long wait. One smaller note below.',
  );
  const [selectedIds, setSelectedIds] = React.useState(() =>
    reviewPublicationDefaultSelection(PROPOSALS),
  );
  const [includeWalkthrough, setIncludeWalkthrough] = React.useState(true);
  const selected = PROPOSALS.filter((candidate) =>
    selectedIds.includes(candidate.id),
  );
  const preview =
    summary.trim() === ''
      ? null
      : buildReviewPublicationSummaryV1({
          verdict: { kind: verdict, body: summary.trim() },
          headRevision: '9c1e4b2',
          findings: selected.flatMap((candidate) =>
            candidate.finding
              ? [{ ...candidate.finding, happierCommentId: candidate.id }]
              : [],
          ),
          reviewId: 'specimen-review',
          walkthrough: includeWalkthrough ? WALKTHROUGH : undefined,
        });
  const publish = reviewPublicationPublish(text, {
    proposalCount: PROPOSALS.length,
    entryCount: selected.length,
  });
  return (
    <ReviewPublicationSheet
      forgeName="GitHub"
      testID="review-publication-sheet-specimen"
      verdict={{
        options: [
          { value: 'comment', label: 'Comment' },
          { value: 'approve', label: 'Approve' },
          { value: 'requestChanges', label: 'Request changes' },
        ],
        value: verdict,
        onChange: (value) => {
          const next = VERDICTS.find((candidate) => candidate === value);
          if (next !== undefined) setVerdict(next);
        },
      }}
      summary={
        <Form.TextField
          label="Summary"
          value={summary}
          required
          onChange={setSummary}
        />
      }
      proposals={PROPOSALS}
      selectedIds={selectedIds}
      onSelectedIdsChange={setSelectedIds}
      walkthrough={{
        included: includeWalkthrough,
        onChange: setIncludeWalkthrough,
        stopCount: WALKTHROUGH.length,
      }}
      preview={preview}
      inlineCommentCount={selected.length}
      actions={
        <Button
          title={publish.title}
          variant="primary"
          disabled={publish.blocked || preview === null}
          onPress={() => {}}
        />
      }
    />
  );
}
