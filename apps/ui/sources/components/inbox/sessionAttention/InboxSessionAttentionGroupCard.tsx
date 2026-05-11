import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

import { useMachine } from '@/sync/domains/state/storage';
import { readDisplayMachineIdForSession, readDisplayPathForSession } from '@/sync/ops/sessionMachineTarget';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome, getSessionName } from '@/utils/sessions/sessionUtils';
import { InboxSessionAttentionHeader } from './InboxSessionAttentionHeader';

export const InboxSessionAttentionGroupCard = React.memo(function InboxSessionAttentionGroupCard(props: Readonly<{
    session: Session;
    permissionRequests: readonly PendingPermissionRequest[];
    userActionRequests: readonly PendingPermissionRequest[];
}>) {
    const router = useRouter();
    const machineId = readDisplayMachineIdForSession({
        sessionId: props.session.id,
        metadata: props.session.metadata ?? null,
    });
    const machine = useMachine(machineId);
    const displayPath = readDisplayPathForSession({
        sessionId: props.session.id,
        metadata: props.session.metadata ?? null,
    });
    const transcriptInteraction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: props.session.accessLevel,
            canApprovePermissions: props.session.canApprovePermissions,
            active: props.session.active,
            presence: props.session.presence,
        });
    }, [props.session.accessLevel, props.session.canApprovePermissions, props.session.active, props.session.presence]);

    if (
        transcriptInteraction.permissionDisabledReason === 'inactive' &&
        (props.permissionRequests.length > 0 || props.userActionRequests.length > 0)
    ) {
        return null;
    }

    return (
        <View testID={`inbox.session_attention.${props.session.id}`} style={styles.container}>
            <InboxSessionAttentionHeader
                sessionTitle={getSessionName(props.session)}
                machineLabel={getMachineDisplayName(machine)}
                pathLabel={displayPath ? formatPathRelativeToHome(displayPath, props.session.metadata?.homeDir ?? undefined) : null}
                onOpenSession={() => router.push(`/session/${props.session.id}`)}
            />

            <View style={styles.items}>
                {props.permissionRequests.map((request) => (
                    <PermissionPromptCard
                        key={request.id}
                        request={request}
                        location={null}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        canApprovePermissions={transcriptInteraction.canApprovePermissions}
                        disabledReason={transcriptInteraction.permissionDisabledReason}
                    />
                ))}

                {props.userActionRequests.map((request) => (
                    <UserActionPromptCard
                        key={request.id}
                        request={request}
                        location={null}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        canApprovePermissions={transcriptInteraction.canApprovePermissions}
                        disabledReason={transcriptInteraction.permissionDisabledReason}
                    />
                ))}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        overflow: 'hidden',
    },
    items: {
        gap: 12,
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
}));
