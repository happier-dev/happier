import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { WalkthroughReviewSlots } from '@/components/sessions/files/walkthrough/WalkthroughView';
import { SessionAgentPendingPrompts } from '@/components/sessions/agents/list/SessionAgentPendingPrompts';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { WalkthroughPhase } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { ReviewFindingDecisionControl, type ReviewFindingDecision } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import { findCommentForFinding, readReviewFindingDecision } from '@/components/sessions/reviews/findings/reviewFindingComment';
import { useReviewSeverityColorResolver } from '@/components/sessions/reviews/findings/useReviewSeverityColors';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { decideReviewRunFinding } from '@/sync/domains/reviews/comments/reviewRunComments';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSession } from '@/sync/domains/state/storage';
import { useSessionAgentActivityRoster } from '@/hooks/session/useSessionAgentActivity';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { WalkthroughFindingView } from './reviewWalkthroughOverlay';
import type { WalkthroughReviewState } from './useWalkthroughReview';
import { buildWalkthroughReviewSlots } from './walkthroughReviewSlots';

/** Read the shared attention projection; opening uses the Session's existing answer controls. */
function WalkthroughReviewPendingInputs(props: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    runIds: readonly string[];
}>) {
    const session = useSession(props.sessionId, props.scope.serverId);
    const activity = useSessionAgentActivityRoster({ sessionId: props.sessionId, serverId: props.scope.serverId, session });
    const [openRunId, setOpenRunId] = React.useState<string | null>(null);
    return <>{props.runIds.map((runId) => {
        const entry = activity.readExecutionRunEntry(runId);
        const subagent = entry ? activity.readSubagentForEntry(entry.id) : null;
        const presentation = entry ? resolveSessionAgentActivityPresentation({ entry, subagent }) : null;
        if (!subagent || !presentation?.attention) return null;
        return <React.Fragment key={runId}>
            <AttentionBanner presentation="strip" testID={`walkthrough-review-needs-you:${runId}`} tone="warning" iconName="chat-circle-dots"
                title={`${presentation.title} · ${presentation.attention.description}`}
                action={{ testID: `walkthrough-review-open-question:${runId}`, label: t('common.open'), onPress: () => setOpenRunId(runId) }} />
            {openRunId === runId ? <AppSessionTranscriptSourceProvider sessionId={props.sessionId} serverId={props.scope.serverId} navigation="none">
                <SessionAgentPendingPrompts sessionId={props.sessionId} serverId={props.scope.serverId}
                    session={session} subagent={subagent} fallback={null} />
            </AppSessionTranscriptSourceProvider> : null}
        </React.Fragment>;
    })}</>;
}

/**
 * A Session walkthrough's review, drawn (Walkthrough lab WT5): the slots the reading view shows, the
 * Generated marker that names who wrote it and how, the partial-review band, and the triage of each
 * finding through its durable review comment (the same decision owner as the review card).
 */
export function useSessionWalkthroughReviewPresentation(params: Readonly<{
    review: WalkthroughReviewState | null;
    phase: WalkthroughPhase;
    phone: boolean;
    onAskStop?: ((stopId: string) => void) | null;
    scope: ServerAccountScope | null;
    sessionId: string;
    onRetryReviewEngines?: ((engineIds: readonly string[]) => void) | null;
    /** The model that wrote the walkthrough ("Opus 5.5"), as the result's producer names it. */
    modelId?: string | null;
}>): Readonly<{ slots: WalkthroughReviewSlots; generatedLabel: string | null }> | null {
    const { review, phase, phone, scope, sessionId, onRetryReviewEngines, onAskStop, modelId } = params;
    const severityColors = useReviewSeverityColorResolver();
    const renderTriage = React.useCallback((view: WalkthroughFindingView) => {
        if (!review || !scope || !sessionId) return null;
        const snapshot = review.comments[review.reviewRunIds.indexOf(view.runId)];
        const comment = snapshot ? findCommentForFinding(snapshot.comments, view.finding, view.runId) : null;
        const decision = comment ? readReviewFindingDecision(snapshot?.pending[comment.id] ?? comment.reviewTriageStatus) : 'undecided';
        return (
            <ReviewFindingDecisionControl
                testIDPrefix={`walkthrough-finding-triage:${view.findingId}`}
                decision={decision}
                disabled={!comment}
                onDecide={(next: ReviewFindingDecision) => {
                    if (!comment) return;
                    fireAndForget(decideReviewRunFinding({ scope, sessionId, runId: view.runId,
                        ...(comment.reviewId ? { reviewId: comment.reviewId } : {}), commentId: comment.id, decision: next }), { tag: 'SessionWalkthroughReview.decide' });
                }}
            />
        );
    }, [review, scope, sessionId]);
    return React.useMemo(() => {
        if (!review) return null;
        const summary = review.overlay.summary;
        const writing = phase === 'inventory' || phase === 'arriving';
        const reviewedAt = review.reviewedAtMs ? formatAsOfTime(review.reviewedAtMs) : null;
        const seeded = review.narrationMode === 'seeded_narrator';
        const reviewers = summary.engineLabels.join(t('reviewWalkthrough.and'));
        const readNotice = summary.state === 'unavailable' ? (
            <AttentionBanner presentation="strip" testID="walkthrough-review-read-unavailable" tone="warning"
                title={t('common.requestFailed')}
                action={{ testID: 'walkthrough-review-read-retry', label: t('common.retry'),
                    onPress: () => { fireAndForget(review.retry(), { tag: 'SessionWalkthroughReview.retry' }); } }} />
        ) : summary.state === 'partial' && summary.failedEngineLabels.length > 0 ? (
            <AttentionBanner
                presentation="strip"
                testID="walkthrough-notice-partial-review"
                tone="danger"
                title={t('reviewWalkthrough.partial.failed', { engines: summary.failedEngineLabels.join(t('reviewWalkthrough.and')) })}
                description={t('reviewWalkthrough.partial.notClean') + (summary.finishedEngineLabels.length > 0
                    ? ` ${t('reviewWalkthrough.partial.finishedWith', { engines: summary.finishedEngineLabels.join(t('reviewWalkthrough.and')), count: summary.total })}`
                    : '')}
                action={onRetryReviewEngines && summary.failedEngineIds.length > 0 ? {
                    testID: 'walkthrough-retry-review-engine',
                    icon: 'arrows-clockwise',
                    label: t('reviewWalkthrough.partial.retry', { engine: summary.failedEngineLabels.join(t('reviewWalkthrough.and')) }),
                    onPress: () => onRetryReviewEngines(summary.failedEngineIds),
                } : null}
            />
        ) : null;
        const notice = <>
            {scope && sessionId ? <WalkthroughReviewPendingInputs scope={scope} sessionId={sessionId} runIds={review.reviewRunIds} /> : null}
            {readNotice}
        </>;
        const findingsOnlyHandover = review.progress.narration?.kind === 'narrator_writing' ? review.progress.narration.narrator : null;
        const slots = buildWalkthroughReviewSlots({
            overlay: review.overlay,
            phone,
            findingsFirst: writing && summary.state !== 'running'
                ? { publishedAt: reviewedAt, engineLabel: findingsOnlyHandover ? summary.engineLabels[0] ?? null : null }
                : null,
            factVariant: seeded && reviewedAt ? { kind: 'from_review', at: reviewedAt } : null,
            // How many files changed since the review is not published; the stale band says that they did.
            seededNote: seeded && reviewedAt ? { reviewers, at: reviewedAt, changedFiles: 0 } : null,
            notice,
            writing,
            renderTriage,
            severityColors,
            onAskStop: onAskStop ?? null,
            showKeys: !phone,
        });
        // Generated names who wrote it and how: from the review's findings, or a narrator after a findings-only engine.
        const generatedLabel = !modelId ? null
            : seeded ? t('reviewWalkthrough.generated.seeded', { model: modelId })
                : findingsOnlyHandover && summary.engineLabels[0] ? t('reviewWalkthrough.generated.handover', { narrator: modelId, engine: summary.engineLabels[0] })
                    : null;
        return { slots, generatedLabel };
    }, [modelId, onAskStop, onRetryReviewEngines, phase, phone, renderTriage, review, scope, sessionId, severityColors]);
}

/**
 * Explain the findings: the explicit request for an explanation, never made by itself (lab WT5-R2).
 * While it runs the control becomes its own status ("Explaining the findings"), not an empty spinner.
 */
export function ReviewExplainFindingsButton(props: Readonly<{ running: boolean; onPress: () => void }>) {
    const { theme } = useUnistyles();
    if (props.running) {
        return (
            <View testID="walkthrough-explaining-findings" accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.explaining}>
                <Icon name="sparkle" size={ICON_SIZE.xs} color={theme.colors.text.primary} />
                <Text style={styles.explainingText}>{t('reviewWalkthrough.explain.running')}</Text>
            </View>
        );
    }
    return (
        <RoundButton
            testID="walkthrough-explain-findings"
            size="small"
            display="secondary"
            title={t('reviewWalkthrough.explain.action')}
            accessibilityLabel={t('reviewWalkthrough.explain.a11y')}
            leading={<Icon name="sparkle" size={ICON_SIZE.xs} color={theme.colors.text.primary} />}
            onPress={props.onPress}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    explaining: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        height: 34,
        paddingHorizontal: theme.space.s12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    explainingText: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary,  },
}));
