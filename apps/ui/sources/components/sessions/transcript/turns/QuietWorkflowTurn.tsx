import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import type { Message } from '@happier-dev/session-core/messages';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { t } from '@/text';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { WorkflowMessageProvenanceAttribution, formatTranscriptMessageTimestamp } from '../MessageView';
import { resolveTranscriptMessageDisplayText } from '../messageDisplayText';
import { useTranscriptRowLayoutMutation } from '../measurement/TranscriptRowLayoutMutationContext';
import { readWorkflowTurnProvenance } from '../turnGrouping/workflowTranscriptTurns';

/** Presentation of a producer-observed quiet turn, not a notification classifier. */
export const QuietWorkflowTurn = React.memo(function QuietWorkflowTurn(props: Readonly<{
    turnId: string;
    userMessage: Message;
    messages: readonly Message[];
    serverId?: string | null;
    children: React.ReactNode;
    reducedMotion?: boolean;
}>) {
    const [expanded, setExpanded] = React.useState(false);
    const { theme } = useUnistyles();
    const notifyLayoutMutation = useTranscriptRowLayoutMutation();
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const provenance = readWorkflowTurnProvenance(props.userMessage);
    const reply = props.messages.find((message) => message.kind === 'agent-text' && !message.isThinking);
    const firstLine = reply?.kind === 'agent-text'
        ? (resolveTranscriptMessageDisplayText(reply).text ?? '').split(/\r?\n/, 1)[0] : '';
    const createdAt = reply?.createdAt ?? props.userMessage.createdAt;
    const timestamp = formatTranscriptMessageTimestamp(createdAt);
    const time = timestamp ? formatWithCachedDateTimeFormatter(new Date(createdAt), undefined, { timeStyle: 'short' }) : null;
    const changeExpanded = React.useCallback((next: boolean) => {
        notifyLayoutMutation({ reason: next ? 'expand' : 'collapse', sourceId: props.turnId });
        setExpanded(next);
    }, [notifyLayoutMutation, props.turnId]);
    if (!provenance) return props.children;

    return <View style={[styles.container, maxWidthStyle]}>
        <ExpandableItem expanded={expanded} onExpandedChange={changeExpanded} showDivider={false}
            reducedMotion={props.reducedMotion} testID={`quiet-workflow-turn:${props.turnId}`}
            header={({ expanded: isExpanded, headerProps }) => <View style={styles.header}>
                <View style={styles.provenance}>
                    <WorkflowMessageProvenanceAttribution messageId={props.userMessage.id} {...provenance}
                        serverId={props.serverId} inline />
                </View>
                <HappierPressable {...headerProps} expanded={isExpanded} style={({ pressed, focused }) => [styles.toggle,
                    pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                    focusRingStyle({ focused, color: theme.colors.border.focus })]}
                    testID={`quiet-workflow-turn-toggle:${props.turnId}`}
                    accessibilityLabel={`${t(isExpanded ? 'common.collapse' : 'common.expand')}: ${firstLine || t('message.provenanceWorkflow')}`}>
                    <Text numberOfLines={1} ellipsizeMode="tail" style={styles.summary}>{firstLine}</Text>
                    {time ? <Text numberOfLines={1} style={styles.time} accessibilityLabel={timestamp ?? undefined}>{time}</Text> : null}
                    <DisclosureCaret expanded={isExpanded} />
                </HappierPressable>
            </View>}>
            {props.children}
        </ExpandableItem>
    </View>;
});

const styles = StyleSheet.create((theme) => ({
    container: { width: '100%', alignSelf: 'center' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.s8,
        paddingHorizontal: theme.space.s16, minHeight: HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE },
    provenance: { maxWidth: '55%', minWidth: 0, flexShrink: 1 },
    toggle: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8,
        minHeight: HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE, flexShrink: 1, minWidth: 0 },
    summary: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1, minWidth: 0 },
    time: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, flexShrink: 0 },
}));
