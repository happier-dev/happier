import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { listActionSpecs, resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Modal } from '@/modal';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { ApprovalDecisionFooter } from './ApprovalDecisionFooter';
import { getApprovalDecisionErrorMessage, isApprovalReplayRouteUnavailable, useApprovalDecisionHandler } from './useApprovalDecisionHandler';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionApprovalFieldsCard } from '@/components/approvals/ActionApprovalFieldsCard';
import { ComputerActionApprovalCard } from '@/components/approvals/ComputerActionApprovalCard';
import { useComputerApprovalChoice } from '@/components/approvals/useComputerApprovalChoice';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

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

function resolveDeferredComputerPicker() {
    return (require('../../../computer/openComputerTargetPickerForSession') as typeof import('../../../computer/openComputerTargetPickerForSession')).openComputerTargetPickerForSession;
}

function resolveActionTitle(approval: ApprovalRequest): string {
    return listActionSpecs().find((spec) => spec.id === approval.actionId)?.title || approval.actionId;
}

export const ApprovalPromptCard = React.memo(function ApprovalPromptCard(props: Readonly<{
    artifact: ApprovalPromptCardArtifact;
    approval: ApprovalRequest;
    sessionId: string;
    metadata?: Metadata | null;
    location?: PermissionToolCallMessageLocation | null;
    canApprovePermissions?: boolean;
    canApprove?: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    chrome?: 'card' | 'inline';
}>) {
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const decide = useApprovalDecisionHandler(props.artifact, props.approval, props.sessionId);
    const [isDeciding, setIsDeciding] = React.useState(false);
    const chrome = props.chrome ?? 'card';
    const actionTitle = React.useMemo(() => resolveActionTitle(props.approval), [props.approval]);
    const previewSummary = React.useMemo(() => getPreviewSummary(props.approval.preview), [props.approval.preview]);
    const approveAdmission = React.useMemo(
        () => resolveApprovalRequestApproveAdmission(props.approval),
        [props.approval],
    );
    const actionFields = approveAdmission.presentation;
    const sessionId = props.sessionId;
    const computerChoice = useComputerApprovalChoice({
        actionId: String(props.approval.actionId),
        actionArgs: props.approval.actionArgs,
        preview: props.approval.preview,
        sessionId,
        // Loaded on the press: the picker reads the Session and the store, which this card never does.
        resolveOpenPicker: resolveDeferredComputerPicker,
    });
    const computerAction = computerChoice.presentation;
    const chooseComputerTarget = computerChoice.chooseTarget;
    const approvalWithheld = approveAdmission.status === 'unavailable';
    const sourceInteraction = transcriptSource.useInteraction();
    const canApprove = transcriptSource.actions !== null
        && (props.canApprovePermissions ?? props.canApprove ?? sourceInteraction.canApprovePermissions)
        && sourceInteraction.canApprovePermissions;
    const approvalRouteUnavailable = isApprovalReplayRouteUnavailable(props.approval);
    const accessDisabled = !canApprove || Boolean(props.disabledReason);
    const decisionDisabled = accessDisabled || approvalRouteUnavailable;
    const canOpenToolRoute = transcriptSource.navigate !== null && canOpenPermissionToolCallRoute(props.location ?? null);

    const onViewTool = React.useCallback(() => {
        navigateWithBlurOnWeb(() => {
            transcriptSource.navigate?.(buildPermissionToolCallRoute({ sessionId: props.sessionId, location: props.location ?? null }));
        });
    }, [props.location, props.sessionId, transcriptSource]);

    const onDecision = React.useCallback(async (decision: 'approve' | 'reject') => {
        if (decisionDisabled || isDeciding || (decision === 'approve' && approvalWithheld)) return;
        try {
            setIsDeciding(true);
            // An agent's window choice is approved with the exact window the person picked.
            if (decision === 'approve' && computerChoice.needsChoiceBeforeApprove) {
                computerChoice.chooseTarget();
                return;
            }
            const ok = await decide(decision, decision === 'approve' ? computerChoice.decisionOptions : undefined);
            if (!ok) {
                Modal.alert(t('common.error'), t('approvals.decisionError'));
            }
        } catch (error) {
            Modal.alert(t('common.error'), getApprovalDecisionErrorMessage(error));
        } finally {
            setIsDeciding(false);
        }
    }, [approvalWithheld, computerChoice, decisionDisabled, decide, isDeciding]);

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
            {computerAction ? (
                <ComputerActionApprovalCard
                    presentation={computerAction}
                    onChooseTarget={canApprove ? chooseComputerTarget : undefined}
                    style={styles.fields}
                    testID="approval-prompt-computer-action"
                />
            ) : null}
            {actionFields.rows.length > 0 ? (
                <View style={styles.fields}>
                    <ActionApprovalFieldsCard presentation={actionFields} />
                </View>
            ) : null}
            {approvalRouteUnavailable ? (
                <View style={styles.preview}>
                    <Text style={styles.previewText}>{t('actionConfirmations.homeUnavailable')}</Text>
                </View>
            ) : null}

            <View style={styles.actions}>
                <ApprovalDecisionFooter
                    disabled={accessDisabled}
                    decisionDisabled={approvalRouteUnavailable}
                    approveDisabled={approvalWithheld}
                    approveAccessibilityHint={approvalWithheld ? t('approvals.approveUnavailableHint') : undefined}
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
        minWidth: Platform.select({ ios: 44, default: 48 }),
        minHeight: Platform.select({ ios: 44, default: 48 }),
        alignItems: 'center',
        justifyContent: 'center',
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
    fields: {
        paddingLeft: PROMPT_CARD_TEXT_COLUMN_START,
        paddingRight: PROMPT_CARD_HORIZONTAL_PADDING,
        paddingBottom: 10,
    },
    actions: {
        paddingLeft: PROMPT_CARD_TEXT_COLUMN_START,
        paddingRight: PROMPT_CARD_HORIZONTAL_PADDING,
        paddingBottom: 12,
    },
}));
