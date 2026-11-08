import * as React from 'react';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { I18nManager, Pressable, View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { resolveSessionAwarenessContentLabel } from '@/sync/domains/session/awareness/sessionAwarenessContentLabels';
import type { SessionPendingPermission } from '@/sync/ops/sessionPendingPermissions';
import type { SessionPermissionAnswer } from '@/sync/ops/sessionPermissionAnswers';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SessionPendingPromptCards } from '@/components/tools/shell/permissions/SessionPendingPromptCards';
import { TranscriptOriginSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { SessionCompanionDensity } from '../state/sessionCompanionPreference';
import {
    resolveSessionSummaryDetailRows,
    type SessionSummaryCardModel,
    type SessionSummaryDestination,
    type SessionSummaryFact,
    type SessionSummaryRow,
} from './sessionSummaryProjection';
import {
    resolveSessionSummaryApprovalEmphasisMotion,
    shouldEmphasizeNewSessionSummaryApproval,
} from './sessionSummaryApprovalEmphasis';
import { SessionSummaryStatusLine } from './SessionSummaryStatusLine';

/**
 * The first-party Session Summary, recomposed as the Companion's live hero (lab CA).
 *
 * One status line in words with its timer, the ask that is waiting for you with its
 * answers, three facts and the remaining detail rows. Every value comes from the
 * pure projection; answers go through the ONE shared permission-answer owner the
 * caller hands in, and every fact or row opens its EXISTING owning surface. The card
 * never mutates Git, approvals, goals or usage itself.
 */

export type SessionSummaryDestinationHandlers =
    Partial<Readonly<Record<SessionSummaryDestination, () => void>>>;

export type SessionSummaryAnswerPermission = (
    request: SessionPendingPermission,
    answer: SessionPermissionAnswer,
) => Promise<void>;

const stylesheet = StyleSheet.create((theme) => ({
    root: { gap: theme.space.s12 },
    statusBlock: { gap: 1 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, minHeight: 26 },
    grow: { flex: 1 },
    what: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
        marginStart: 23,
    },
    need: {
        paddingTop: theme.space.s10,
        paddingBottom: theme.space.s12,
        paddingHorizontal: theme.space.s12,
        borderRadius: 12,
        backgroundColor: theme.colors.state.warning.background,
        gap: theme.space.s2,
    },
    needHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
    needQuestion: {
        color: theme.colors.text.primary,
        ...Typography.variant('body', 'semiBold'),
        flexShrink: 1,
    },
    needReason: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
        marginStart: 22,
    },
    needActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, marginStart: 22, marginTop: theme.space.s8 },
    quietLink: {  color: theme.colors.text.secondary, ...Typography.variant('meta') },
    done: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minHeight: 36,
        paddingHorizontal: theme.space.s12,
        borderRadius: 12,
        backgroundColor: theme.colors.state.success.background,
    },
    doneText: {  color: theme.colors.text.primary, ...Typography.variant('meta'), flexShrink: 1 },
    doneTime: {  color: theme.colors.text.tertiary, ...Typography.variant('meta') },
    facts: { flexDirection: 'row', gap: theme.space.s6 },
    fact: {
        flex: 1,
        minWidth: 0,
        alignItems: 'flex-start',
        gap: 1,
        paddingVertical: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    factPressed: { backgroundColor: theme.colors.surface.pressed },
    factValue: { ...Typography.tabular(),  color: theme.colors.text.primary, ...Typography.variant('heading'),  },
    factLabel: {  color: theme.colors.text.secondary, ...Typography.variant('micro'),  },
    meterTrack: {
        width: 26,
        height: 5,
        borderRadius: 3,
        marginTop: theme.space.s4,
        marginBottom: theme.space.s6,
        overflow: 'hidden',
        backgroundColor: theme.colors.border.default,
    },
    rows: { gap: theme.space.s2 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 28,
        borderRadius: 8,
        paddingHorizontal: theme.space.s6,
        marginHorizontal: -6,
    },
    rowPressed: { backgroundColor: theme.colors.surface.pressed },
    rowLabel: {  color: theme.colors.text.secondary, ...Typography.variant('body'), flex: 1, minWidth: 0 },
    rowValueAction: {  color: theme.colors.text.primary, ...Typography.variant('body', 'semiBold') },
    footerLabel: {  color: theme.colors.text.link, ...Typography.variant('body'), flex: 1 },
    stale: {  color: theme.colors.text.tertiary, ...Typography.variant('meta') },
}));

/** One glyph per detail row kind, so the rows scan by shape before they are read. */
const SUMMARY_ROW_ICONS = {
    approvals: 'bell',
    activity: 'robot',
    work: 'lightning',
    workflow: 'lightning',
    recap: 'article',
    workspace: 'git-branch',
    usage: 'chart-line',
} as const satisfies Record<SessionSummaryRow['kind'], IconName>;

function detailRowLabel(row: SessionSummaryRow): string {
    switch (row.kind) {
        case 'approvals':
            return t('sessionBoard.companion.summary.approvals', { count: row.count });
        case 'workflow':
            return t('sessionBoard.companion.summary.workflows', { count: row.runCount });
        case 'activity':
            return row.title ?? t('tools.workflowActivityView.agentsCount', { count: row.totalCount });
        case 'work':
            return row.label;
        case 'recap':
            return row.text;
        case 'workspace':
            return row.branch ?? row.label;
        case 'usage':
            return t('sessionBoard.companion.summary.contextOnly');
    }
}

/** The status sentence under the status words (lab CA "Claude paused before step 4 of 5"). */
export function resolveSessionSummaryWhatLine(model: SessionSummaryCardModel): string | null {
    const agent = model.agentLabel ?? t('sessionCompanion.status.agentFallback');
    if (model.needsYou && model.progress) {
        return t('sessionCompanion.status.pausedBeforeStep', { agent, ...model.progress });
    }
    if (model.progress && model.status?.state === 'thinking') {
        return t('sessionCompanion.status.stepOfPlan', model.progress);
    }
    const work = model.rows.find((row) => row.kind === 'work');
    if (work?.kind === 'work') return work.label;
    return null;
}

const SummaryStatus = React.memo(function SummaryStatus(props: Readonly<{
    model: SessionSummaryCardModel;
    headerAccessory?: React.ReactNode;
    testID: string;
}>) {
    const { model } = props;
    const words = model.needsYou
        ? t('sessionCompanion.status.waitingForYou')
        : model.status?.statusText ?? null;
    const what = resolveSessionSummaryWhatLine(model);
    return (
        <View style={stylesheet.statusBlock}>
            <SessionSummaryStatusLine title={t('sessionBoard.companion.summary.title')} words={words} agentId={model.agentId} sinceMs={model.sinceMs}
                testID={props.testID} headerAccessory={props.headerAccessory} />
            {what ? (
                <Text testID={`${props.testID}-what`} style={stylesheet.what} numberOfLines={2}>{what}</Text>
            ) : null}
        </View>
    );
});

type AskOutcome = Readonly<{ summary: string; answer: SessionPermissionAnswer; atMs: number }>;

/** How long "✓ Allowed … · just now" stays before its one shared-clock expiry. */
const ANSWERED_JUST_NOW_MS = 60_000;

/**
 * The waiting ask, answered in place (lab CX): Allow calls the same permission
 * owner as the chat card, the block folds into one confirmation line, and the chat
 * card updates from the same Session state in the same frame.
 */
const SummaryAsk = React.memo(function SummaryAsk(props: Readonly<{
    needsYou: NonNullable<SessionSummaryCardModel['needsYou']> | null;
    offline: boolean;
    machineName: string | null;
    answerPermission?: SessionSummaryAnswerPermission;
    showInChat?: (request: SessionPendingPermission) => void;
    openApprovals?: () => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const [inFlight, setInFlight] = React.useState<SessionPermissionAnswer | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [outcome, setOutcome] = React.useState<AskOutcome | null>(null);
    const candidate = props.needsYou?.request ?? null;
    const request = candidate && 'requestId' in candidate ? candidate : null;
    const requestId = request?.requestId ?? null;
    const presented = useLayoutPresentationActive();
    const viewed = useHostActivelyViewed();
    // The receipt includes exactly 60 seconds; its existing predicate expires on the next millisecond.
    const expiresAtMs = outcome === null ? null : outcome.atMs + ANSWERED_JUST_NOW_MS + 1;
    const readNextRefreshAtMs = React.useCallback((nowMs: number) =>
        expiresAtMs !== null && nowMs < expiresAtMs ? expiresAtMs : null, [expiresAtMs]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs,
        outcome !== null && request === null && presented && viewed);
    React.useEffect(() => {
        // A new ask replaces both the confirmation and any failure for the last one.
        if (requestId === null) return;
        setFailed(false);
        setInFlight(null);
        setOutcome((current) => (current ? null : current));
    }, [requestId]);

    const answer = React.useCallback((value: SessionPermissionAnswer) => {
        if (!request || !props.answerPermission || inFlight) return;
        setInFlight(value);
        setFailed(false);
        props.answerPermission(request, value).then(
            () => {
                setOutcome({ summary: request.summary, answer: value, atMs: Date.now() });
                setInFlight(null);
            },
            () => {
                setFailed(true);
                setInFlight(null);
            },
        );
    }, [inFlight, props, request]);

    if (!request) {
        if (!outcome || nowMs - outcome.atMs > ANSWERED_JUST_NOW_MS) return null;
        return (
            <View testID={`${props.testID}-answered`} style={stylesheet.done} accessibilityRole="text" accessibilityLiveRegion="polite">
                <Icon
                    name={outcome.answer === 'deny' ? 'x-circle' : 'check-circle'}
                    size={15}
                    color={outcome.answer === 'deny' ? theme.colors.text.secondary : theme.colors.state.success.foreground}
                />
                <Text style={stylesheet.doneText} numberOfLines={1}>
                    {outcome.answer === 'deny'
                        ? t('sessionCompanion.ask.denied', { summary: outcome.summary })
                        : t('sessionCompanion.ask.allowed', { summary: outcome.summary })}
                </Text>
                <View style={stylesheet.grow} />
                <Text style={stylesheet.doneTime}>{t('sessionCompanion.ask.justNow')}</Text>
            </View>
        );
    }

    const canAllow = request.answers.includes('allowOnce');
    const canDeny = request.answers.includes('deny');
    const answerable = props.answerPermission !== undefined && (canAllow || canDeny);
    const reason = failed
        ? t('sessionCompanion.ask.failed')
        : answerable
            ? request.command ?? null
            : props.offline
                ? (props.machineName
                    ? t('sessionCompanion.ask.answerWhenBack', { machine: props.machineName })
                    : t('sessionCompanion.ask.answerWhenSessionBack'))
                : t('sessionCompanion.ask.notAllowed');
    const moreCount = props.needsYou?.moreCount ?? 0;
    return (
        <View
            testID={`${props.testID}-ask`}
            style={stylesheet.need}
            accessibilityRole="summary"
            accessibilityLabel={t('sessionCompanion.ask.groupA11y')}
        >
            <View style={stylesheet.needHead}>
                <Icon name="warning" size={15} color={theme.colors.state.warning.foreground} />
                <Text style={stylesheet.needQuestion} numberOfLines={2}>
                    {t('sessionCompanion.ask.question', { summary: request.summary })}
                </Text>
            </View>
            {reason ? (
                <Text testID={`${props.testID}-ask-reason`} style={stylesheet.needReason} numberOfLines={2}>
                    {reason}
                </Text>
            ) : null}
            <View style={stylesheet.needActions}>
                <RoundButton
                    size="small"
                    testID={`${props.testID}-allow`}
                    title={t('sessionCompanion.ask.allow')}
                    disabled={!answerable || !canAllow || inFlight !== null}
                    loading={inFlight === 'allowOnce'}
                    onPress={() => answer('allowOnce')}
                />
                <RoundButton
                    size="small"
                    display="secondary"
                    testID={`${props.testID}-deny`}
                    title={t('sessionCompanion.ask.deny')}
                    disabled={!answerable || !canDeny || inFlight !== null}
                    loading={inFlight === 'deny'}
                    onPress={() => answer('deny')}
                />
                <View style={stylesheet.grow} />
                {moreCount > 0 && props.openApprovals ? (
                    <HappierPressable accessibilityRole="link" onPress={props.openApprovals}>
                        <Text style={stylesheet.quietLink}>{t('sessionCompanion.ask.moreWaiting', { count: moreCount })}</Text>
                    </HappierPressable>
                ) : props.showInChat ? (
                    <HappierPressable
                        testID={`${props.testID}-show-in-chat`}
                        accessibilityRole="link"
                        onPress={() => props.showInChat?.(request)}
                    >
                        <Text style={stylesheet.quietLink}>{t('sessionCompanion.ask.showInChat')}</Text>
                    </HappierPressable>
                ) : null}
            </View>
        </View>
    );
});

const FACT_ICONS = {
    subagents: 'robot',
    changes: 'git-branch',
} as const satisfies Record<Exclude<SessionSummaryFact['kind'], 'context'>, IconName>;

function factPresentation(fact: SessionSummaryFact): Readonly<{ value: string; label: string; opens: string }> {
    switch (fact.kind) {
        case 'subagents':
            return {
                value: t('sessionCompanion.facts.subagentsValue', { live: fact.live, total: fact.total }),
                label: t('sessionCompanion.facts.subagents'),
                opens: t('sessionCompanion.facts.opensAgents'),
            };
        case 'changes':
            return {
                value: String(fact.count),
                label: t('sessionCompanion.facts.changed'),
                opens: t('sessionCompanion.facts.opensGit'),
            };
        case 'context':
            return {
                value: t('sessionCompanion.facts.contextValue', { percent: fact.percent }),
                label: t('sessionCompanion.facts.context'),
                opens: t('sessionCompanion.facts.opensUsage'),
            };
    }
}

const SummaryFactCell = React.memo(function SummaryFactCell(props: Readonly<{
    fact: SessionSummaryFact;
    onPress?: (() => void) | undefined;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const presentation = factPresentation(props.fact);
    const lead = props.fact.kind === 'context' ? (
        <MeterBar style={stylesheet.meterTrack} tone="neutral" fillFraction={props.fact.percent / 100} height={5}
            fillColor={theme.colors.text.secondary} trackColor={theme.colors.border.default} />
    ) : (
        <Icon name={FACT_ICONS[props.fact.kind]} size={14} color={theme.colors.text.tertiary} />
    );
    const body = (
        <>
            {lead}
            <Text style={[stylesheet.factValue, props.fact.kind === 'context' && props.fact.stale ? { opacity: 0.7 } : null]} numberOfLines={1}>
                {presentation.value}
            </Text>
            <Text style={stylesheet.factLabel} numberOfLines={1}>{presentation.label}</Text>
        </>
    );
    const accessibilityLabel = `${presentation.value} ${presentation.label}`;
    if (!props.onPress) {
        return <View testID={props.testID} style={stylesheet.fact} accessibilityLabel={accessibilityLabel}>{body}</View>;
    }
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={presentation.opens}
            onPress={props.onPress}
            style={({ pressed }) => [stylesheet.fact, pressed ? stylesheet.factPressed : null]}
        >
            {body}
        </Pressable>
    );
});

const DetailRow = React.memo(function DetailRow(props: Readonly<{
    row: SessionSummaryRow;
    onPress?: (() => void) | undefined;
    approvalEmphasisSignal: number;
    reducedMotion: boolean;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const label = detailRowLabel(props.row);
    const recapTitle = props.row.kind === 'recap' ? t('sessionCompanion.recap.title') : null;
    const accessibilityLabel = recapTitle ? `${recapTitle}: ${label}` : label;
    const emphasis = useSharedValue(1);
    React.useEffect(() => {
        if (props.row.kind !== 'approvals' || props.approvalEmphasisSignal === 0) return;
        const motion = resolveSessionSummaryApprovalEmphasisMotion(props.reducedMotion);
        emphasis.value = motion.initialOpacity;
        if (motion.durationMs > 0) {
            emphasis.value = withTiming(1, { duration: motion.durationMs, easing: motionTokens.easing.standard });
        }
    }, [emphasis, props.approvalEmphasisSignal, props.reducedMotion, props.row.kind]);
    const emphasisStyle = useAnimatedStyle(() => ({ opacity: emphasis.value }));
    const needsYou = props.row.kind === 'approvals';
    const body = (
        <>
            <Icon
                name={SUMMARY_ROW_ICONS[props.row.kind]}
                size={14}
                color={needsYou ? theme.colors.state.warning.foreground : theme.colors.text.tertiary}
            />
            {recapTitle ? <Text style={stylesheet.rowValueAction}>{recapTitle}</Text> : null}
            <Text numberOfLines={1} style={stylesheet.rowLabel}>{label}</Text>
            {needsYou && props.onPress ? (
                <Text style={stylesheet.rowValueAction}>{t('sessionBoard.companion.summary.review')}</Text>
            ) : null}
            {props.onPress ? (
                <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} mirrored={I18nManager.isRTL} />
            ) : null}
        </>
    );
    return (
        <Animated.View style={emphasisStyle} testID={`${props.testID}-emphasis`}>
            {props.onPress ? (
                <HappierPressable
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                    onPress={props.onPress}
                    hitReach={{ top: theme.space.s2 / 2, bottom: theme.space.s2 / 2 }}
                    style={({ pressed }) => [stylesheet.row, pressed && stylesheet.rowPressed]}
                >
                    {body}
                </HappierPressable>
            ) : (
                <View style={stylesheet.row} testID={props.testID}>{body}</View>
            )}
        </Animated.View>
    );
});

export const SessionSummaryCard = React.memo(function SessionSummaryCard(props: Readonly<{
    model: SessionSummaryCardModel;
    /** Exact Session context for canonical question and Action-confirmation controls. */
    session?: Session;
    serverId?: string | null;
    /** This placement is a measurement-only copy of the visible card. */
    readOnly?: boolean;
    density: SessionCompanionDensity;
    presentation?: 'card' | 'full';
    destinations?: SessionSummaryDestinationHandlers;
    /** Opens the full Companion, where every omitted row stays reachable. */
    onOpenFullSurface?: () => void;
    /** The shared permission-answer owner, bound to this exact Session by the caller. */
    answerPermission?: SessionSummaryAnswerPermission;
    showPermissionInChat?: (request: SessionPendingPermission) => void;
    /** The owning machine's name, for "You can answer when … is back". */
    machineName?: string | null;
    /** The placement's own controls (reorder, item menu), drawn at the end of the status line. */
    headerAccessory?: React.ReactNode;
    /**
     * The host's widget frame draws the status words, its sentence and the freshness line in its header
     * (the Companion, lab crows B); the card draws the ask and its rows, and no fact cells (the Companion's
     * sections carry those facts).
     */
    statusInFrame?: boolean;
    testID?: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const widgetPresentation = useWidgetPresentation();
    const reducedMotion = useReducedMotionPreference();
    const testID = props.testID ?? 'session-companion-summary';
    const { model } = props;
    const visible = React.useMemo(
        () => resolveSessionSummaryDetailRows(
            model,
            widgetPresentation?.footprint.height === 'compact' && props.onOpenFullSurface
                ? { kind: 'widgetSummary' }
                : props.presentation === 'full' || !props.onOpenFullSurface
                ? { kind: 'full' }
                : { kind: 'card', density: props.density },
        ),
        [props.density, model, props.onOpenFullSurface, props.presentation, widgetPresentation?.footprint.height],
    );
    const approvalCount = React.useMemo(() => (
        model.rows.find((row) => row.kind === 'approvals')?.count ?? 0
    ), [model.rows]);
    const previousApprovalCountRef = React.useRef<number | null>(null);
    const [approvalEmphasisSignal, setApprovalEmphasisSignal] = React.useState(0);
    React.useEffect(() => {
        const previous = previousApprovalCountRef.current;
        previousApprovalCountRef.current = approvalCount;
        if (shouldEmphasizeNewSessionSummaryApproval(previous, approvalCount)) {
            setApprovalEmphasisSignal((signal) => signal + 1);
        }
    }, [approvalCount]);

    // Content/current-realm unavailability is the stronger canonical truth: no
    // status line inferred from facts this viewer cannot read.
    const exact = model.scope === 'exact' && model.availability !== 'locked';
    const availabilityLabel = model.scope === 'realm_unavailable'
        ? t('sessionBoard.board.unavailable.reason')
        : model.availability === 'locked'
            ? resolveSessionAwarenessContentLabel(model.encryption) ?? t('status.encryptedUnavailable')
            : null;
    // Session runtime freshness and Machine transport reachability are separate facts.
    // This is the same scoped, reactive presence owner that Vitals consumes.
    const { machineReachability } = useSessionMachineReachability(
        props.session?.id ?? '', props.serverId ?? props.session?.serverId,
    );
    const offline = machineReachability === 'unreachable';
    // A host that frames the status itself (the Companion's widget frame) draws the freshness line and
    // the status words in its own header; the card then draws only the ask and its rows.
    const ownsStatus = props.statusInFrame !== true;

    return (
        <View testID={testID} style={styles.root} accessibilityRole="summary">
            {exact && model.stale && ownsStatus ? (
                <SessionSummaryFreshnessLine model={model} session={props.session} serverId={props.serverId}
                    machineName={props.machineName ?? null} testID={`${testID}-freshness`} />
            ) : null}
            {exact && ownsStatus ? (
                <SummaryStatus model={model} headerAccessory={props.headerAccessory} testID={testID} />
            ) : props.headerAccessory && ownsStatus ? (
                <View style={styles.statusRow}>
                    <View style={styles.grow} />
                    {props.headerAccessory}
                </View>
            ) : null}

            {exact && model.needsYou && 'id' in model.needsYou.request && props.session ? (
                <TranscriptOriginSourceProvider readOnly={props.readOnly === true}>
                    <View style={styles.rows}>
                        <SessionPendingPromptCards
                            testID={`${testID}-ask`}
                            sessionId={props.session.id}
                            serverId={props.serverId ?? props.session.serverId}
                            session={props.session}
                            permissions={[]}
                            userActions={[model.needsYou.request]}
                        />
                        {model.needsYou.moreCount > 0 ? (
                            <Text testID={`${testID}-ask-more-waiting`} style={styles.quietLink}>
                                {t('sessionCompanion.ask.moreWaiting', { count: model.needsYou.moreCount })}
                            </Text>
                        ) : null}
                    </View>
                </TranscriptOriginSourceProvider>
            ) : exact ? (
                <SummaryAsk
                    needsYou={model.needsYou}
                    offline={offline}
                    machineName={props.machineName ?? null}
                    {...(props.answerPermission ? { answerPermission: props.answerPermission } : {})}
                    {...(props.showPermissionInChat ? { showInChat: props.showPermissionInChat } : {})}
                    {...(props.destinations?.approvals ? { openApprovals: props.destinations.approvals } : {})}
                    testID={testID}
                />
            ) : null}

            {exact && ownsStatus && model.facts.length > 0 ? (
                <View style={styles.facts} testID={`${testID}-facts`}>
                    {model.facts.map((fact) => (
                        <SummaryFactCell
                            key={fact.kind}
                            fact={fact}
                            onPress={props.destinations?.[fact.destination]}
                            testID={`${testID}-fact-${fact.kind}`}
                        />
                    ))}
                </View>
            ) : null}

            {exact && visible.rows.length > 0 ? (
                <View style={styles.rows}>
                    {visible.rows.map((row) => (
                        <DetailRow
                            key={row.kind}
                            row={row}
                            approvalEmphasisSignal={row.kind === 'approvals' ? approvalEmphasisSignal : 0}
                            reducedMotion={reducedMotion}
                            testID={`${testID}-row-${row.kind}`}
                            onPress={props.destinations?.[row.destination]}
                        />
                    ))}
                </View>
            ) : null}

            {exact && visible.hiddenCount > 0 && props.onOpenFullSurface ? (
                <HappierPressable
                    testID={`${testID}-more`}
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionBoard.companion.summary.moreDetailsA11y', { count: visible.hiddenCount })}
                    onPress={props.onOpenFullSurface}
                    hitReach={{ top: theme.space.s2 / 2, bottom: theme.space.s2 / 2 }}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                    <Text style={styles.footerLabel}>{t('sessionBoard.companion.summary.moreDetails')}</Text>
                    <Icon name="caret-right" size={14} color={theme.colors.text.link} mirrored={I18nManager.isRTL} />
                </HappierPressable>
            ) : null}

            {availabilityLabel ? (
                <Text testID={`${testID}-availability`} style={styles.stale}>{availabilityLabel}</Text>
            ) : null}
            {exact && model.availability === 'partial' ? (
                <Text style={styles.stale}>{t('sessionBoard.companion.summary.partial')}</Text>
            ) : null}
        </View>
    );
});

/**
 * When the Session's facts are last-known, and why (lab companion CSp): the Machine's own presence owner
 * first, else the canonical Session status. Retry re-reads the owner that decided the cause. The one
 * freshness line for the Session summary, drawn by the card or, in the Companion, under its title.
 */
export const SessionSummaryFreshnessLine = React.memo(function SessionSummaryFreshnessLine(props: Readonly<{
    model: SessionSummaryCardModel;
    session?: Session;
    serverId?: string | null;
    machineName: string | null;
    /** `chip`: one quiet line under a column's title (the Companion); `line` (default): the card's strip. */
    presentation?: 'line' | 'chip';
    testID: string;
}>) {
    const { model } = props;
    // Session runtime freshness and Machine transport reachability are separate facts.
    const { machineReachability, machineLastSeenAt } = useSessionMachineReachability(
        props.session?.id ?? '', props.serverId ?? props.session?.serverId,
    );
    const offline = machineReachability === 'unreachable';
    // The freshness line says when and why (lab companion CSp): the Machine's own presence owner
    // first, else the canonical Session status. Retry re-reads the owner that decided the cause.
    const machineCause = offline && Boolean(props.machineName);
    const freshnessReason = machineCause
        ? t('sessionCompanion.freshness.machineOffline', { machine: props.machineName ?? '' })
        : model.status?.state === 'disconnected' || model.status?.state === 'recoverable_unservable'
            ? t('sessionCompanion.freshness.sessionDisconnected')
            : t('sessionCompanion.freshness.waitingForUpdates');
    const freshnessAsOf = machineCause ? machineLastSeenAt ?? model.asOfMs ?? null : model.asOfMs ?? null;
    const [retrying, setRetrying] = React.useState(false);
    const retryServerId = props.serverId ?? props.session?.serverId ?? undefined;
    const retryFreshness = React.useCallback(() => {
        if (retrying) return;
        setRetrying(true);
        const refresh = machineCause
            ? sync.refreshMachines(retryServerId ? { serverId: retryServerId } : undefined)
            : sync.refreshSessions();
        fireAndForget(refresh.finally(() => setRetrying(false)), { tag: 'SessionSummaryCard.retryFreshness' });
    }, [machineCause, retryServerId, retrying]);

    return (
        <SurfaceFreshnessLine
            testID={props.testID}
            asOf={freshnessAsOf}
            reason={freshnessReason}
            busy={retrying}
            action={{ label: t('common.retry'), onPress: retryFreshness }}
            {...(props.presentation === 'chip' ? { presentation: 'chip' as const } : {})}
        />
    );
});
