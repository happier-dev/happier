import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';

import { Text } from '@/components/ui/text/Text';
import { ToolInlineBody } from '@/components/tools/shell/views/ToolInlineBody';
import { buildPermissionPromptModel } from '@/components/tools/shell/permissions/presentation/buildPermissionPromptModel';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import type { PromptResponseOrigin } from '@/components/tools/shell/permissions/executionRunPromptResponseTarget';
import {
    SessionActionConfirmationPromptCard,
} from './SessionActionConfirmationPromptCard';
import { isSessionActionConfirmationRequest } from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

type UserActionPromptCardProps = PromptResponseOrigin & Readonly<{
    request: PendingPermissionRequest;
    location: PermissionToolCallMessageLocation | null;
    serverId?: string;
    session?: Session;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    chrome?: 'card' | 'inline';
}>;

const GenericUserActionPromptCard = React.memo(function GenericUserActionPromptCard(props: UserActionPromptCardProps) {
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const sourceInteraction = transcriptSource.useInteraction();
    const chrome = props.chrome ?? 'card';

    const model = React.useMemo(() => {
        return buildPermissionPromptModel({ request: props.request, metadata: props.metadata, nowMs: Date.now() });
    }, [props.metadata, props.request]);
    const headerText = model.headerText;
    const [headerActions, setHeaderActions] = React.useState<React.ReactNode | null>(null);

    const onViewTool = React.useCallback(() => {
        if (props.sessionId === undefined) return;
        transcriptSource.navigate?.(buildPermissionToolCallRoute({ sessionId: props.sessionId, serverId: props.serverId, location: props.location }));
    }, [props.location, props.sessionId, props.serverId, transcriptSource]);
    // A tool-call route is a Session transcript location; an Execution Run has none.
    const canOpenToolRoute = transcriptSource.navigate !== null && props.sessionId !== undefined && canOpenPermissionToolCallRoute(props.location);

    // Hooks are declared unconditionally above this point: a card that renders
    // inactive and later activates is the same instance, so its hook count must
    // not depend on this branch.
    if (props.canApprovePermissions === false && props.disabledReason === 'inactive') {
        return null;
    }

    return (
        <View testID="user-action-prompt-card" style={[styles.container, chrome === 'inline' ? styles.containerInline : null]}>
            <View style={styles.header}>
                <View style={styles.icon}>
                    <Icon name="chat-circle-dots" size={16} color={theme.colors.state.neutral.foreground} />
                </View>
                <View style={styles.headerText}>
                    <Text style={styles.title} numberOfLines={1}>
                        {headerText.title}
                    </Text>
                    {headerText.subtitle ? (
                        <Text style={styles.subtitle} numberOfLines={2}>
                            {headerText.subtitle}
                        </Text>
                    ) : null}
                </View>
                {headerActions ? <View style={styles.headerActions}>{headerActions}</View> : null}
                {canOpenToolRoute ? (
                    <Pressable
                        testID="user-action-prompt-view-tool"
                        onPress={onViewTool}
                        accessibilityRole="button"
                        accessibilityLabel={t('toolView.open')}
                        style={({ pressed }) => [styles.viewButton, pressed && styles.viewButtonPressed]}
                    >
                        <Icon name="arrow-square-out" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
            </View>

            <View style={styles.preview}>
                <ToolInlineBody
                    mode="timeline"
                    tool={model.tool}
                    normalizedToolName={headerText.normalizedToolName}
                    metadata={props.metadata}
                    messages={[]}
                    sessionId={props.sessionId}
                    serverId={props.serverId}
                    session={props.session}
                    executionRun={props.executionRun}
                    interaction={{
                        canSendMessages: sourceInteraction.canSendMessages,
                        canApprovePermissions: props.canApprovePermissions,
                        permissionDisabledReason: props.disabledReason,
                    }}
                    detailLevel="full"
                    setHeaderActions={setHeaderActions}
                />
            </View>
        </View>
    );
});

export const UserActionPromptCard = React.memo(function UserActionPromptCard(props: UserActionPromptCardProps) {
    // A Session Action confirmation is answered by its Session; it has no Execution Run form.
    if (props.sessionId !== undefined && isSessionActionConfirmationRequest(props.request)) {
        return (
            <SessionActionConfirmationPromptCard
                request={props.request}
                sessionId={props.sessionId}
                serverId={props.serverId}
                canApprovePermissions={props.canApprovePermissions}
                disabledReason={props.disabledReason}
                chrome={props.chrome}
            />
        );
    }
    return <GenericUserActionPromptCard {...props} />;
});

const styles = StyleSheet.create((theme) => ({
    container: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        overflow: 'hidden',
    },
    containerInline: {
        borderRadius: 0,
        borderWidth: 0,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 10,
    },
    icon: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    title: {
        fontSize: 13,
        fontWeight: '700',
        color: theme.colors.text.primary,
    },
    subtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    viewButton: {
        padding: 6,
        borderRadius: 8,
    },
    viewButtonPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    preview: {
        paddingHorizontal: 12,
        paddingBottom: 12,
    },
}));
