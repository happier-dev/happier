import type { DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/references';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useDiscussionTitles } from '@/components/discussions/useDiscussionTitles';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { ExecutionRunContextChip } from '@/components/sessions/runs/ExecutionRunContextChip';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        gap: theme.space.s16,
    },
    lead: {
        alignItems: 'center',
        gap: theme.space.s8,
        paddingTop: theme.space.s8,
        paddingHorizontal: theme.space.s16,
    },
    title: {
        color: theme.colors.text.primary,
        ...Typography.variant('heading'),
        textAlign: 'center',
    },
    body: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
        textAlign: 'center',
        maxWidth: 380,
    },
}));

/**
 * The Ask Agent draft's lead: what is about to happen, then the selected messages as the draft's
 * context chip ("From Relay retry plan · 2 messages"). The real composer follows it; nothing runs
 * until the person sends.
 */
export const ExecutionRunDraftSelectionContext = React.memo((props: Readonly<{
    sessionId: string | null;
    serverId: string | null;
    origin: DiscussionSelectionSourceV1;
    contextText: string;
    agentId: string | null;
}>) => {
    const styles = stylesheet;
    useUnistyles();
    const address = React.useMemo(() => ({ serverId: props.origin.serverId }), [props.origin.serverId]);
    const discussionIds = React.useMemo(() => [props.origin.discussionId], [props.origin.discussionId]);
    const titles = useDiscussionTitles({ address, discussionIds });
    return (
        <View testID="execution-run-draft-context" style={styles.root}>
            <View style={styles.lead}>
                <ExecutionRunAgentMark agentId={props.agentId} size={44} />
                <Text accessibilityRole="header" style={styles.title}>{t('sessionConversation.draft.leadTitle')}</Text>
                <Text style={styles.body}>{t('sessionConversation.draft.leadBody')}</Text>
            </View>
            <ExecutionRunContextChip
                testID="execution-run-draft-context-chip"
                title={titles.get(props.origin.discussionId) ?? null}
                messageCount={props.origin.messageIds.length}
                quote={props.contextText}
            />
        </View>
    );
});
