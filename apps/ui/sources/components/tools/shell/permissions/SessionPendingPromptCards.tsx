import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { buildSessionMessageRouteId } from '@happier-dev/session-core/messages';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { PendingNavigationSettledNotice } from '@/components/sessions/pendingNavigation/PendingNavigationSettledNotice';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';

const EMPTY_LOCATIONS: ReadonlyMap<string, PermissionToolCallMessageLocation | null> = new Map();

const stylesheet = StyleSheet.create(() => ({
    prompts: {
        gap: 4,
    },
}));

/**
 * A Session's waiting prompts drawn through the canonical prompt owners — the same Allow / Deny and
 * answer controls the composer and the Inbox show, deciding through the session's own approval
 * custody. Hosts choose which requests to show (a subagent's, the Voice conversation's); nothing here
 * answers a prompt any other way.
 */
export const SessionPendingPromptCards = React.memo(function SessionPendingPromptCards(props: Readonly<{
    testID: string;
    sessionId: string;
    serverId?: string | null;
    session: Session;
    permissions: readonly PendingPermissionRequest[];
    userActions: readonly PendingPermissionRequest[];
    chrome?: 'card' | 'inline';
}>) {
    const styles = stylesheet;
    const { session } = props;
    const metadata = React.useMemo(() => readSessionOwnerMetadataView(session), [session]);
    const interaction = React.useMemo(() => deriveTranscriptInteractionFromSession({
        access: session.access,
        active: session.active,
        presence: session.presence,
    }), [session.access, session.active, session.presence]);
    const serverId = props.serverId ?? undefined;
    const source = useSessionTranscriptSource();
    const messageIdsOldestFirst = source.useMessageIdsOldestFirst();
    const messagesById = source.useMessagesById();
    const reducerState = source.useReducerState();
    const locations = React.useMemo(() => {
        if (source.sessionId !== props.sessionId || (serverId !== undefined && source.serverId !== serverId)) return EMPTY_LOCATIONS;
        return resolvePermissionToolCallLocations({
            permissionIds: [...props.permissions, ...props.userActions].map((request) => request.id),
            messageIdsOldestFirst,
            messagesById,
            toolIdToMessageId: reducerState?.toolIdToMessageId,
            resolveRouteMessageId: (messageId) => buildSessionMessageRouteId({ messageId, messagesById, reducerState }),
        });
    }, [messageIdsOldestFirst, messagesById, props.permissions, props.sessionId, props.userActions, reducerState, serverId, source]);
    const address = normalizeSessionAddress(serverId ?? source.serverId, props.sessionId);
    const chrome = props.chrome ?? 'inline';
    return (
        <View testID={props.testID} style={styles.prompts}>
            <PendingNavigationSettledNotice address={address} />
            {props.permissions.map((request) => (
                <PermissionPromptCard
                    key={request.id}
                    chrome={chrome}
                    request={request}
                    location={locations.get(request.id) ?? null}
                    sessionId={props.sessionId}
                    serverId={serverId}
                    metadata={metadata}
                    canApprovePermissions={interaction.canApprovePermissions}
                    disabledReason={interaction.permissionDisabledReason}
                />
            ))}
            {props.userActions.map((request) => (
                <UserActionPromptCard
                    key={request.id}
                    chrome={chrome}
                    session={session}
                    request={request}
                    location={locations.get(request.id) ?? null}
                    sessionId={props.sessionId}
                    serverId={serverId}
                    metadata={metadata}
                    canApprovePermissions={interaction.canApprovePermissions}
                    disabledReason={interaction.permissionDisabledReason}
                />
            ))}
        </View>
    );
});
