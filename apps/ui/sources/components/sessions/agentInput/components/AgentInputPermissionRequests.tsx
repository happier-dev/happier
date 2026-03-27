import * as React from 'react';
import { Platform, ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
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
        // Cancel out AgentInput's `unifiedPanel` padding so this block can go edge-to-edge.
        marginHorizontal: -8,
        // Cancel out the panel's top padding so the chrome reaches the top edge.
        marginTop: -2,
    },
    permissionRequestTitle: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    chrome: {
        borderTopLeftRadius: Platform.select({ default: 16, android: 20 }),
        borderTopRightRadius: Platform.select({ default: 16, android: 20 }),
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
        overflow: 'hidden',
    },
    divider: {
        height: 1,
        backgroundColor: theme.colors.divider,
        opacity: 1,
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

    const permissionRequests = props.disabledReason === 'inactive' ? [] : props.permissionRequests;

    if (permissionRequests.length === 0 && props.userActionRequests.length === 0) {
        return null;
    }

    const rows = [
        ...permissionRequests.map((req) => ({ kind: 'permission' as const, req })),
        ...props.userActionRequests.map((req) => ({ kind: 'userAction' as const, req })),
    ];

    return (
        <View style={styles.permissionRequestsContainer}>
            <View testID="agentInput.permissionRequests.chrome" style={styles.chrome}>
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
                        <View style={{ paddingTop: 0 }}>
                            {rows.map(({ kind, req }, index) => (
                                <React.Fragment key={req.id}>
                                    {index > 0 ? (
                                        <View
                                            testID={`agentInput.permissionRequests.divider:${req.id}`}
                                            style={styles.divider}
                                        />
                                    ) : null}
                                    {kind === 'permission' ? (
                                        <PermissionPromptCard
                                            chrome="inline"
                                            request={req}
                                            location={props.permissionLocationsById.get(req.id) ?? null}
                                            sessionId={props.sessionId}
                                            metadata={props.metadata}
                                            canApprovePermissions={props.canApprovePermissions}
                                            disabledReason={props.disabledReason}
                                        />
                                    ) : (
                                        <UserActionPromptCard
                                            chrome="inline"
                                            request={req}
                                            location={props.permissionLocationsById.get(req.id) ?? null}
                                            sessionId={props.sessionId}
                                            metadata={props.metadata}
                                            canApprovePermissions={props.canApprovePermissions}
                                            disabledReason={props.disabledReason}
                                        />
                                    )}
                                </React.Fragment>
                            ))}
                        </View>
                    </ScrollView>

                    <ScrollEdgeFades
                        color={theme.colors.surfaceHighest}
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
        </View>
    );
});
