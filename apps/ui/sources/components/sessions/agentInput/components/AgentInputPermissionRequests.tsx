import * as React from 'react';
import { Platform, ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { ApprovalPromptCard } from '@/components/tools/shell/approvals/ApprovalPromptCard';
import { Typography } from '@/constants/Typography';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

const stylesheet = StyleSheet.create((theme) => ({
    permissionRequestsContainer: {
        // Cancel out AgentInput's `unifiedPanel` padding so this block can go edge-to-edge.
        marginHorizontal: -8,
        // Cancel out the panel's top padding so the chrome reaches the top edge.
        marginTop: -2,
    },
    permissionRequestTitle: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    chrome: {
        borderTopLeftRadius: Platform.select({ default: 16, android: 20 }),
        borderTopRightRadius: Platform.select({ default: 16, android: 20 }),
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        overflow: 'hidden',
    },
    divider: {
        height: 1,
        backgroundColor: theme.colors.border.default,
        opacity: 1,
    },
}));

type AttentionRequest =
    | Readonly<{ kind: 'provider_permission'; id: string; request: PendingPermissionRequest }>
    | Readonly<{ kind: 'action_approval'; id: string; request: OpenApprovalArtifactForSession }>;

function getAttentionRequestKey(request: AttentionRequest): string {
    switch (request.kind) {
        case 'provider_permission':
            return `permission:${request.id}`;
        case 'action_approval':
            return `approval:${request.id}`;
    }
}

export const AgentInputAttentionRequests = React.memo(function AgentInputAttentionRequests(props: Readonly<{
    sessionId: string;
    permissionRequests: readonly PendingPermissionRequest[];
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    permissionLocationsById: ReadonlyMap<string, PermissionToolCallMessageLocation | null>;
    approvalLocationsByArtifactId?: ReadonlyMap<string, PermissionToolCallMessageLocation | null>;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    maxHeightPx: number;
    onContentSizeChange: (width: number, height: number) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    fadeVisibility?: Readonly<{ top?: boolean; bottom?: boolean }>;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const attentionRequests = React.useMemo(() => {
        return [
            ...(props.disabledReason === 'inactive'
                ? []
                : props.permissionRequests.map((request): AttentionRequest => ({
                    kind: 'provider_permission',
                    id: request.id,
                    request,
                }))),
            ...(props.disabledReason === 'inactive'
                ? []
                : (props.approvalRequests ?? []).map((request): AttentionRequest => ({
                    kind: 'action_approval',
                    id: request.artifact.id,
                    request,
                }))),
        ];
    }, [props.approvalRequests, props.disabledReason, props.permissionRequests]);
    const scrollStyle = React.useMemo(() => ({ maxHeight: props.maxHeightPx }), [props.maxHeightPx]);

    if (attentionRequests.length === 0) {
        return null;
    }

    return (
        <View style={styles.permissionRequestsContainer}>
            <View testID="agentInput.permissionRequests.chrome" style={styles.chrome}>
                <View style={{ position: 'relative' }}>
                    <ScrollView
                        testID="agentInput.permissionRequests.scroll"
                        style={scrollStyle}
                        contentContainerStyle={{ paddingBottom: 2 }}
                        nestedScrollEnabled={true}
                        scrollEventThrottle={16}
                        showsVerticalScrollIndicator={false}
                        onContentSizeChange={props.onContentSizeChange}
                        onLayout={props.onLayout}
                        onScroll={props.onScroll}
                    >
                        <View style={{ paddingTop: 0 }}>
                            {attentionRequests.map((entry, index) => (
                                <React.Fragment key={getAttentionRequestKey(entry)}>
                                    {index > 0 ? (
                                        <View
                                            testID={`agentInput.permissionRequests.divider:${getAttentionRequestKey(entry)}`}
                                            style={styles.divider}
                                        />
                                    ) : null}
                                    {entry.kind === 'provider_permission' ? (
                                        <PermissionPromptCard
                                            chrome="inline"
                                            maxHeightPx={Math.max(0, props.maxHeightPx - 2)}
                                            request={entry.request}
                                            location={props.permissionLocationsById.get(entry.request.id) ?? null}
                                            sessionId={props.sessionId}
                                            metadata={props.metadata}
                                            canApprovePermissions={props.canApprovePermissions}
                                            disabledReason={props.disabledReason}
                                        />
                                    ) : (
                                        <ApprovalPromptCard
                                            chrome="inline"
                                            maxHeightPx={Math.max(0, props.maxHeightPx - 2)}
                                            artifact={entry.request.artifact}
                                            approval={entry.request.approval}
                                            location={props.approvalLocationsByArtifactId?.get(entry.request.artifact.id) ?? null}
                                            sessionId={props.sessionId}
                                            canApprove={props.canApprovePermissions}
                                            disabledReason={props.disabledReason}
                                        />
                                    )}
                                </React.Fragment>
                            ))}
                        </View>
                    </ScrollView>

                    <ScrollEdgeFades
                        color={theme.colors.surface.elevated}
                        edges={{
                            top: props.fadeVisibility?.top === true,
                            bottom: props.fadeVisibility?.bottom === true,
                        }}
                    />
                    <ScrollEdgeIndicators
                        color={theme.colors.text.secondary}
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

export const AgentInputPermissionRequests = AgentInputAttentionRequests;
