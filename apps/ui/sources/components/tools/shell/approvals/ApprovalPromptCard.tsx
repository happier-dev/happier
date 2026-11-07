import * as React from 'react';
import { Pressable, View } from 'react-native';
import { getActionSpec, type ActionId, type ApprovalRequestV1 } from '@happier-dev/protocol';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { ApprovalDecisionFooter } from './ApprovalDecisionFooter';
import { useApprovalDecisionHandler } from './useApprovalDecisionHandler';
import { Icon } from '@/components/ui/icons/Icon';
import { PromptCardLayout } from '@/components/tools/shell/presentation/PromptCardLayout';

const PROMPT_CARD_HORIZONTAL_PADDING = 12;
const PROMPT_CARD_ICON_SIZE = 18;
const PROMPT_CARD_ICON_TEXT_GAP = 6;
const PROMPT_CARD_TEXT_COLUMN_START =
    PROMPT_CARD_HORIZONTAL_PADDING + PROMPT_CARD_ICON_SIZE + PROMPT_CARD_ICON_TEXT_GAP;

function getPreviewSummary(preview: unknown): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const summary = typeof (preview as { summary?: unknown }).summary === 'string'
        ? (preview as { summary: string }).summary.trim()
        : '';
    return summary || null;
}

function getActionTitle(actionId: string): string {
    try {
        const spec = getActionSpec(actionId as ActionId);
        return spec.title || actionId;
    } catch {
        return actionId;
    }
}

export const ApprovalPromptCard = React.memo(function ApprovalPromptCard(props: Readonly<{
    artifact: Pick<DecryptedArtifact, 'id' | 'header'>;
    approval: ApprovalRequestV1;
    location?: PermissionToolCallMessageLocation | null;
    sessionId: string;
    canApprove: boolean;
    disabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    chrome?: 'card' | 'inline';
    maxHeightPx?: number;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const chrome = props.chrome ?? 'card';
    const previewSummary = React.useMemo(() => getPreviewSummary(props.approval.preview), [props.approval.preview]);
    const title = React.useMemo(() => getActionTitle(props.approval.actionId), [props.approval.actionId]);
    const requestServerId = typeof props.approval.serverId === 'string'
        ? props.approval.serverId
        : null;
    const { decide, isDeciding } = useApprovalDecisionHandler({
        artifact: props.artifact,
        sessionId: props.sessionId,
        requestServerId,
    });
    const canOpenToolRoute = canOpenPermissionToolCallRoute(props.location ?? null);
    const onViewTool = React.useCallback(() => {
        navigateWithBlurOnWeb(() => {
            router.push(buildPermissionToolCallRoute({ sessionId: props.sessionId, location: props.location ?? null }));
        });
    }, [props.location, props.sessionId, router]);

    if (props.disabledReason === 'inactive') return null;

    return (
        <View testID="approval-prompt-card" style={[styles.container, chrome === 'inline' ? styles.containerInline : null]}>
            <PromptCardLayout
                maxHeightPx={props.maxHeightPx}
                bodyTestID="approval-prompt-scroll-body"
                footer={(
                    <View style={styles.actions}>
                        <ApprovalDecisionFooter
                            disabled={!props.canApprove}
                            disabledReason={props.disabledReason}
                            isDeciding={isDeciding}
                            onApprove={() => { void decide('approve'); }}
                            onReject={() => { void decide('reject'); }}
                        />
                    </View>
                )}
            >
            <View style={styles.header}>
                <View style={styles.icon}>
                    <Icon name="shield-check" size={16} color={theme.colors.state.neutral.foreground} />
                </View>
                <View style={styles.headerText}>
                    <Text style={styles.title} numberOfLines={1}>{title}</Text>
                    <Text style={styles.subtitle} numberOfLines={2}>{props.approval.summary || t('approvals.untitled')}</Text>
                </View>
                {canOpenToolRoute ? (
                    <Pressable
                        testID="approval-prompt-view-tool"
                        onPress={onViewTool}
                        accessibilityRole="button"
                        accessibilityLabel={t('toolView.open')}
                        style={({ pressed }) => [styles.viewButton, pressed && styles.viewButtonPressed]}
                    >
                        <Icon name="arrow-square-out" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
            </View>

            {previewSummary ? (
                <View style={styles.preview}>
                    <Text style={styles.previewText}>{previewSummary}</Text>
                </View>
            ) : null}

            </PromptCardLayout>
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
        gap: PROMPT_CARD_ICON_TEXT_GAP,
        paddingLeft: PROMPT_CARD_HORIZONTAL_PADDING,
        paddingRight: PROMPT_CARD_HORIZONTAL_PADDING,
        paddingTop: 12,
        paddingBottom: 8,
    },
    icon: {
        width: PROMPT_CARD_ICON_SIZE,
        height: PROMPT_CARD_ICON_SIZE,
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
    preview: {
        paddingLeft: PROMPT_CARD_TEXT_COLUMN_START,
        paddingRight: PROMPT_CARD_HORIZONTAL_PADDING,
        paddingBottom: 10,
    },
    previewText: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    actions: {
        paddingLeft: PROMPT_CARD_TEXT_COLUMN_START,
        paddingRight: PROMPT_CARD_HORIZONTAL_PADDING,
        paddingBottom: 12,
    },
}));
