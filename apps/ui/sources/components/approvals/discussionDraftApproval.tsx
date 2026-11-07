import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { DiscussionTextMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { isSessionDiscussionApprovalPublicationV1, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * The one reading of an agent's private Discussion draft awaiting its decision: wherever the approval is
 * decided (the Discussion thread, the Session's transcript and tray, the request page) it is the answer the
 * person would post, decided as Post or Decline, with the Action's operands behind Details.
 */
export type DiscussionDraftApproval = Readonly<{
    /** The text the draft would post; null when the request carries no reply text (its fields then show as-is). */
    answer: string | null;
    postLabel: string;
    declineLabel: string;
}>;

/** Null when the request is not a Discussion publication. */
export function readDiscussionDraftApproval(request: ApprovalRequest): DiscussionDraftApproval | null {
    if (!isSessionDiscussionApprovalPublicationV1(request)) return null;
    return {
        answer: readDraftAnswerText(request.actionArgs),
        postLabel: t('session.collaboration.discussion.draftReview.post'),
        declineLabel: t('session.collaboration.discussion.draftReview.decline'),
    };
}

function readDraftAnswerText(actionArgs: unknown): string | null {
    const content = typeof actionArgs === 'object' && actionArgs !== null && 'content' in actionArgs
        ? DiscussionTextMessageContentV1Schema.safeParse(actionArgs.content) : null;
    const text = content?.success
        ? content.data.parts.flatMap(part => part.t === 'text' ? [part.text] : []).join('').trim() : '';
    return text.length > 0 ? text : null;
}

/** The draft as the answer it would post, with the one quiet line saying who sees it. */
export function DiscussionDraftAnswer(props: Readonly<{ testID: string; answer: string }>) {
    return (
        <View style={styles.draft}>
            <Text testID={props.testID} variant="reading" style={styles.answer} selectable>{props.answer}</Text>
            <Text variant="meta" style={styles.private}>{t('session.collaboration.discussion.draftReview.onlyYou')}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    draft: { gap: theme.space.s8, paddingBottom: theme.space.s8 },
    answer: { color: theme.colors.text.primary },
    private: { color: theme.colors.text.secondary },
}));
