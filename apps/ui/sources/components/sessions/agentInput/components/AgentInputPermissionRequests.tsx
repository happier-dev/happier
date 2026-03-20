import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { Typography } from '@/constants/Typography';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

const stylesheet = StyleSheet.create((theme) => ({
    permissionRequestsContainer: {
        paddingTop: 10,
        gap: 8,
    },
    permissionRequestTitle: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    permissionRequestCard: {
        overflow: 'hidden',
    },
}));

export const AgentInputPermissionRequests = React.memo(function AgentInputPermissionRequests(props: Readonly<{
    sessionId: string;
    permissionRequests: readonly PendingPermissionRequest[];
    userActionRequests: readonly PendingPermissionRequest[];
    permissionLocationsById: ReadonlyMap<string, PermissionToolCallMessageLocation | null>;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    maxHeightPx: number;
    clampedHeightPx: number;
    onContentSizeChange: (width: number, height: number) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    fadeVisibility?: Readonly<{ top?: boolean; bottom?: boolean }>;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (props.permissionRequests.length === 0 && props.userActionRequests.length === 0) {
        return null;
    }

    return (
        <View style={styles.permissionRequestsContainer}>
            <View style={{ position: 'relative' }}>
                <ScrollView
                    testID="agentInput.permissionRequests.scroll"
                    style={{ maxHeight: props.maxHeightPx, height: props.clampedHeightPx }}
                    contentContainerStyle={{ paddingBottom: 2 }}
                    nestedScrollEnabled={true}
                    scrollEventThrottle={16}
                    showsVerticalScrollIndicator={false}
                    onContentSizeChange={props.onContentSizeChange}
                    onLayout={props.onLayout}
                    onScroll={props.onScroll}
                >
                    <View style={{ gap: 8, paddingTop: 2 }}>
                        {props.permissionRequests.map((req) => (
                            <View key={req.id} style={styles.permissionRequestCard}>
                                <PermissionPromptCard
                                    request={req}
                                    location={props.permissionLocationsById.get(req.id) ?? null}
                                    sessionId={props.sessionId}
                                    metadata={props.metadata}
                                    canApprovePermissions={props.canApprovePermissions}
                                    disabledReason={props.disabledReason}
                                />
                            </View>
                        ))}
                        {props.userActionRequests.map((req) => (
                            <View key={req.id} style={styles.permissionRequestCard}>
                                <UserActionPromptCard
                                    request={req}
                                    location={props.permissionLocationsById.get(req.id) ?? null}
                                    sessionId={props.sessionId}
                                    metadata={props.metadata}
                                    canApprovePermissions={props.canApprovePermissions}
                                    disabledReason={props.disabledReason}
                                />
                            </View>
                        ))}
                    </View>
                </ScrollView>

                <ScrollEdgeFades
                    color={theme.colors.input.background}
                    edges={{
                        top: props.fadeVisibility?.top === true,
                        bottom: props.fadeVisibility?.bottom === true,
                    }}
                />
                <ScrollEdgeIndicators
                    color={theme.colors.textSecondary}
                    edges={{
                        top: props.fadeVisibility?.top === true,
                        bottom: props.fadeVisibility?.bottom === true,
                    }}
                />
            </View>
        </View>
    );
});
