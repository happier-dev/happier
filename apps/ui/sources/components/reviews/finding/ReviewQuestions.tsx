import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ReviewQuestion } from '@happier-dev/protocol/reviews/ReviewQuestion';

import { ReviewFollowUpComposer, type ReviewFollowUpRecipient } from '@/components/sessions/reviews/findings/ReviewFollowUpComposer';
import type { ReviewFollowUpAvailability } from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

type QuestionMember = Readonly<{ runId: string; reviewerLabel: string; followUp: ReviewFollowUpAvailability }>;
export type ReviewQuestionTarget<Member extends QuestionMember> = Readonly<{ member: Member; question: ReviewQuestion }>;

/** The same retained reviewer questions on the Run page and the native Review page. */
export function ReviewQuestions<Member extends QuestionMember>(props: Readonly<{
    questions: readonly ReviewQuestionTarget<Member>[];
    multiReviewer: boolean;
    canAct: boolean;
    onAnswer: (target: ReviewQuestionTarget<Member>) => void;
}>) {
    const { theme } = useUnistyles();
    return <>{props.questions.map(({ member, question }) => (
        <View key={`${member.runId}:${question.id}`} testID={`review-question:${question.id}`} style={styles.question}>
            <Icon name="question" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
            <View style={styles.questionBody}>
                <Text style={styles.questionEyebrow}>
                    {props.multiReviewer ? `${member.reviewerLabel} · ${t('runPage.review.reviewerAsks')}` : t('runPage.review.reviewerAsks')}
                </Text>
                <Text selectable style={styles.questionText}>
                    {question.text}
                    {props.canAct && member.followUp.available && question.status === 'open' ? <>
                        {'  '}
                        <Text testID={`review-question-answer:${question.id}`} accessibilityRole="button"
                            onPress={() => props.onAnswer({ member, question })} style={styles.inlineLinkText}>
                            {t('runPage.review.answer')}
                        </Text>
                    </> : null}
                </Text>
            </View>
        </View>
    ))}</>;
}

/** The existing reviewer reply dock; its Session address always comes from its mounted target. */
export function ReviewFollowUpDock(props: Readonly<{
    sessionId: string | null;
    serverId: string | null;
    accountLifetime: ServerAccountScopeLifetime | null;
    draftRunId: string | null;
    members: readonly Readonly<{ reviewerLabel: string }>[];
    recipient: ReviewFollowUpRecipient;
    followUp: ReviewFollowUpAvailability;
    onSend: (messageMarkdown: string) => Promise<boolean>;
}>) {
    return <View style={styles.dock}>
        {props.followUp.available ? props.sessionId ? <>
            <ReviewFollowUpComposer testID="review-findings-follow-up" sessionId={props.sessionId} serverId={props.serverId}
                accountLifetime={props.accountLifetime} draftRunId={props.draftRunId}
                placeholder={props.members.length > 1 ? t('runPage.review.askReviewersPlaceholder') : t('runPage.review.askReviewerPlaceholder')}
                recipient={props.recipient} onSend={props.onSend} />
            <Text style={styles.caption}>
                {props.members.length > 1 ? t('runPage.review.followUpsGoToAll', { count: props.members.length })
                    : t('runPage.review.followUpsGoTo', { reviewer: props.members[0]!.reviewerLabel })}
            </Text>
        </> : null : <Text testID="review-findings-follow-up-unavailable" style={styles.caption}>{props.followUp.reason}</Text>}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    question: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s10, padding: 14, borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.default },
    questionBody: { flex: 1, minWidth: 0, gap: theme.space.s4 },
    questionEyebrow: { color: theme.colors.text.secondary, ...Typography.variant('body', 'semiBold') },
    questionText: { color: theme.colors.text.primary, ...Typography.variant('reading') },
    inlineLinkText: { ...Typography.default('semiBold'), color: theme.colors.text.secondary },
    dock: { gap: theme.space.s6 },
    caption: { color: theme.colors.text.secondary, ...Typography.variant('meta') },
}));
