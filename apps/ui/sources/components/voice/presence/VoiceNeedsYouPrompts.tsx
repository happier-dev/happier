import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionPendingPromptCards } from '@/components/tools/shell/permissions/SessionPendingPromptCards';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSession, useSessionMessages } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { listPendingPermissionRequests, listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';

/**
 * One exact session's waiting requests (permission and user-action prompts), through the canonical
 * request readers. `prompts` is null while there is nothing to decide.
 */
export function useSessionPendingPrompts(address: SessionAddress) {
    const session = useSession(address.sessionId, address.serverId);
    const { messages } = useSessionMessages(address.sessionId);
    const prompts = React.useMemo(() => {
        if (!session) return null;
        const permissions = listPendingPermissionRequests(session, messages);
        const userActions = listPendingUserActionRequests(session, messages);
        return permissions.length + userActions.length > 0 ? { permissions, userActions } : null;
    }, [messages, session]);
    return { session, prompts };
}

/**
 * Needs you, in the Voice section (lab `voice-moments` N1): the conversation's waiting requests as the
 * real request cards, decided by a tap through the session's own approval custody. Voice may read
 * a request aloud; nothing it hears can decide one (VI-04), and the quiet line under the cards says so.
 *
 * Mounted only while the attempt projection reports Needs you for its exact conversation, so the
 * session's messages are read only while there is something to decide.
 */
export const VoiceNeedsYouPrompts = React.memo(function VoiceNeedsYouPrompts(props: Readonly<{
    address: SessionAddress;
    testID: string;
}>) {
    const styles = stylesheet;
    const { session, prompts } = useSessionPendingPrompts(props.address);
    if (!session || !prompts) return null;
    return (
        <View style={styles.root}>
            <SessionPendingPromptCards
                testID={props.testID}
                sessionId={props.address.sessionId}
                serverId={props.address.serverId}
                session={session}
                permissions={prompts.permissions}
                userActions={prompts.userActions}
                chrome="card"
            />
            <Text style={styles.note}>{t('voiceMoments.needsYouTapToDecide')}</Text>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        gap: 6,
    },
    note: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        paddingHorizontal: 2,
    },
}));
