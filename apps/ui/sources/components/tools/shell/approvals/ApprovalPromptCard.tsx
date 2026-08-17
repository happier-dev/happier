import * as React from 'react';
import { Pressable, View } from 'react-native';
import { getActionSpec, type ApprovalRequestV1 } from '@happier-dev/protocol';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Modal } from '@/modal';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { ApprovalDecisionFooter } from './ApprovalDecisionFooter';
import { useApprovalDecisionHandler } from './useApprovalDecisionHandler';
import { Icon } from '@/components/ui/icons/Icon';

const PROMPT_CARD_HORIZONTAL_PADDING = 12;
const PROMPT_CARD_ICON_SIZE = 18;
const PROMPT_CARD_ICON_TEXT_GAP = 6;
const PROMPT_CARD_TEXT_COLUMN_START =
    PROMPT_CARD_HORIZONTAL_PADDING + PROMPT_CARD_ICON_SIZE + PROMPT_CARD_ICON_TEXT_GAP;

type ApprovalPromptCardArtifact = Pick<DecryptedArtifact, 'id' | 'header'>;

function getPreviewSummary(preview: unknown): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const summary = typeof (preview as { summary?: unknown }).summary === 'string'
        ? (preview as { summary: string }).summary.trim()
        : '';
    return summary || null;
}

function resolveActionTitle(approval: ApprovalRequestV1): string {
    try {
        return getActionSpec(approval.actionId).title || approval.actionId;
    } catch {
        return approval.actionId;
    }
}

export const ApprovalPromptCard = React.memo(function ApprovalPromptCard(props: Readonly<{
    artifact: ApprovalPromptCardArtifact;
    approval: ApprovalRequestV1;
    sessionId: string;
    metadata?: Metadata | null;
    location?: PermissionToolCallMessageLocation | null;
    canApprovePermissions?: boolean;
    canApprove?: boolean;
    disabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    chrome?: 'card' | 'inline';
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const decide = useApprovalDecisionHandler(props.artifact, props.sessionId);
    const [isDeciding, setIsDeciding] = React.useState(false);
    const chrome = props.chrome ?? 'card';
    const actionTitle = React.useMemo(() => resolveActionTitle(props.approval), [props.approval]);
    const previewSummary = React.useMemo(() => getPreviewSummary(props.approval.preview), [props.approval.preview]);
    const canApprove = props.canApprovePermissions ?? props.canApprove ?? true;
    const approvalDisabled = !canApprove || Boolean(props.disabledReason);
    const canOpenToolRoute = canOpenPermissionToolCallRoute(props.location ?? null);

    const onViewTool = React.useCallback(() => {
        navigateWithBlurOnWeb(() => {
            router.push(buildPermissionToolCallRoute({ sessionId: props.sessionId, location: props.location ?? null }));
        });
    }, [props.location, props.sessionId, router]);

    const onDecision = React.useCallback(async (decision: 'approve' | 'reject') => {
        if (approvalDisabled || isDeciding) return;
        try {
            setIsDeciding(true);
            const ok = await decide(decision);
            if (!ok) {
                Modal.alert(t('common.error'), t('approvals.decisionError'));
            }
        } catch {
            Modal.alert(t('common.error'), t('approvals.decisionError'));
        } finally {
            setIsDeciding(false);
        }
    }, [approvalDisabled, decide, isDeciding]);

    if (props.disabledReason === 'inactive') {
        return null;
    }

    return (
        <View testID="approval-prompt-card" style={[styles.container, chrome === 'inline' ? styles.containerInline : null]}>
            <View style={styles.header}>
                <View style={styles.icon}>
                    <Icon name="shield-check" size={16} color={theme.colors.state.neutral.foreground} />
                </View>
                <View style={styles.headerText}>
                    <Text style={styles.title} numberOfLines={1}>
                        {actionTitle}
                    </Text>
                    <Text style={styles.subtitle} numberOfLines={2}>
                        {props.approval.summary || t('approvals.untitled')}
                    </Text>
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

            <View style={styles.actions}>
                <ApprovalDecisionFooter
                    disabled={approvalDisabled}
                    disabledReason={props.disabledReason}
                    isDeciding={isDeciding}
                    onApprove={() => { void onDecision('approve'); }}
                    onReject={() => { void onDecision('reject'); }}
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
