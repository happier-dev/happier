import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import {
  ReviewFindingRow,
  type ReviewFindingDecision,
} from '@/components/sessions/reviews/findings/ReviewFindingRow';
import type {
  ReviewFindingAskContext,
  ReviewFindingThreadEntryView,
} from '@/components/sessions/reviews/findings/ReviewFindingThread';

/**
 * Dev-only specimen of the opened finding (Reviews lab round 11, merged B: `detail-findings`,
 * `detail-finding-vB`, `detail-finding-split`), rendered through the real row and body owners with
 * fixture data. `?width=narrow` draws the split-pane column, below the shared row-stack width.
 * Fixture copy is the lab's illustration, not product copy; no RPC is issued unless a control is used.
 */
const NOW = Date.now();
const ask = async () => false;

const REMOUNT_PATCH = [
  '--- a/components/settings/SettingsModal.tsx',
  '+++ b/components/settings/SettingsModal.tsx',
  '@@ -140,4 +140,4 @@',
  '   <RetainedModalFrame placement={placement}>',
  '     <SettingsSheet',
  '-      key={`${route}-${activeTab}`}',
  '+      key={route}',
  '       tab={activeTab}',
].join('\n');

type Fixture = Readonly<{
  finding: ReviewFinding;
  decision: ReviewFindingDecision | 'undecided';
  reviewers: readonly Readonly<{ label: string; backendId: string }>[];
  entries: readonly ReviewFindingThreadEntryView[];
}>;

const FIXTURES: readonly Fixture[] = [
  {
    finding: {
      id: 'f1',
      title: 'Settings modal remounts on every tab switch',
      severity: 'blocker',
      category: 'correctness',
      filePath: 'components/settings/SettingsModal.tsx',
      startLine: 142,
      whyItMatters:
        'Switching tabs throws away the scroll position and any unsaved edits.',
      summary:
        'The sheet’s `key` includes the active tab, so React unmounts the whole sheet on every tab change.',
      evidence:
        'Reproduced on `4f2a91c` with a new test, `settingsModal.remount.test.tsx`: the sheet mounts 3 times for 2 tab switches (expected 1).',
      patch: REMOUNT_PATCH,
    },
    decision: 'undecided',
    reviewers: [
      { label: 'Claude', backendId: 'claude' },
      { label: 'Codex', backendId: 'codex' },
    ],
    entries: [
      {
        threadId: 't1',
        requestMarkdown: 'Does the phone sheet have the same problem?',
        answerMarkdown:
          'Yes. The phone sheet presentation has the same key, so it remounts there too.',
        generatedAtMs: NOW - 60_000,
        updatedFinding: null,
        previousFinding: null,
        reviewerLabel: 'Codex',
      },
    ],
  },
  {
    finding: {
      id: 'f2',
      title: 'Unsaved draft is lost when the modal closes during save',
      severity: 'blocker',
      category: 'correctness',
      filePath: 'useSettingsDraft.ts',
      startLine: 58,
      summary:
        'Closing while a save is in flight clears the draft before the save settles.',
    },
    decision: 'accept',
    reviewers: [{ label: 'Claude', backendId: 'claude' }],
    entries: [],
  },
  {
    finding: {
      id: 'f3',
      title: 'Effect re-subscribes to the settings store on every render',
      severity: 'high',
      category: 'performance',
      filePath: 'SettingsTabs.tsx',
      startLine: 31,
      summary:
        'The selector is an inline arrow, so the subscription is rebuilt on each render.',
    },
    decision: 'undecided',
    reviewers: [{ label: 'Codex', backendId: 'codex' }],
    entries: [],
  },
  {
    finding: {
      id: 'f4',
      title: 'Prefer a named export for SettingsModal',
      severity: 'nit',
      category: 'style',
      filePath: 'SettingsModal.tsx',
      startLine: 1,
      summary: 'Named exports keep the import name the same at every caller.',
    },
    decision: 'reject',
    reviewers: [{ label: 'Codex', backendId: 'codex' }],
    entries: [],
  },
];

const ASK_CONTEXT: ReviewFindingAskContext = {
  sessionId: 'dev-specimen',
  serverId: null,
  accountLifetime: null,
  draftRunId: 'run_dev_specimen',
  recipient: {
    label: 'Both',
    accessibilityLabel: 'Claude and Codex',
    backendIds: ['claude', 'codex'],
  },
  waitingLabel: 'Waiting for the reviewers…',
};

const FOLLOW_UP = { available: true } as const;

export function ReviewFindingSpecimen(
  props: Readonly<{ width: string | null; open: string | null }>,
) {
  const { width } = useWindowDimensions();
  const phone = width < 600;
  const columnWidth = phone ? width : props.width === 'narrow' ? 400 : 944;
  const [openRowId, setOpenRowId] = React.useState<string | null>(
    props.open ?? 'f1',
  );
  const [decisions, setDecisions] = React.useState<
    Readonly<Record<string, ReviewFindingDecision | 'undecided'>>
  >(() =>
    Object.fromEntries(
      FIXTURES.map((fixture) => [fixture.finding.id, fixture.decision]),
    ),
  );
  const toggle = React.useCallback(
    (rowId: string) =>
      setOpenRowId((current) => (current === rowId ? null : rowId)),
    [],
  );
  const decide = React.useCallback(
    (rowId: string, decision: ReviewFindingDecision) => {
      setDecisions((current) => ({ ...current, [rowId]: decision }));
    },
    [],
  );

  return (
    <ScrollView
      testID="review-finding-specimen"
      style={styles.root}
      contentContainerStyle={phone ? styles.contentPhone : styles.content}
    >
      <View
        style={[
          styles.sheet,
          phone ? styles.sheetPhone : null,
          { width: columnWidth },
        ]}
      >
        {FIXTURES.map((fixture, index) => (
          <ReviewFindingRow
            key={fixture.finding.id}
            rowId={fixture.finding.id}
            finding={fixture.finding}
            attribution={
              fixture.reviewers.length > 1
                ? {
                    label: 'Claude and Codex',
                    backendIds: fixture.reviewers.map(
                      (reviewer) => reviewer.backendId,
                    ),
                  }
                : {
                    label: fixture.reviewers[0]!.label,
                    backendIds: [fixture.reviewers[0]!.backendId],
                  }
            }
            reviewers={fixture.reviewers}
            original={null}
            density="page"
            divided={index > 0}
            decision={decisions[fixture.finding.id] ?? 'undecided'}
            decisionDisabled={false}
            decisionNote={null}
            onDecide={decide}
            followUp={FOLLOW_UP}
            threadEntries={fixture.entries}
            pendingQuestion={null}
            expanded={openRowId === fixture.finding.id}
            onToggleExpanded={toggle}
            askContext={ASK_CONTEXT}
            onAsk={ask}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.inset },
  content: { padding: theme.space.s24, alignItems: 'flex-start' },
  contentPhone: { padding: 0 },
  sheet: {
    borderRadius: theme.parts.codeBlock.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.base,
    paddingHorizontal: theme.space.s16,
  },
  sheetPhone: { borderRadius: 0, borderWidth: 0 },
}));
