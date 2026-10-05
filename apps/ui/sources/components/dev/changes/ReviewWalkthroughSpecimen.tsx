import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    projectReviewFindingsOverlay,
    type ReviewFinding,
    type ReviewFindingsOverlayReview,
    type ScmComparison,
    type ScmDiffSummaryWalkthrough,
} from '@happier-dev/protocol';

import { ScmComparisonBar, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { ScmComparisonPhoneHeader } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { listFilesComparisonScopeOptions } from '@/components/sessions/files/comparison/filesComparison';
import { WalkthroughNotice, WalkthroughNoticeButton } from '@/components/sessions/files/walkthrough/WalkthroughLifecycle';
import { WalkthroughView, type WalkthroughViewLayout } from '@/components/sessions/files/walkthrough/WalkthroughView';
import { buildWalkthroughReading, type WalkthroughReadingInput } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { ReviewFindingDecisionControl } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { useReviewSeverityColorResolver } from '@/components/sessions/reviews/findings/useReviewSeverityColors';
import { ReviewWalkthroughSteps, WalkthroughReviewExplanation } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts';
import { ReviewExplainFindingsButton } from '@/components/sessions/reviews/walkthrough/SessionWalkthroughReview';
import { StartReviewDialogView } from '@/components/sessions/reviews/walkthrough/StartReviewDialog';
import { buildWalkthroughReviewOverlay } from '@/components/sessions/reviews/walkthrough/reviewWalkthroughOverlay';
import { resolveReviewWalkthroughProgress } from '@/components/sessions/reviews/walkthrough/reviewWalkthroughProgress';
import { buildWalkthroughReviewSlots, type WalkthroughReviewSlotsInput } from '@/components/sessions/reviews/walkthrough/walkthroughReviewSlots';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { resolveReviewWalkthroughPlan, type ReviewWalkthroughEngine } from '@/sync/domains/reviews/reviewWalkthroughPlan';
import { t } from '@/text';

import { SPECIMEN_ANALYSIS_COMPLETE, SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH, specimenReviewedRefs } from './walkthroughSpecimenFixture';

/**
 * Dev-only: the review frames of the Walkthrough lab (WT5-R1 to R9) drawn through the real components at
 * static props: the Start review dialog, the two-step status, findings beside the stops, the tail, a
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
        onSelectView={noop} onBack={noop} onStartReview={noop} extraActions={props.trailing} />;
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
    const reading = React.useMemo(() => buildWalkthroughReading({
        comparison,
        walkthrough: props.scenario.walkthrough,
        analysis: props.input?.analysis ?? SPECIMEN_ANALYSIS_COMPLETE,
        reviewed: { v: 1, comparisonId: comparison.id, reviewedChangeRefs: props.scenario.walkthrough?.value?.stops.slice(0, props.scenario.reviewed ?? 2).flatMap((stop) => stop.changeRefs) ?? [] },
    }), [comparison, props.input?.analysis, props.scenario]);
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
        <WalkthroughNotice
            tone="danger"
            icon="x-circle"
            message={(
                <Text style={styles.notice}>
                    <Text style={styles.noticeStrong}>{t('reviewWalkthrough.partial.failed', { engines: 'Claude' })}</Text>
                    {` ${t('reviewWalkthrough.partial.notClean')} ${t('reviewWalkthrough.partial.finishedWith', { engines: 'Codex', count: 3 })}`}
                </Text>
            )}
            actions={<WalkthroughNoticeButton icon="arrows-clockwise" label={t('reviewWalkthrough.partial.retry', { engine: 'Claude' })} onPress={noop} />}
        />
    );
}

const PROPOSE = (
    <RoundButton size="small" display="inverted" title={t('scmComparison.proposeCommits')} leading={<Icon name="git-commit" size={ICON_SIZE.xs} />} onPress={noop} />
);

/* ── Start review dialog (R4, R4p, R7) ── */
const ENGINES: readonly ReviewWalkthroughEngine[] = [
    { engineId: 'claude', label: 'Claude Code', description: 'Opus 5.5', enabled: true, structuredNarration: true },
    { engineId: 'codex', label: 'Codex', description: 'GPT-6.1', enabled: true, structuredNarration: true },
    { engineId: 'coderabbit', label: 'CodeRabbit', description: 'Review CLI', enabled: true, structuredNarration: false },
];

function DialogFrame(props: Readonly<{ selected: readonly string[]; phone: boolean }>) {
    const [selected, setSelected] = React.useState(props.selected);
    const [walkthrough, setWalkthrough] = React.useState(true);
    const [narrator, setNarrator] = React.useState<string | null>(null);
    const [instructions, setInstructions] = React.useState('Focus on how the modal and the phone sheet are keyed.');
    const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, selectedEngineIds: selected, walkthrough, narratorEngineId: narrator });
    const dialog = (
        <StartReviewDialogView
            engines={ENGINES}
            selectedEngineIds={selected}
            onToggleEngine={(id) => setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))}
            scopeLabel={t('scmComparison.scope.session')}
            scopeDetail="start → now · 9 files · 14 changes"
            instructions={instructions}
            onChangeInstructions={setInstructions}
            walkthrough={walkthrough}
            onToggleWalkthrough={() => setWalkthrough((on) => !on)}
            narratorEngineId={narrator}
            onSelectNarrator={setNarrator}
            plan={plan}
            onCancel={noop}
            onStart={noop}
            phone={props.phone}
        />
    );
    return (
        <View style={styles.fill}>
            {props.phone ? null : <Bar trailing={PROPOSE} />}
            <View style={styles.scrim} />
            <View style={props.phone ? styles.sheet : styles.dialogCard}>{dialog}</View>
        </View>
    );
}

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

/* ── Finished review in the transcript (R8, R8b, R8p) ── */
function FinishedCard(props: Readonly<{ resumable: boolean; phone: boolean }>) {
    const source = React.useMemo(() => {
        const base = createReadOnlySessionTranscriptSource({ sessionId: 'specimen-session', messages: [], agentState: null, metadata: null, reducerState: null, workspacePath: '/repo' });
        return { ...base, navigate: noop };
    }, []);
    const payload = React.useMemo(() => ({
        runRef: { ...runRef('codex-run', 'codex'), retentionPolicy: props.resumable ? 'resumable' as const : 'ephemeral' as const },
        comparisonId: SPECIMEN_COMPARISON.id,
        summary: 'Claude and Codex reviewed the settings change: one real bug in the phone sheet, two things to tidy.',
        overviewMarkdown: 'Claude and Codex reviewed the settings change.',
        findings: [HIGH, DOCS, MEMO, TESTS, NIT],
        questions: [],
        assumptions: [],
        generatedAtMs: new Date(2026, 9, 3, 11, 4).getTime(),
    }), [props.resumable]);
    return (
        <SessionTranscriptSourceProvider source={source}>
            <View style={props.phone ? styles.transcriptPhone : styles.transcript}>
                <View style={styles.userBubble}><Text style={styles.userText}>Review what you changed before I commit.</Text></View>
                <ReviewFindingsMessageCard payload={payload} sessionId="specimen-session" canSendMessages />
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
    { id: 'R4', title: 'WT5-R4 · Start review with a walkthrough', render: (phone) => <DialogFrame selected={['claude', 'codex']} phone={phone} /> },
    { id: 'R7', title: 'WT5-R7 · a findings-only CLI engine', render: (phone) => <DialogFrame selected={['coderabbit']} phone={phone} /> },
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
    { id: 'R9', title: 'WT5-R9 · continue versus narrate', render: () => <AfterBoard /> },
];

const styles = StyleSheet.create((theme) => ({
    fill: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.text.primary, opacity: 0.18 },
    dialogCard: {
        position: 'absolute',
        top: 72,
        bottom: 24,
        maxHeight: '90%',
        alignSelf: 'center',
        width: 520,
        borderRadius: 16,
        backgroundColor: theme.colors.surface.elevated,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    sheet: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: '90%',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        backgroundColor: theme.colors.surface.elevated,
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 24, padding: 24 },
    cell: { width: 640, gap: 8 },
    cellCaption: { fontSize: 12, color: theme.colors.text.secondary, ...Typography.default('semiBold') },
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
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 18,
        backgroundColor: theme.colors.surface.base,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    notice: { fontSize: 13.5, lineHeight: 19, color: theme.colors.text.secondary, ...Typography.default() },
    noticeStrong: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
    transcript: { width: 640, alignSelf: 'center', paddingVertical: 24, gap: 14 },
    transcriptPhone: { width: '100%', paddingHorizontal: 16, paddingVertical: 20, gap: 14 },
    userBubble: { alignSelf: 'flex-end', maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, backgroundColor: theme.colors.surface.inset },
    userText: { fontSize: 15, color: theme.colors.text.primary, ...Typography.default() },
}));
