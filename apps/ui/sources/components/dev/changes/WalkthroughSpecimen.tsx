import * as React from 'react';
import { applyScmReviewedMarkIntent } from '@happier-dev/protocol/scm';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ScmComparisonBar, ScmComparisonProposeCommits, ScmComparisonStartReview, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { ScmComparisonPhoneHeader } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { listFilesComparisonScopeOptions, resolveFilesComparisonLabel } from '@/components/sessions/files/comparison/filesComparison';
import { WalkthroughContents } from '@/components/sessions/files/walkthrough/WalkthroughContents';
import { WalkthroughView, type WalkthroughViewLayout, type WalkthroughViewProps } from '@/components/sessions/files/walkthrough/WalkthroughView';
import { SCM_DIFF_SUMMARY_ENDED_PARTWAY_FAILURE, type ScmDiffSummaryFailurePresentation } from '@/sync/domains/scm/diffSummary/state';
import { ScmDiffSummaryStartOptions } from '@/components/sessions/files/comparison/ScmDiffSummaryStartOptions';
import { buildWalkthroughReading, EMPTY_WALKTHROUGH_READING, type WalkthroughReadingInput } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { useWalkthroughReading } from '@/components/sessions/files/walkthrough/useWalkthroughReading';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ChangedFilesReviewFindButton } from '@/components/workspaces/scm/review/ChangedFilesReviewFind';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import {
    SPECIMEN_ANALYSIS_COMPLETE,
    SPECIMEN_ANALYSIS_EARLY,
    SPECIMEN_ANALYSIS_MOST,
    SPECIMEN_ANALYSIS_STOPPED,
    SPECIMEN_COMPARISON,
    SPECIMEN_START_FAILURES,
    SPECIMEN_WALKTHROUGH,
    SPECIMEN_WALKTHROUGH_MERGED,
    specimenReviewedRefs,
} from './walkthroughSpecimenFixture';

/**
 * Dev-only: the Walkthrough view (lab WT1, WT2, WT3-D2) drawn through the real components at static
 * props. Marks toggle locally here; in the product they are the person's Account KV record.
 */
const noop = () => {};
const AVAILABILITY = { showTurnViewToggle: true, showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: true };
const SCOPE_OPTIONS = listFilesComparisonScopeOptions(AVAILABILITY, 'turn-3', null, { pendingFileCount: 9, sessionFileCount: 9, latestTurnFileCount: 4 });
const SESSION = { kind: 'session' } as const;
const DETAIL = `${t('scmComparison.since', { time: '09:40' })} · ${t('scmComparison.turnsWithChanges', { count: 3 })}`;

function reviewed(count: number): WalkthroughReadingInput['reviewed'] {
    return applyScmReviewedMarkIntent(SPECIMEN_COMPARISON, null, specimenReviewedRefs(count), true);
}

const PENDING = { kind: 'workingTree' } as const;

function SpecimenBar(props: Readonly<{ view: 'files' | 'walkthrough'; phone?: boolean; offline?: boolean; pending?: boolean; findSurfaceId?: string }>) {
    const reason = props.offline ? t('walkthrough.notice.offlineA11y') : null;
    const findRuntime = useFindSurfaceRuntime();
    const findId = props.findSurfaceId;
    const find = findId ? <ChangedFilesReviewFindButton surfaceId={findId} /> : null;
    const findSections = findId ? [{ id: 'find', items: [{ id: 'open', testID: 'scm-review-find', title: t('find.surface.changes'),
        icon: <Icon name="magnifying-glass" size={ICON_SIZE.sm} /> }], onSelect: () => { findRuntime.open(findId); } }] : undefined;
    if (props.pending && !props.phone) return (
        <ScmComparisonBar
            leading={(
                <>
                    <ScmComparisonViewSwitch view={props.view} views={['files', 'walkthrough', 'commits']} onSelect={noop} />
                    <ScmComparisonScopePicker options={SCOPE_OPTIONS} current={PENDING} currentLabel={resolveFilesComparisonLabel(PENDING, null)} fileCount={9} onSelect={noop} />
                </>
            )}
            trailing={<>{find}<ScmComparisonStartReview onPress={noop} /><ScmComparisonProposeCommits onPress={noop} /></>}
        />
    );
    if (props.phone) return <ScmComparisonPhoneHeader view={props.view} views={['files', 'walkthrough']}
        scope={{ options: SCOPE_OPTIONS, current: SESSION, currentLabel: t('scmComparison.scope.session'), fileCount: 9, onSelect: noop }}
        onSelectView={noop} onStartReview={noop} reviewDisabled={props.offline} reviewDisabledReason={reason} sections={findSections} />;
    return (
        <ScmComparisonBar
            leading={(
                <>
                    <ScmComparisonViewSwitch view={props.view} views={['files', 'walkthrough']} onSelect={noop} />
                    <ScmComparisonScopePicker options={SCOPE_OPTIONS} current={SESSION} currentLabel={t('scmComparison.scope.session')} fileCount={9} onSelect={noop} />
                </>
            )}
            trailing={<>{find}<ScmComparisonStartReview onPress={noop} disabled={props.offline} disabledReason={reason} /></>}
        />
    );
}

/** A frame whose marks toggle in place, so the signature mark moment can be seen. */
function LiveMarks(props: Readonly<{
    input: Omit<WalkthroughReadingInput, 'reviewed'>;
    reviewedCount: number;
    view: Omit<WalkthroughViewProps, 'reading' | 'onToggleReviewed'>;
    bar?: boolean;
    pending?: boolean;
}>) {
    const [refs, setRefs] = React.useState(() => specimenReviewedRefs(props.reviewedCount));
    const findSurfaceId = `specimen-walkthrough:${React.useId()}`;
    const marks = React.useMemo(() => applyScmReviewedMarkIntent(SPECIMEN_COMPARISON, null, refs, true), [refs]);
    const reading = useWalkthroughReading({
        ...props.input,
        reviewed: marks,
    });
    // The pane owner supplies focus eligibility in the product; this frame stands in for it so Find can open.
    return (
        <PluginSurfaceFocusEligibilityProvider active>
        <View style={styles.fill}>
            {props.bar === false && props.view.layout !== 'phone' ? null : <SpecimenBar view="walkthrough" phone={props.view.layout === 'phone'} offline={Boolean(props.view.offline)} pending={props.pending} findSurfaceId={findSurfaceId} />}
            <WalkthroughView
                {...props.view}
                findSurfaceId={findSurfaceId}
                reading={reading}
                onToggleReviewed={(stop) => setRefs((current) => (stop.reviewed
                    ? current.filter((ref) => !stop.changeRefs.includes(ref))
                    : [...current, ...stop.changeRefs]))}
            />
        </View>
        </PluginSurfaceFocusEligibilityProvider>
    );
}

/** The empty state with its start: the model it will use beside Start, and the typed reason a start was refused. */
function StartFrame(props: Readonly<{ phone: boolean; failure: ScmDiffSummaryFailurePresentation | null; disabled?: boolean }>) {
    return (
        <View style={styles.fill}>
            {props.phone ? <SpecimenBar view="walkthrough" phone /> : <SpecimenBar view="walkthrough" pending />}
            <WalkthroughView
                reading={EMPTY_WALKTHROUGH_READING}
                layout={props.phone ? 'phone' : 'wide'}
                scopeLabel={resolveFilesComparisonLabel(PENDING, null)}
                onShowFiles={noop}
                start={{ onStart: noop, disabled: props.disabled, options: <ScmDiffSummaryStartOptions testID="walkthrough-start-options" failure={props.failure} message={null}
                    model={{ value: { v: 1, mode: 'auto' }, onChange: noop, testID: 'walkthrough-model-choice' }} onChooseModel={noop} onEnableExplain={noop} /> }}
            />
        </View>
    );
}

const COMPLETE: Omit<WalkthroughReadingInput, 'reviewed'> = {
    comparison: SPECIMEN_COMPARISON,
    walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
    analysis: SPECIMEN_ANALYSIS_COMPLETE,
};
const MERGED: Omit<WalkthroughReadingInput, 'reviewed'> = {
    ...COMPLETE,
    walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH_MERGED },
};
/** What the producer saves when writing stops after some stops: the partial output with its (diagnostic) reason. */
const STOPPED_PARTWAY: WalkthroughReadingInput = {
    ...COMPLETE,
    walkthrough: { state: 'partial', value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 2), otherChangeRefs: [] }, reason: 'Anthropic is overloaded (529)' },
    analysis: SPECIMEN_ANALYSIS_STOPPED,
    reviewed: null,
};

function base(layout: WalkthroughViewLayout): Omit<WalkthroughViewProps, 'reading' | 'onToggleReviewed'> {
    return {
        layout,
        scopeLabel: t('scmComparison.scope.session'),
        scopeDetail: DETAIL,
        modelLabel: 'Opus 5.5',
        analysisMark: <AgentIcon agentId="claude" size={ICON_SIZE.xs} />,
        onAsk: noop,
        onOpenFile: noop,
    };
}

/** One cell of the lifecycle storyboard (lab WT2-L). */
function LifecycleCell(props: Readonly<{ caption: string; reading: WalkthroughReadingInput; view?: Partial<WalkthroughViewProps> }>) {
    const reading = useWalkthroughReading(props.reading);
    return (
        <View style={styles.cell}>
            <Text style={styles.cellCaption}>{props.caption}</Text>
            <View style={styles.cellFrame}>
                <SpecimenBar view="walkthrough" offline={Boolean(props.view?.offline)} />
                <WalkthroughView {...base('narrow')} {...props.view} reading={reading} onToggleReviewed={noop} />
            </View>
        </View>
    );
}

const INCOMPLETE_COMPARISON = {
    ...SPECIMEN_COMPARISON,
    inventory: {
        ...SPECIMEN_COMPARISON.inventory,
        files: SPECIMEN_COMPARISON.inventory.files.map((file, index) => (index === 7
            ? { ...file, evidence: { state: 'unavailable' as const, reason: 'permission denied on MacBook Pro' } }
            : file)),
    },
};

function Lifecycle() {
    const L = 'WT2-L';
    return (
        <ScrollView contentContainerStyle={styles.grid}>
            <LifecycleCell caption={`${L} 1 · Immediately`} reading={{ ...COMPLETE, walkthrough: { state: 'writing' }, analysis: SPECIMEN_ANALYSIS_EARLY, reviewed: null }} />
            <LifecycleCell caption={`${L} 2 · Stops arrive`} reading={{ ...COMPLETE, walkthrough: { state: 'writing', value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 1), otherChangeRefs: [] } }, analysis: SPECIMEN_ANALYSIS_MOST, reviewed: null }} />
            <LifecycleCell caption={`${L} 3 · Complete`} reading={{ ...COMPLETE, reviewed: null }} view={{ scopeDetail: 'written 10:42 in 38 s' }} />
            <LifecycleCell caption={`${L} 5 · Incomplete evidence`} reading={{ ...COMPLETE, comparison: INCOMPLETE_COMPARISON, analysis: SPECIMEN_ANALYSIS_STOPPED, reviewed: null }} />
            <LifecycleCell caption={`${L} 6 · Stale after a later edit`} reading={{ ...COMPLETE, reviewed: reviewed(1) }} view={{ stale: { onRefresh: noop } }} />
            <LifecycleCell caption={`${L} 7 · Failed`} reading={STOPPED_PARTWAY} view={{ failure: SCM_DIFF_SUMMARY_ENDED_PARTWAY_FAILURE, onRetry: noop, onChooseModel: noop }} />
            <LifecycleCell caption={`${L} 8 · Machine offline`} reading={{ ...COMPLETE, reviewed: reviewed(2) }} view={{ offline: { machine: 'MacBook Pro', time: '10:42' }, scopeDetail: 'from 10:42' }} />
            <LifecycleCell caption={`WT3-D4 · Generator ended`} reading={{ ...COMPLETE, reviewed: reviewed(1) }} view={{ endedConversation: { onStartNew: noop, onAskSession: noop } }} />
            <LifecycleCell caption={`${L} · Not written yet`} reading={{ ...COMPLETE, walkthrough: null, reviewed: null }} view={{ onShowFiles: noop }} />
        </ScrollView>
    );
}

function PhoneContents() {
    const reading = React.useMemo(() => buildWalkthroughReading({ ...COMPLETE, reviewed: reviewed(2) }), []);
    return (
        <View style={styles.fill}>
            <SpecimenBar view="walkthrough" phone />
            <WalkthroughView {...base('phone')} reading={reading} initialStopId="sheet" onToggleReviewed={noop} />
            <View style={styles.scrim} />
            <View style={styles.sheet}>
                <View style={styles.grabber} />
                <WalkthroughContents
                    placement="sheet"
                    stops={reading.stops}
                    others={reading.others}
                    reviewedCount={reading.reviewedCount}
                    currentStopId="sheet"
                    onSelectStop={noop}
                    onDone={noop}
                />
            </View>
        </View>
    );
}

export type WalkthroughSpecimenFrame = Readonly<{ id: string; title: string; render: (phone: boolean) => React.ReactElement }>;

export const WALKTHROUGH_SPECIMEN_FRAMES: readonly WalkthroughSpecimenFrame[] = [
    { id: 'S1', title: 'Empty · Start with its model', render: (phone) => <StartFrame phone={phone} failure={null} /> },
    { id: 'S2', title: 'Empty · refused: outdated machine', render: (phone) => <StartFrame phone={phone} failure={SPECIMEN_START_FAILURES.outdated} /> },
    { id: 'S3', title: 'Empty · refused: model unavailable', render: (phone) => <StartFrame phone={phone} failure={SPECIMEN_START_FAILURES.model} /> },
    { id: 'S4', title: 'Empty · refused: machine unreachable', render: (phone) => <StartFrame phone={phone} failure={SPECIMEN_START_FAILURES.unreachable} /> },
    { id: 'S5', title: 'Empty · Explain changes is off', render: (phone) => <StartFrame phone={phone} failure={SPECIMEN_START_FAILURES.explainOff} disabled /> },
    { id: 'LongModel', title: 'Contract-valid long model identity', render: (phone) => <LiveMarks
        input={COMPLETE} reviewedCount={0} bar={!phone} view={{ ...base(phone ? 'phone' : 'wide'),
            modelLabel: 'synthetic-provider/descriptive-model-identity-with-an-unbounded-producer-label' }} /> },
    { id: 'InvalidEvidence', title: 'Malformed captured hunk', render: (phone) => <LiveMarks
        input={{ ...COMPLETE, comparison: { ...SPECIMEN_COMPARISON, inventory: { ...SPECIMEN_COMPARISON.inventory,
            files: SPECIMEN_COMPARISON.inventory.files.map((file, index) => index === 0 ? { ...file,
                evidence: { state: 'available', unifiedDiff: file.evidence.unifiedDiff?.replace('@@ -18,4 +19,5 @@', '@@ -18,400 +19,500 @@') ?? '' },
            } : file) } } }} reviewedCount={0} bar={false} view={base(phone ? 'phone' : 'wide')} /> },
    { id: 'A', title: 'WT1-A · Walkthrough', render: (phone) => <LiveMarks input={COMPLETE} reviewedCount={0} bar={!phone} view={base(phone ? 'phone' : 'wide')} /> },
    { id: 'AP', title: 'WT1-A · Walkthrough on Pending changes (Commits and Propose commits)', render: (phone) => <LiveMarks input={COMPLETE} reviewedCount={0} bar={!phone} pending view={{ ...base(phone ? 'phone' : 'wide'), scopeLabel: resolveFilesComparisonLabel(PENDING, null) }} /> },
    { id: 'A3', title: 'WT1-A3 · overview open', render: (phone) => <LiveMarks input={COMPLETE} reviewedCount={0} bar={!phone} view={{ ...base(phone ? 'phone' : 'wide'), initialOverviewOpen: true }} /> },
    { id: 'A2', title: 'WT1-A2p · contents sheet', render: () => <PhoneContents /> },
    { id: 'L', title: 'WT2-L · lifecycle', render: () => <Lifecycle /> },
    { id: 'L7', title: 'WT2-L7 · failed', render: (phone) => <LiveMarks input={STOPPED_PARTWAY} reviewedCount={0} bar={!phone} view={{ ...base(phone ? 'phone' : 'wide'), failure: SCM_DIFF_SUMMARY_ENDED_PARTWAY_FAILURE, onRetry: noop, onChooseModel: noop }} /> },
    { id: 'L7t', title: 'WT2-L7 · stopped: the change is larger than the runtime reads, no retry', render: (phone) => <LiveMarks input={STOPPED_PARTWAY} reviewedCount={0} bar={!phone} view={{ ...base(phone ? 'phone' : 'wide'), failure: SPECIMEN_START_FAILURES.tooLarge, onRetry: noop, onChooseModel: noop }} /> },
    { id: 'L7w', title: 'WT2-L7 · stopped: more than the model reads, Choose model', render: (phone) => <LiveMarks input={STOPPED_PARTWAY} reviewedCount={0} bar={!phone} view={{ ...base(phone ? 'phone' : 'wide'), failure: SPECIMEN_START_FAILURES.smallWindow, onRetry: noop, onChooseModel: noop }} /> },
    { id: 'L7m', title: 'WT2-L7 · regeneration refused: model unavailable, reading kept', render: (phone) => <LiveMarks input={COMPLETE} reviewedCount={0} bar={!phone}
        view={{ ...base(phone ? 'phone' : 'wide'), failure: SPECIMEN_START_FAILURES.model, onRetry: noop, onChooseModel: noop }} /> },
    { id: 'L7o', title: 'WT2-L7 · regeneration refused: outdated machine, reading kept', render: (phone) => <LiveMarks input={COMPLETE} reviewedCount={0} bar={!phone}
        view={{ ...base(phone ? 'phone' : 'wide'), failure: SPECIMEN_START_FAILURES.outdated, onRetry: noop }} /> },
    { id: 'L7e', title: 'WT2-L7 · regeneration refused: Explain changes is off, reading kept', render: (phone) => <LiveMarks input={COMPLETE} reviewedCount={0} bar={!phone}
        view={{ ...base(phone ? 'phone' : 'wide'), failure: SPECIMEN_START_FAILURES.explainOff, onRetry: noop, onEnableExplain: noop }} /> },
    { id: 'L9', title: 'WT2-L9 · Start unconfirmed: nothing written yet', render: (phone) => <LiveMarks
        input={{ ...COMPLETE, walkthrough: { state: 'pending' }, analysis: SPECIMEN_ANALYSIS_EARLY }} reviewedCount={0} bar={!phone}
        view={{ ...base(phone ? 'phone' : 'wide'), admission: 'outcomeUnknown', onCheckAdmission: noop }} /> },
    { id: 'L9w', title: 'WT2-L9 · Start unconfirmed: some stops captured', render: (phone) => <LiveMarks
        input={{ ...COMPLETE, walkthrough: { state: 'writing', value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 2), otherChangeRefs: [] } }, analysis: SPECIMEN_ANALYSIS_MOST }}
        reviewedCount={0} bar={!phone} view={{ ...base(phone ? 'phone' : 'wide'), admission: 'outcomeUnknown', onCheckAdmission: noop }} /> },
    { id: 'L8', title: 'WT2-L8 · Machine offline', render: (phone) => <LiveMarks input={COMPLETE} reviewedCount={2}
        view={{ ...base(phone ? 'phone' : 'wide'), offline: { machine: 'MacBook Pro', time: '10:42' } }} /> },
    {
        id: 'D2',
        title: 'WT3-D2 · merged with your title kept',
        render: (phone) => (
            <LiveMarks
                input={MERGED}
                reviewedCount={1}
                bar={!phone}
                view={{
                    ...base(phone ? 'phone' : 'wide'),
                    update: {
                        title: 'Merged stops 2 and 3',
                        description: 'into “One key for the modal and the sheet”. Your title “Narrow windows, same modal” was kept; nothing else changed.',
                        onUndo: noop,
                    },
                }}
            />
        ),
    },
];

const styles = StyleSheet.create((theme) => ({
    fill: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s24, padding: theme.space.s24 },
    cell: { width: 575, gap: theme.space.s8 },
    cellCaption: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary,  },
    cellFrame: {
        height: 420,
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.text.primary, opacity: 0.18 },
    sheet: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: '64%',
        borderTopLeftRadius: 18,
        borderTopRightRadius: 18,
        backgroundColor: theme.colors.surface.base,
    },
    grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginTop: theme.space.s8, backgroundColor: theme.colors.border.strong },
}));
