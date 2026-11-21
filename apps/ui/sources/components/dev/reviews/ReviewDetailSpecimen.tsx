import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import type { ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ReviewRoundRuns } from '@/components/reviews/detail/ReviewDetailHost';
import { ReviewChangesUnavailable } from '@/components/reviews/ReviewChangesHost';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import {
  ReviewDetailState,
  ReviewDetailView,
  type ReviewDetailRound,
  type ReviewDetailTabId,
} from '@/components/reviews/detail/ReviewDetailView';
import { ReviewFindingsList } from '@/components/reviews/detail/ReviewFindingsList';
import { formatReviewFindingLocation } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { showReviewNewRoundDialog } from '@/components/reviews/detail/ReviewNewRoundDialog';
import { ReviewSubmitPanel } from '@/components/reviews/detail/ReviewSubmitPanel';
import { ReviewSummary } from '@/components/reviews/summary/ReviewSummary';
import {
  ReviewFindingRow,
  type ReviewFindingDecision,
} from '@/components/sessions/reviews/findings/ReviewFindingRow';
import type { ReviewFindingAskContext } from '@/components/sessions/reviews/findings/ReviewFindingThread';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * Dev-only specimen of the Review page (Reviews lab `detail-findings`, `detail-rounds`, `detail-submit`,
 * `detail-newround`, `detail-round2`, `detail-nomachine`, `detail-loading`, `detail-failed`), mounting the
 * real page, findings list, finding row, submit panel and New round owners with fixture data. Fixture copy is
 * the lab's illustration, not product copy; no RPC is issued unless a control is used.
 */
const ask = async () => false;
const FOLLOW_UP = { available: true } as const;
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
  },
  {
    finding: {
      id: 'f4',
      title: 'No test covers switching tabs from the keyboard',
      severity: 'medium',
      category: 'testing',
      filePath: 'settingsModal.test.tsx',
      summary:
        'Keyboard tab switching goes through a different handler with no test.',
    },
    decision: 'undecided',
    reviewers: [{ label: 'Claude', backendId: 'claude' }],
  },
  {
    finding: {
      id: 'f5',
      title: 'Tab change handler is recreated on every render',
      severity: 'medium',
      category: 'performance',
      filePath: 'SettingsTabs.tsx',
      startLine: 18,
      summary:
        'The handler closes over the tab list and is rebuilt each render.',
    },
    decision: 'accept',
    reviewers: [
      { label: 'Codex', backendId: 'codex' },
      { label: 'Claude', backendId: 'claude' },
    ],
  },
  {
    finding: {
      id: 'f6',
      title: 'Prefer a named export for SettingsModal',
      severity: 'nit',
      category: 'style',
      filePath: 'SettingsModal.tsx',
      startLine: 1,
      summary: 'Named exports keep the import name the same at every caller.',
    },
    decision: 'reject',
    reviewers: [{ label: 'Codex', backendId: 'codex' }],
  },
];

function agentMark(agentId: string) {
  return <AgentIcon agentId={agentId} size={ICON_SIZE.sm} />;
}
function personMark(id: string, monogram: string) {
  return <Avatar id={id} monogram={monogram} size={18} />;
}
function GlyphMark(props: Readonly<{ name: 'shield' | 'robot' | 'chat' }>) {
  const { theme } = useUnistyles();
  return <Icon name={props.name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}
function glyphMark(name: 'shield' | 'robot' | 'chat') {
  return <GlyphMark name={name} />;
}

function roundOf(
  ordinal: number,
  people: 'waiting' | 'submitted',
  round2 = false,
): ReviewDetailRound {
  return {
    ordinal,
    state: 'completed',
    groups: [
      {
        id: 'engines',
        title: 'Step 1 · Engines and bots review',
        status: 'done',
        detail: '3 findings',
        participants: [
          {
            id: 'coderabbit',
            label: 'CodeRabbit',
            mark: glyphMark('robot'),
            state: round2 ? 'Finished' : 'Didn’t finish',
            tone: round2 ? null : 'failed',
          },
          {
            id: 'deepsec',
            label: 'DeepSec',
            mark: glyphMark('shield'),
            state: '2 findings',
          },
        ],
      },
      {
        id: 'agents',
        title: 'Step 2 · Agents double-check findings',
        status: 'done',
        participants: [
          {
            id: 'claude',
            label: 'Claude',
            mark: agentMark('claude'),
            state: 'Verified 4, disputed 2',
          },
          {
            id: 'codex',
            label: 'Codex',
            mark: agentMark('codex'),
            state: 'Verified 3',
          },
          {
            id: 'session',
            label: 'Fix settings modal remount',
            mark: glyphMark('chat'),
            state: 'Verified 4',
          },
        ],
      },
      {
        id: 'people',
        title: t('reviewWalkthrough.detail.people'),
        status: people === 'waiting' ? 'waiting' : 'done',
        detail:
          people === 'waiting'
            ? t('reviewWalkthrough.detail.waitingForYou')
            : null,
        detailTone: 'attention',
        participants: [
          {
            id: 'mika',
            label: 'Mika Tanaka',
            mark: personMark('mika', 'MT'),
            state: round2
              ? t('reviewWalkthrough.detail.askedAgain')
              : t('reviewWalkthrough.detail.verdictChangesRequested'),
            tone: round2 ? null : 'attention',
          },
          {
            id: 'you',
            label: t('reviewWalkthrough.detail.you'),
            mark: personMark('you', 'LB'),
            state:
              people === 'waiting'
                ? null
                : t('reviewWalkthrough.detail.verdictApproved'),
          },
          {
            id: 'ari',
            label: 'Ari Novak',
            mark: personMark('ari', 'AN'),
            qualifier: t('reviewWalkthrough.detail.optional'),
            state: t('reviewWalkthrough.detail.verdictCommented'),
          },
        ],
      },
    ],
  };
}

function sealedExcerpt(input: Readonly<{ id: string; title: string; severity: ReviewFinding['severity']; filePath: string;
  line: number; before: string[]; selected: string[]; after: string[] }>) {
  return buildReviewCommentFixture({
    id: input.id, reviewId: 'specimen-review', roundOrdinal: 1, findingSeverity: input.severity,
    body: input.title,
    finding: { id: input.id, title: input.title, summary: input.title, severity: input.severity, category: 'correctness' },
    anchor: { kind: 'range', filePath: input.filePath, startLine: input.line, endLine: input.line },
    snapshot: { kind: 'text', selectedLines: input.selected, beforeContext: input.before, afterContext: input.after,
      selectedLinesHash: 'h', contextWindowHash: 'h', capturedAt: 1, fileLength: 200, source: 'committed', isUncommitted: false },
  });
}

/** Each finding's sealed excerpt, as the round's comments keep it when its Machine isn't shared (lab `detail-nomachine`). */
const NO_MACHINE_COMMENTS = [
  sealedExcerpt({ id: 'f1', title: 'Settings modal remounts on every tab switch', severity: 'blocker',
    filePath: 'components/settings/SettingsModal.tsx', line: 142, before: ['    <SettingsSheet'],
    selected: ['      key={`${route}-${activeTab}`}'], after: ['      tab={activeTab}'] }),
  sealedExcerpt({ id: 'f2', title: 'Unsaved draft is lost when the modal closes during save', severity: 'blocker',
    filePath: 'components/settings/useSettingsDraft.ts', line: 58, before: ['  if (closing) {'],
    selected: ['    setDraft(null);'], after: ['  }'] }),
];

/** The round's runs as the record keeps them: the Runs tab and its count read the same list. */
const SPECIMEN_RUNS_ROUND: ReviewArtifactV1['rounds'][number] = {
  ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: ['claude', 'codex', 'coderabbit'],
  runs: [
    { kind: 'execution', runId: 'run-claude', machineId: 'machine-1', sessionId: 'session-1' },
    { kind: 'execution', runId: 'run-codex', machineId: 'machine-1', sessionId: 'session-1' },
    { kind: 'workflow', runId: 'run-workflow' },
  ],
};

export function ReviewDetailSpecimen(
  props: Readonly<{ scene: string | null }>,
) {
  const scene = props.scene ?? 'findings';
  const [tab, setTab] = React.useState<ReviewDetailTabId>(
    scene === 'nomachine' ? 'changes' : scene === 'runs' ? 'runs' : 'findings',
  );
  const [openRowId, setOpenRowId] = React.useState<string | null>(
    scene === 'findings' ? 'f1' : null,
  );
  const [decisions, setDecisions] = React.useState<
    Readonly<Record<string, ReviewFindingDecision | 'undecided'>>
  >(() =>
    Object.fromEntries(
      FIXTURES.map((fixture) => [fixture.finding.id, fixture.decision]),
    ),
  );
  const [submitOpen, setSubmitOpen] = React.useState(scene === 'submit');
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string> | null>(null);
  const rounds = React.useMemo(
    () =>
      scene === 'round2'
        ? [roundOf(1, 'submitted'), roundOf(2, 'waiting', true)]
        : [roundOf(1, scene === 'newround' ? 'submitted' : 'waiting')],
    [scene],
  );
  const [selectedRound, setSelectedRound] = React.useState(
    rounds.at(-1)!.ordinal,
  );
  const openNewRound = React.useCallback(
    () =>
      showReviewNewRoundDialog({
        previousRound: 1,
        reviewers: [
          {
            id: 'claude',
            label: 'Claude · Opus 5.5',
            mark: agentMark('claude'),
            continuity: 'continues',
          },
          {
            id: 'codex',
            label: 'Codex · GPT-5.5',
            mark: agentMark('codex'),
            continuity: 'continues',
          },
          {
            id: 'session',
            label: 'Fix settings modal remount',
            mark: glyphMark('chat'),
            continuity: 'continues',
          },
          {
            id: 'coderabbit',
            label: 'CodeRabbit',
            mark: glyphMark('robot'),
            continuity: 'fresh',
          },
          {
            id: 'deepsec',
            label: 'DeepSec',
            mark: glyphMark('shield'),
            continuity: 'fresh',
          },
          {
            id: 'mika',
            label: 'Mika Tanaka',
            mark: personMark('mika', 'MT'),
            continuity: 'asked_again',
            required: true,
          },
          {
            id: 'you',
            label: t('reviewWalkthrough.detail.you'),
            mark: personMark('you', 'LB'),
            continuity: 'asked_again',
            required: true,
          },
        ],
        onStart: async () => ({ ok: true }),
      }),
    [],
  );
  React.useEffect(() => {
    if (scene === 'newround') openNewRound();
  }, [openNewRound, scene]);

  if (scene === 'summary') return <ReviewSummaryScene />;
  if (scene === 'loading') return <ReviewDetailState kind="loading" />;
  if (scene === 'failed')
    return <ReviewDetailState kind="failed" onRetry={() => undefined} />;

  const rows = FIXTURES.map((fixture) => ({
    rowId: fixture.finding.id,
    severity: fixture.finding.severity,
    decision: decisions[fixture.finding.id] ?? 'undecided',
  }));
  const pending = rows.filter((row) => row.decision === 'undecided').length;
  const accepted = rows.filter((row) => row.decision === 'accept').length;
  const byId = new Map(
    FIXTURES.map((fixture) => [fixture.finding.id, fixture] as const),
  );
  const waiting = scene !== 'newround' && !submitOpen;
  return (
    <ReviewDetailView
      title="Fix settings modal remount"
      meta={[
        { key: 'subject', text: 'This session', icon: 'chat' },
        { key: 'changes', text: '9 files, +118 −21' },
        { key: 'commit', text: '4f2a91c', mono: true },
        {
          key: 'round',
          text: `${t('reviewWalkthrough.detail.round', { round: rounds.at(-1)!.ordinal })} · 3 steps`,
        },
      ]}
      primaryAction={
        waiting
          ? {
              title: t('reviewWalkthrough.detail.submitReview'),
              onPress: () => setSubmitOpen(true),
            }
          : pending > 0 || accepted > 0
            ? {
                title: t('runPage.review.implementFixes', { count: accepted }),
                onPress: () => undefined,
              }
            : { title: t('reviewWalkthrough.detail.newRound'), onPress: openNewRound }
      }
      menu={[
        {
          id: 'new-round',
          title: t('reviewWalkthrough.detail.newRound'),
          onSelect: openNewRound,
        },
      ]}
      glance={{
        sentence: '2 blockers found',
        tone: 'attention',
        // Plan C: the counts live on the filter chips; the facts line carries verification only.
        facts: ['Verified 4 of 6 by the double-check'],
      }}
      notice={
        scene === 'round2' ? null : (
          <SurfaceStateCard
            kind="warning"
            size="line"
            title="CodeRabbit didn’t finish. Its rate limit was reached at 14:08; Claude and Codex covered every file."
            action={{ label: 'Retry CodeRabbit', onPress: () => undefined }}
          />
        )
      }
      rounds={rounds}
      selectedRound={selectedRound}
      onSelectRound={setSelectedRound}
      submit={
        submitOpen ? (
          <ReviewSubmitPanel
            roundOrdinal={selectedRound}
            caption="Your 2 decisions and 1 comment go with it"
            initialVerdict="request_changes"
            onCancel={() => setSubmitOpen(false)}
            onSubmit={async () => {
              setSubmitOpen(false);
              return { ok: true };
            }}
          />
        ) : null
      }
      tabs={[
        { id: 'findings', count: rows.length },
        { id: 'changes', count: 9 },
        { id: 'runs', count: SPECIMEN_RUNS_ROUND.runs.length },
        { id: 'activity' },
      ]}
      activeTab={tab}
      onSelectTab={setTab}
    >
      {tab === 'findings' ? (
        <ReviewFindingsList
          rows={rows}
          selection={{
            selectedRowIds: selectedIds ?? new Set(),
            active: selectedIds !== null,
            onStart: () => setSelectedIds(new Set()),
            onToggle: (id) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              }),
          }}
          renderRow={(rowId, divided, selection) => {
            const fixture = byId.get(rowId)!;
            return (
              <ReviewFindingRow
                rowId={rowId}
                finding={fixture.finding}
                attribution={{
                  label: fixture.reviewers
                    .map((reviewer) => reviewer.label)
                    .join(' and '),
                  backendIds: fixture.reviewers.map(
                    (reviewer) => reviewer.backendId,
                  ),
                }}
                reviewers={fixture.reviewers}
                original={null}
                density="page"
                divided={divided}
                decision={decisions[rowId] ?? 'undecided'}
                decisionDisabled={false}
                decisionNote={null}
                onDecide={(id, decision) =>
                  setDecisions((current) => ({ ...current, [id]: decision }))
                }
                followUp={FOLLOW_UP}
                threadEntries={[]}
                pendingQuestion={null}
                expanded={openRowId === rowId}
                onToggleExpanded={(id) =>
                  setOpenRowId((current) => (current === id ? null : id))
                }
                askContext={ASK_CONTEXT}
                onAsk={ask}
                selection={selection}
              />
            );
          }}
        />
      ) : tab === 'changes' ? (
        <ReviewChangesUnavailable
          reason={null}
          comments={NO_MACHINE_COMMENTS}
          onOpenComment={(id) => {
            setTab('findings');
            setOpenRowId(id);
          }}
        />
      ) : tab === 'runs' ? (
        <ReviewRoundRuns round={SPECIMEN_RUNS_ROUND} scope={null} />
      ) : (
        <View style={styles.placeholder} />
      )}
    </ReviewDetailView>
  );
}

const styles = StyleSheet.create((theme) => ({
  placeholder: { minHeight: theme.space.s48 },
  summaryPage: { flex: 1, padding: theme.space.s24, alignItems: 'center', backgroundColor: theme.colors.surface.base },
  summaryCard: {
    width: '100%', maxWidth: 680, padding: theme.space.s12, borderRadius: theme.space.s12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.default,
  },
}));

/** The shared summary as a Session transcript draws it (lab `session-card`), inside a plain card edge. */
function ReviewSummaryScene() {
  return (
    <View style={styles.summaryPage}>
      <View style={styles.summaryCard}>
        <ReviewSummary
          subject="this session"
          status={{ label: 'Needs decision', tone: 'quiet' }}
          glance={{ sentence: '2 blockers found', tone: 'attention', facts: [] }}
          rows={FIXTURES.slice(0, 2).map((fixture) => ({
            rowId: fixture.finding.id,
            severity: fixture.finding.severity,
            title: fixture.finding.title,
            reviewer: fixture.reviewers.map((reviewer) => reviewer.label).join(' and '),
            location: formatReviewFindingLocation(fixture.finding),
            decision: fixture.decision,
          }))}
          more={{ label: '4 more findings and 1 question · Show', onPress: () => undefined }}
          reviewers={[{ label: 'Claude', backendId: 'claude' }, { label: 'Codex', backendId: 'codex' }]}
          onOpenReview={() => undefined}
        />
      </View>
    </View>
  );
}
