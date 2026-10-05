import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { WalkthroughReviewSlots } from '@/components/sessions/files/walkthrough/WalkthroughView';
import { WalkthroughNotice, WalkthroughNoticeButton } from '@/components/sessions/files/walkthrough/WalkthroughLifecycle';
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
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { WalkthroughFindingView } from './reviewWalkthroughOverlay';
import type { WalkthroughReviewState } from './useWalkthroughReview';
import { buildWalkthroughReviewSlots } from './walkthroughReviewSlots';

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
        if (!review || !scope) return null;
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
                    fireAndForget(decideReviewRunFinding({ scope, sessionId, runId: view.runId, commentId: comment.id, decision: next }), { tag: 'SessionWalkthroughReview.decide' });
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
        const notice = summary.state === 'partial' && summary.failedEngineLabels.length > 0 ? (
            <WalkthroughNotice
                testID="walkthrough-notice-partial-review"
                tone="danger"
                icon="x-circle"
                message={(
                    <Text style={styles.notice}>
                        <Text style={styles.noticeStrong}>{t('reviewWalkthrough.partial.failed', { engines: summary.failedEngineLabels.join(t('reviewWalkthrough.and')) })}</Text>
                        {` ${t('reviewWalkthrough.partial.notClean')}`}
                        {summary.finishedEngineLabels.length > 0
                            ? ` ${t('reviewWalkthrough.partial.finishedWith', { engines: summary.finishedEngineLabels.join(t('reviewWalkthrough.and')), count: summary.total })}`
                            : ''}
                    </Text>
                )}
                actions={onRetryReviewEngines && summary.failedEngineIds.length > 0 ? (
                    <WalkthroughNoticeButton
                        testID="walkthrough-retry-review-engine"
                        icon="arrows-clockwise"
                        label={t('reviewWalkthrough.partial.retry', { engine: summary.failedEngineLabels.join(t('reviewWalkthrough.and')) })}
                        onPress={() => onRetryReviewEngines(summary.failedEngineIds)}
                    />
                ) : undefined}
            />
        ) : null;
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
    }, [modelId, onAskStop, onRetryReviewEngines, phase, phone, renderTriage, review, severityColors]);
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
    notice: { fontSize: 13.5, lineHeight: 19, color: theme.colors.text.secondary, ...Typography.default() },
    noticeStrong: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
    explaining: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        height: 34,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    explainingText: { fontSize: 14, color: theme.colors.text.primary, ...Typography.default('semiBold') },
}));
