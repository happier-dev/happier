import * as React from 'react';
import { applyScmReviewedMarkIntent } from '@happier-dev/protocol/scm';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { projectReviewFindingsOverlay, type ReviewFindingsOverlayReview } from '@happier-dev/protocol/reviews/projectReviewFindingsOverlay';
import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm/diffSummary';

import { ScmComparisonBar, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { ScmComparisonPhoneHeader } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { listFilesComparisonScopeOptions } from '@/components/sessions/files/comparison/filesComparison';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { WalkthroughView, type WalkthroughViewLayout } from '@/components/sessions/files/walkthrough/WalkthroughView';
import type { WalkthroughReadingInput } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { useWalkthroughReading } from '@/components/sessions/files/walkthrough/useWalkthroughReading';
import { ReviewFindingDecisionControl } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import { PlanOutputMessageCard } from '@/components/sessions/plans/messages/PlanOutputMessageCard';
import { DelegateOutputMessageCard } from '@/components/sessions/delegations/messages/DelegateOutputMessageCard';
import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { useReviewSeverityColorResolver } from '@/components/sessions/reviews/findings/useReviewSeverityColors';
import { ReviewWalkthroughSteps, WalkthroughReviewExplanation } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts';
import { ReviewExplainFindingsButton } from '@/components/sessions/reviews/walkthrough/SessionWalkthroughReview';
import { buildWalkthroughReviewOverlay } from '@/components/sessions/reviews/walkthrough/reviewWalkthroughOverlay';
import { resolveReviewWalkthroughProgress } from '@/components/sessions/reviews/walkthrough/reviewWalkthroughProgress';
import { buildWalkthroughReviewSlots, type WalkthroughReviewSlotsInput } from '@/components/sessions/reviews/walkthrough/walkthroughReviewSlots';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { SPECIMEN_ANALYSIS_COMPLETE, SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH, specimenReviewedRefs } from './walkthroughSpecimenFixture';

/**
 * Dev-only: the review frames of the Walkthrough lab (WT5-R1 to R9) drawn through the real components at
 * static props: the two-step status, findings beside the stops, the tail, a
 * partial review and the finished-review card. The data is the lab's illustration, not product logic.
 */
const noop = () => {};
const AVAILABILITY = { showTurnViewToggle: true, showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: true };
const SCOPE_OPTIONS = listFilesComparisonScopeOptions(AVAILABILITY, 'turn-3', null, { pendingFileCount: 9, sessionFileCount: 9, latestTurnFileCount: 4 });
const SESSION = { kind: 'session' } as const;
const DETAIL = `${t('scmComparison.since', { time: '09:40' })} · ${t('scmComparison.turnsWithChanges', { count: 3 })}`;

const SHEET = 'apps/ui/sources/components/settings/SettingsSheet.tsx';
const KEY = 'apps/ui/sources/components/settings/useSettingsRouteKey.ts';
const TEST = 'apps/ui/sources/components/settings/SettingsModal.test.tsx';

const finding = (id: string, severity: ReviewFinding['severity'], category: ReviewFinding['category'], title: string, summary: string, place?: Readonly<{ filePath: string; line: number }>): ReviewFinding => ({
    id, title, severity, category, summary, ...(place ? { filePath: place.filePath, startLine: place.line, endLine: place.line } : {}),
});
const HIGH = finding('sheet-remount', 'high', 'correctness', 'The sheet no longer remounts when the route kind changes from search to section',
    'Opening a section from search reuses the same `Sheet`, so its scroll stays at the search results’ offset.', { filePath: SHEET, line: 11 });
const MEMO = finding('memo-route', 'medium', 'performance', 'useSettingsRouteKey memoizes on the whole route',
    'The memo depends on the route object, which is new on every navigation, so the key is recomputed each time.', { filePath: KEY, line: 9 });
const DOCS = finding('migration-notes', 'medium', 'docs', 'Route kind change isn’t in the migration notes',
    'Plugins that build `SettingsRoute` objects will fail type-checks.');
const TESTS = finding('phone-test', 'low', 'testing', 'No test covers the phone sheet',
    'The new test resizes the modal; nothing exercises the sheet on a phone.', { filePath: TEST, line: 60 });
const NIT = finding('named-constant', 'nit', 'style', 'Prefer a named constant for 1280 in the test',
    'A named width says why the test resizes there.', { filePath: TEST, line: 65 });

const runRef = (runId: string, backendId: string) => ({ runId, callId: `${runId}-call`, backendId });
const afterAnchors = (findings: readonly ReviewFinding[]) => Object.fromEntries(findings.filter((item) => item.filePath && item.startLine)
    .map((item) => [item.id, { kind: 'line' as const, filePath: item.filePath!, line: item.startLine!, side: 'after' as const }]));
function review(runId: string, backendId: string, findings: readonly ReviewFinding[], extra: Partial<ReviewFindingsOverlayReview> = {}): ReviewFindingsOverlayReview {
    return { runRef: runRef(runId, backendId), comparisonId: SPECIMEN_COMPARISON.id, findings, status: 'succeeded', hasOutput: true, anchorsByFindingId: afterAnchors(findings), ...extra };
}
const LABELS = { 'codex-run': 'Codex', 'claude-run': 'Claude', 'codex-old-run': 'Codex', 'rabbit-run': 'CodeRabbit' };

/** Stops that name the findings their prose touches (lab WT5-R6). */
const WITH_FINDINGS: ScmDiffSummaryWalkthrough = {
    ...SPECIMEN_WALKTHROUGH,
    stops: SPECIMEN_WALKTHROUGH.stops.map((stop) => {
        // The narrator cites a finding where its sentence names it: `[text](finding:<runId>:<findingId>)`.
        if (stop.id === 'sheet') return { ...stop, explanationMarkdown: `${stop.explanationMarkdown.replace('It now calls the same hook.', 'It now calls the same hook, which leaves one case open: going from search to a section reuses the sheet [the high finding](finding:codex-run:sheet-remount).')}`, findingRefs: ['codex-run:sheet-remount'] };
        if (stop.id === 'key') return { ...stop, explanationMarkdown: 'A small hook turns a route into a key that only changes when the destination does. Claude asks whether it should memoize on the whole route [memo](finding:claude-run:memo-route); Codex disagrees in its reply.', findingRefs: ['claude-run:memo-route'] };
        return stop;
    }),
};

type Scenario = Readonly<{
    reviews: readonly ReviewFindingsOverlayReview[];
    walkthrough: WalkthroughReadingInput['walkthrough'];
    reviewed?: number;
}>;

function overlayOf(scenario: Scenario, comparison: ScmComparison = SPECIMEN_COMPARISON) {
    const value = scenario.walkthrough?.value ?? null;
    return buildWalkthroughReviewOverlay({
        overlay: projectReviewFindingsOverlay({ comparison, walkthrough: value, reviews: scenario.reviews }),
        stops: value?.stops ?? [],
        reviewerLabelByRunId: LABELS,
    });
}

function triage(decision: 'accept' | 'undecided' = 'undecided') {
    return <ReviewFindingDecisionControl testIDPrefix="specimen-triage" decision={decision} disabled={false} onDecide={noop} />;
}

function Bar(props: Readonly<{ trailing: React.ReactNode; phone?: boolean }>) {
    if (props.phone) return <ScmComparisonPhoneHeader view="walkthrough" views={['files', 'walkthrough']}
        scope={{ options: SCOPE_OPTIONS, current: SESSION, currentLabel: t('scmComparison.scope.session'), fileCount: 9, onSelect: noop }}
        onSelectView={noop} onStartReview={noop} extraActions={props.trailing} />;
    return (
        <ScmComparisonBar
            leading={(
                <>
                    <ScmComparisonViewSwitch view="walkthrough" views={['files', 'walkthrough']} onSelect={noop} />
                    <ScmComparisonScopePicker options={SCOPE_OPTIONS} current={SESSION} currentLabel={t('scmComparison.scope.session')} fileCount={9} onSelect={noop} />
                </>
            )}
            trailing={props.trailing}
        />
    );
}

function ReviewReading(props: Readonly<{
    scenario: Scenario;
    layout: WalkthroughViewLayout;
    bar?: React.ReactNode;
    slots?: Partial<WalkthroughReviewSlotsInput>;
    modelLabel?: string;
    generatedLabel?: string;
    initialStopId?: string;
    phoneSteps?: React.ReactNode;
    input?: Omit<WalkthroughReadingInput, 'walkthrough' | 'reviewed'>;
    scopeLabel?: string;
    scopeDetail?: string;
}>) {
    const phone = props.layout === 'phone';
    const comparison = props.input?.comparison ?? SPECIMEN_COMPARISON;
    const reading = useWalkthroughReading({
        comparison,
        walkthrough: props.scenario.walkthrough,
        analysis: props.input?.analysis ?? SPECIMEN_ANALYSIS_COMPLETE,
        reviewed: applyScmReviewedMarkIntent(comparison, null, props.scenario.walkthrough?.value?.stops.slice(0, props.scenario.reviewed ?? 2).flatMap((stop) => stop.changeRefs) ?? [], true),
    });
    const overlay = React.useMemo(() => overlayOf(props.scenario, comparison), [props.scenario, comparison]);
    const severityColors = useReviewSeverityColorResolver();
    const slots = buildWalkthroughReviewSlots({ overlay, phone, renderTriage: () => triage(), onAskStop: noop, showKeys: !phone, severityColors, ...props.slots });
    return (
        <View style={styles.fill}>
            {phone && !props.scopeLabel ? (React.isValidElement<{ phone?: boolean }>(props.bar)
                ? React.cloneElement(props.bar, { phone: true }) : <Bar phone trailing={null} />) : props.bar}
            <WalkthroughView
                layout={props.layout}
                reading={reading}
                scopeLabel={props.scopeLabel ?? t('scmComparison.scope.session')}
                scopeDetail={props.scopeDetail ?? (props.scopeLabel ? undefined : DETAIL)}
                modelLabel={props.modelLabel ?? 'Opus 5.5'}
                generatedLabel={props.generatedLabel}
                // Phones step to the frame's stop with the bar's Next (the lab's 3 of 5), so they start one before it.
                initialStopId={phone ? 'key' : props.initialStopId ?? 'sheet'}
                onToggleReviewed={noop}
                onAsk={noop}
                onOpenFile={noop}
                review={slots}
            />
            {phone && props.phoneSteps ? <View style={styles.phoneSteps}>{props.phoneSteps}</View> : null}
        </View>
    );
}

const COMPLETE: WalkthroughReadingInput['walkthrough'] = { state: 'complete', value: SPECIMEN_WALKTHROUGH };
const COMPLETE_WITH_FINDINGS: WalkthroughReadingInput['walkthrough'] = { state: 'complete', value: WITH_FINDINGS };

const R1: Scenario = {
    walkthrough: COMPLETE,
    reviews: [review('codex-run', 'codex', [HIGH, TESTS]), review('claude-run', 'claude', [MEMO], { status: 'running', hasOutput: false, findings: [] })],
};

/** PR context uses the same real finding projection and reading slots as the review frames. */
export function PullRequestReviewReading(props: Readonly<{
    input: Omit<WalkthroughReadingInput, 'reviewed'>; phone: boolean; bar: React.ReactNode;
    scopeLabel: string; scopeDetail?: string;
}>) {
    const scenario = React.useMemo<Scenario>(() => ({ walkthrough: props.input.walkthrough,
        reviews: R1.reviews.map((review) => ({ ...review, comparisonId: props.input.comparison.id })) }), [props.input]);
    return <ReviewReading scenario={scenario} input={props.input} layout={props.phone ? 'phone' : 'wide'} bar={props.bar}
        scopeLabel={props.scopeLabel} scopeDetail={props.scopeDetail} />;
}
const R2: Scenario = { walkthrough: COMPLETE, reviews: [review('codex-run', 'codex', [HIGH, TESTS]), review('claude-run', 'claude', [MEMO])] };
const R3: Scenario = {
    walkthrough: COMPLETE,
    reviews: [
        review('codex-run', 'codex', [HIGH, DOCS]),
        review('codex-old-run', 'codex', [NIT], { comparisonId: 'before-the-last-turn' }),
        review('claude-run', 'claude', [], { status: 'failed', hasOutput: false }),
    ],
};
const R2_EXPLANATIONS: ReadonlyMap<string, React.ReactNode> = new Map([[ 'sheet', (
    <WalkthroughReviewExplanation
        model="Opus 5.5"
        askedAt="11:06"
        markdown={'Codex’s high finding is real but narrow: the key now ignores *size*, as intended, and also ignores the jump from search to a section, because both resolve through `route.kind` only after the sheet mounts. The fix is one line in stop 2’s hook (include `route.kind` in the key for search routes), not a change to the sheet.'}
    />
)]]);
const R6: Scenario = { walkthrough: COMPLETE_WITH_FINDINGS, reviews: [review('codex-run', 'codex', [HIGH, DOCS, NIT]), review('claude-run', 'claude', [MEMO, TESTS])] };

function steps(scenario: Scenario, narration: Parameters<typeof resolveReviewWalkthroughProgress>[0]['narration'], extra: Partial<Parameters<typeof resolveReviewWalkthroughProgress>[0]> = {}, phone = false) {
    return <ReviewWalkthroughSteps phone={phone} progress={resolveReviewWalkthroughProgress({ review: overlayOf(scenario).summary, narration, ...extra })} />;
}

function PartialNotice() {
    return (
        <AttentionBanner
            presentation="strip"
            testID="specimen-partial-review"
            tone="danger"
            title={t('reviewWalkthrough.partial.failed', { engines: 'Claude' })}
            description={`${t('reviewWalkthrough.partial.notClean')} ${t('reviewWalkthrough.partial.finishedWith', { engines: 'Codex', count: 3 })}`}
            action={{ icon: 'arrows-clockwise', label: t('reviewWalkthrough.partial.retry', { engine: 'Claude' }), onPress: noop }}
        />
    );
}

const PROPOSE = (
    <RoundButton size="small" display="inverted" title={t('scmComparison.proposeCommits')} leading={<Icon name="git-commit" size={ICON_SIZE.xs} />} onPress={noop} />
);

/* ── Progress storyboard (R5) and both after-the-fact paths (R9) ── */
function Cell(props: Readonly<{ caption: string; children: React.ReactNode }>) {
    return (
        <View style={styles.cell}>
            <Text style={styles.cellCaption}>{props.caption}</Text>
            <View style={styles.cellFrame}>{props.children}</View>
        </View>
    );
}

const R5_REVIEWING: Scenario = { walkthrough: { state: 'pending' }, reviews: [review('claude-run', 'claude', [], { status: 'running', hasOutput: false }), review('codex-run', 'codex', [], { status: 'running', hasOutput: false })] };
const R5_FIRST: Scenario = { walkthrough: { state: 'writing', value: { ...WITH_FINDINGS, stops: [], otherChangeRefs: [] } }, reviews: R6.reviews };
const R5_CLI: Scenario = { walkthrough: { state: 'writing', value: { ...WITH_FINDINGS, stops: [], otherChangeRefs: [] } }, reviews: [review('rabbit-run', 'coderabbit', [HIGH, DOCS, MEMO])] };

function ProgressBoard() {
    return (
        <ScrollView contentContainerStyle={styles.grid}>
            <Cell caption="WT5-R5 1 · Reviewing">
                <ReviewReading scenario={R5_REVIEWING} layout="narrow" bar={<Bar trailing={steps(R5_REVIEWING, { state: 'pending', mode: 'continued_review', narratorLabel: 'Claude' })} />} slots={{ writing: true }} />
            </Cell>
            <Cell caption="WT5-R5 2 · Findings first">
                <ReviewReading scenario={R5_FIRST} layout="narrow" bar={<Bar trailing={steps(R5_FIRST, { state: 'writing', mode: 'continued_review', narratorLabel: 'Claude' })} />} slots={{ writing: true, findingsFirst: { publishedAt: '11:04' } }} />
            </Cell>
            <Cell caption="WT5-R5 3 · Ready">
                <ReviewReading scenario={R6} layout="narrow" bar={<Bar trailing={steps(R6, { state: 'complete', mode: 'continued_review', narratorLabel: 'Claude' })} />} />
            </Cell>
            <Cell caption="WT5-R5 4 · A CLI engine">
                <ReviewReading scenario={R5_CLI} layout="narrow" modelLabel="Claude" generatedLabel={t('reviewWalkthrough.generated.handover', { narrator: 'Claude', engine: 'CodeRabbit' })}
                    bar={<Bar trailing={steps(R5_CLI, { state: 'writing', mode: 'continued_review', narratorLabel: 'Claude', findingsOnlyReviewer: true })} />}
                    slots={{ writing: true, findingsFirst: { publishedAt: '11:12', engineLabel: 'CodeRabbit' } }} />
            </Cell>
        </ScrollView>
    );
}

function AfterBoard() {
    const ready: Scenario = { walkthrough: { state: 'writing', value: { ...WITH_FINDINGS, stops: WITH_FINDINGS.stops.slice(2, 3) } }, reviews: R6.reviews };
    return (
        <ScrollView contentContainerStyle={styles.grid}>
            <Cell caption="WT5-R9 A · The review run can continue">
                <ReviewReading scenario={ready} layout="narrow" generatedLabel={t('reviewWalkthrough.generated.continues', { model: 'Opus 5.5' })}
                    bar={<Bar trailing={steps(ready, { state: 'writing', mode: 'continued_review', narratorLabel: 'Opus 5.5' }, { reviewedAt: '11:04' })} />}
                    slots={{ factVariant: { kind: 'in_context' } }} />
            </Cell>
            <Cell caption="WT5-R9 B · The review run has ended">
                <ReviewReading scenario={{ ...ready, walkthrough: { state: 'writing', value: { ...WITH_FINDINGS, stops: [] } } }} layout="narrow"
                    modelLabel="Sonnet 5" generatedLabel={t('reviewWalkthrough.generated.seeded', { model: 'Sonnet 5' })}
                    bar={<Bar trailing={steps(ready, { state: 'writing', mode: 'seeded_narrator', narratorLabel: 'Sonnet 5' }, { reviewedAt: '11:04' })} />}
                    slots={{ factVariant: { kind: 'from_review', at: '11:04' }, seededNote: { reviewers: 'Claude and Codex', at: '11:04', changedFiles: 1 } }} />
            </Cell>
        </ScrollView>
    );
}

/** A heavy review for judging density: long titles, deep paths, every severity, a dozen findings. */
const HEAVY_FINDINGS: readonly ReviewFinding[] = [
    HIGH,
    finding('token-refresh-race', 'high', 'correctness', 'Two windows refreshing the session token at once can sign the second request with a token the server already revoked',
        'Both windows read the expiring token, both refresh, and the slower one stores a revoked token.', { filePath: 'apps/ui/sources/sync/engine/auth/refreshAccountSessionTokenWithRetry.ts', line: 142 }),
    DOCS, MEMO,
    finding('modal-focus-trap', 'medium', 'maintainability', 'Focus escapes the settings modal into the sidebar when the last section is collapsed',
        'Tab from the last disclosure lands on the sidebar behind the scrim.', { filePath: 'apps/ui/sources/components/settings/shell/SettingsModalFocusScope.tsx', line: 58 }),
    finding('i18n-plural', 'medium', 'correctness', 'The section count uses a hand-built plural instead of the translation plural form',
        'Languages with more than two plural forms read wrong.', { filePath: 'apps/ui/sources/text/translations/settingsTranslations.shared.ts', line: 311 }),
    TESTS,
    finding('resize-observer', 'low', 'performance', 'The resize observer stays attached after the modal closes',
        'It keeps a reference to the closed modal until the next resize.', { filePath: 'apps/ui/sources/components/ui/modal/useModalLayout.ts', line: 27 }),
    finding('story-coverage', 'low', 'testing', 'The narrow-window story is missing from the component board',
        'Reviewers cannot see the compact layout without resizing.'),
    NIT,
    finding('import-order', 'nit', 'style', 'Import order in settingsRoutes.ts differs from the rest of the folder', 'Sorted imports keep diffs small.', { filePath: 'apps/ui/sources/components/settings/settingsRoutes.ts', line: 1 }),
    finding('comment-typo', 'nit', 'style', 'Typo in a comment: “remouting”', 'Remounting.', { filePath: 'apps/ui/sources/components/settings/SettingsModal.tsx', line: 88 }),
];

/* ── Finished review in the transcript (R8, R8b, R8p) ── */
function FinishedCard(props: Readonly<{ resumable: boolean; phone: boolean; heavy?: boolean }>) {
    const source = React.useMemo(() => {
        const base = createReadOnlySessionTranscriptSource({ sessionId: 'specimen-session', messages: [], agentState: null, metadata: null, reducerState: null, workspacePath: '/repo' });
        return { ...base, navigate: noop };
    }, []);
    const payload = React.useMemo(() => ({
        runRef: { ...runRef('codex-run', 'codex'), retentionPolicy: props.resumable ? 'resumable' as const : 'ephemeral' as const },
        comparisonId: SPECIMEN_COMPARISON.id,
        summary: 'Claude and Codex reviewed the settings change: one real bug in the phone sheet, two things to tidy.',
        overviewMarkdown: 'Claude and Codex reviewed the settings change.',
        findings: props.heavy ? [...HEAVY_FINDINGS] : [HIGH, DOCS, MEMO, TESTS, NIT],
        questions: [],
        assumptions: [],
        generatedAtMs: new Date(2026, 9, 3, 11, 4).getTime(),
    }), [props.heavy, props.resumable]);
    return (
        <SessionTranscriptSourceProvider source={source}>
            <View style={props.phone ? styles.transcriptPhone : styles.transcript}>
                <View style={styles.userBubble}><Text style={styles.userText}>Review what you changed before I commit.</Text></View>
                <ReviewFindingsMessageCard payload={payload} sessionId="specimen-session" canSendMessages />
            </View>
        </SessionTranscriptSourceProvider>
    );
}

/* ── The other transcript Run results that share the result card (consumer check for its owner) ── */
function OtherRunResults(props: Readonly<{ phone: boolean }>) {
    const source = React.useMemo(() => ({ ...createReadOnlySessionTranscriptSource({ sessionId: 'specimen-session', messages: [], agentState: null, metadata: null, reducerState: null, workspacePath: '/repo' }), navigate: noop }), []);
    const plan = React.useMemo(() => ({
        runRef: runRef('plan-run', 'claude'),
        summary: 'Key the settings modal by route so a resize never remounts it, then prove it with a resize test.',
        sections: [
            { title: 'Change', items: ['Add useSettingsRouteKey and use it in the modal and the phone sheet.', 'Pass the compact layout as a prop instead of reading the window width.'] },
            { title: 'Prove', items: ['Resize twice in a component test and keep the draft.'] },
        ],
        risks: ['Plugins that build SettingsRoute objects need the new route kind.'],
        generatedAtMs: new Date(2026, 9, 3, 10, 12).getTime(),
    }), []);
    const delegation = React.useMemo(() => ({
        runRef: runRef('delegate-run', 'codex'),
        summary: 'Audited every caller of the old window-size key; two remain in tests only.',
        deliverables: [
            { id: 'callers', title: 'Callers of the size key', details: 'SettingsModal.tsx and SettingsSheet.tsx; both now use the route key.' },
            { id: 'tests', title: 'Tests still keyed by size', details: 'SettingsModal.test.tsx:65 and :88.' },
        ],
        generatedAtMs: new Date(2026, 9, 3, 10, 12).getTime(),
    }), []);
    return (
        <SessionTranscriptSourceProvider source={source}>
            <View style={props.phone ? styles.transcriptPhone : styles.transcript}>
                <PlanOutputMessageCard payload={plan} sessionId="specimen-session" canSendMessages />
                <DelegateOutputMessageCard payload={delegation} />
            </View>
        </SessionTranscriptSourceProvider>
    );
}

export type ReviewWalkthroughSpecimenFrame = Readonly<{ id: string; title: string; render: (phone: boolean) => React.ReactElement }>;

export const REVIEW_WALKTHROUGH_SPECIMEN_FRAMES: readonly ReviewWalkthroughSpecimenFrame[] = [
    {
        id: 'R1', title: 'WT5-R1 · findings beside the stops',
        render: (phone) => (
            <ReviewReading scenario={R1} layout={phone ? 'phone' : 'wide'}
                bar={<Bar trailing={<><ReviewExplainFindingsButton running={false} onPress={noop} />{steps(R1, null)}{PROPOSE}</>} />} />
        ),
    },
    {
        id: 'R2', title: 'WT5-R2 · Explain the findings, on request',
        render: (phone) => (
            <ReviewReading scenario={R2} layout={phone ? 'phone' : 'wide'}
                bar={<Bar trailing={<><ReviewExplainFindingsButton running onPress={noop} />{steps(R2, null)}{PROPOSE}</>} />}
                slots={{ explanationsByStopId: R2_EXPLANATIONS }} />
        ),
    },
    {
        id: 'R3', title: 'WT5-R3 · partial review and the tail',
        render: (phone) => (
            <ReviewReading scenario={R3} layout={phone ? 'phone' : 'wide'} initialStopId="sheet"
                bar={<Bar trailing={<>{steps(R3, null)}{PROPOSE}</>} />} slots={{ notice: <PartialNotice /> }} />
        ),
    },
    {
        id: 'R5', title: 'WT5-R5 · Reviewing, then writing',
        render: (phone) => phone
            ? <ReviewReading scenario={R5_FIRST} layout="phone" slots={{ writing: true, findingsFirst: { publishedAt: '11:04' } }}
                phoneSteps={steps(R5_FIRST, { state: 'writing', mode: 'continued_review', narratorLabel: 'Claude' }, {}, true)} />
            : <ProgressBoard />,
    },
    {
        id: 'R6', title: 'WT5-R6 · stops reference findings',
        render: (phone) => (
            <ReviewReading scenario={R6} layout={phone ? 'phone' : 'wide'} initialStopId="key"
                bar={<Bar trailing={<>{steps(R6, { state: 'complete', mode: 'continued_review', narratorLabel: 'Opus 5.5' })}{PROPOSE}</>} />} />
        ),
    },
    { id: 'R8', title: 'WT5-R8 · finished review, the run can continue', render: (phone) => <FinishedCard resumable phone={phone} /> },
    { id: 'R8b', title: 'WT5-R8 · finished review, the run has ended', render: (phone) => <FinishedCard resumable={false} phone={phone} /> },
    { id: 'R8h', title: 'WT5-R8 · finished review, heavy (12 findings, long titles)', render: (phone) => <FinishedCard resumable phone={phone} heavy /> },
    { id: 'R9', title: 'WT5-R9 · continue versus narrate', render: () => <AfterBoard /> },
    { id: 'RX', title: 'Run result card consumers · plan and delegation', render: (phone) => <OtherRunResults phone={phone} /> },
];

const styles = StyleSheet.create((theme) => ({
    fill: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s24, padding: theme.space.s24 },
    cell: { width: 640, gap: theme.space.s8 },
    cellCaption: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary,  },
    cellFrame: {
        height: 520,
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    phoneSteps: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s10,
        paddingBottom: 18,
        backgroundColor: theme.colors.surface.base,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    transcript: { width: 640, alignSelf: 'center', paddingVertical: theme.space.s24, gap: 14 },
    transcriptPhone: { width: '100%', paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s20, gap: 14 },
    userBubble: { alignSelf: 'flex-end', maxWidth: '80%', paddingHorizontal: 14, paddingVertical: theme.space.s10, borderRadius: 16, backgroundColor: theme.colors.surface.inset },
    userText: { fontSize: 15, color: theme.colors.text.primary, ...Typography.default() },
}));
