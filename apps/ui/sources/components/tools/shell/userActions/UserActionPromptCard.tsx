import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';

import { Text } from '@/components/ui/text/Text';
import { ToolInlineBody } from '@/components/tools/shell/views/ToolInlineBody';
import { buildPermissionPromptModel } from '@/components/tools/shell/permissions/presentation/buildPermissionPromptModel';
import { t } from '@/text';

export const UserActionPromptCard = React.memo(function UserActionPromptCard(props: {
    request: PendingPermissionRequest;
    location: PermissionToolCallMessageLocation | null;
    sessionId: string;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    chrome?: 'card' | 'inline';
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const chrome = props.chrome ?? 'card';

    const model = React.useMemo(() => {
        return buildPermissionPromptModel({ request: props.request, metadata: props.metadata, nowMs: Date.now() });
    }, [props.metadata, props.request]);
    const headerText = model.headerText;
    const [headerActions, setHeaderActions] = React.useState<React.ReactNode | null>(null);

    if (props.canApprovePermissions === false && props.disabledReason === 'inactive') {
        return null;
    }

    const onViewTool = React.useCallback(() => {
        router.push(buildPermissionToolCallRoute({ sessionId: props.sessionId, location: props.location }));
    }, [props.location, props.sessionId, router]);
    const canOpenToolRoute = canOpenPermissionToolCallRoute(props.location);

    return (
        <View testID="user-action-prompt-card" style={[styles.container, chrome === 'inline' ? styles.containerInline : null]}>
            <View style={styles.header}>
                <View style={styles.icon}>
                    <Ionicons name="chatbubble-ellipses-outline" size={16} color={theme.colors.state.neutral.foreground} />
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
                        <Ionicons name="open-outline" size={18} color={theme.colors.text.secondary} />
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
                    interaction={{
                        canSendMessages: false,
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
