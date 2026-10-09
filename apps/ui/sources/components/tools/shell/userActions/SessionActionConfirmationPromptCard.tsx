import * as React from 'react';
import { View } from 'react-native';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { StyleSheet } from 'react-native-unistyles';

import { ApprovalDecisionFooter } from '@/components/tools/shell/approvals/ApprovalDecisionFooter';
import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { t } from '@/text';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { markTranscriptPromptAnswered } from '@/components/tools/shell/permissions/usePendingPromptPrimaryFocus';
import { isSessionActionConfirmationRequest } from '@/sync/domains/session/pending/listPendingSessionRequests';

type ActionConfirmationPresentation = Readonly<{
    actionId: string;
    actionTitle: string;
    previewSummary: string | null;
    targetSessionId: string;
    turnId: string;
    isCurrentTarget: boolean;
}>;

function readNonEmptyString(record: Readonly<Record<string, unknown>>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPreviewSummary(preview: unknown): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    return readNonEmptyString(preview as Readonly<Record<string, unknown>>, 'summary');
}

function buildPresentation(
    request: PendingPermissionRequest,
    currentSessionId: string,
): ActionConfirmationPresentation | null {
    if (!isSessionActionConfirmationRequest(request)) return null;
    if (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) return null;
    const args = request.arguments as Readonly<Record<string, unknown>>;
    const actionId = readNonEmptyString(args, 'actionId');
    const targetSessionId = readNonEmptyString(args, 'sessionId');
    const turnId = readNonEmptyString(args, 'turnId');
    if (!actionId || !targetSessionId || !turnId) return null;

    const parsedActionId = ActionIdSchema.safeParse(actionId);
    const actionTitle = parsedActionId.success ? getActionSpec(parsedActionId.data).title || actionId : actionId;

    return {
        actionId,
        actionTitle,
        previewSummary: readPreviewSummary(args.preview),
        targetSessionId,
        turnId,
        isCurrentTarget:
            targetSessionId === currentSessionId
            && request.turnId === turnId
            && parsedActionId.success,
    };
}

export const SessionActionConfirmationPromptCard = React.memo(function SessionActionConfirmationPromptCard(props: Readonly<{
    request: PendingPermissionRequest;
    sessionId: string;
    serverId?: string;
    canApprovePermissions: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    chrome?: 'card' | 'inline';
}>) {
    const source = useSessionTranscriptSource();
    const interaction = source.useInteraction();
    const actions = source.actions;
    const presentation = React.useMemo(
        () => buildPresentation(props.request, source.sessionId),
        [props.request, source.sessionId],
    );
    const [isDeciding, setIsDeciding] = React.useState(false);
    const decisionInFlightRef = React.useRef(false);
    const chrome = props.chrome ?? 'card';
    const disabled = actions === null || !interaction.canApprovePermissions || !props.canApprovePermissions || Boolean(props.disabledReason);

    const decide = React.useCallback(async (decision: 'approve' | 'reject') => {
        if (decisionInFlightRef.current || disabled || !actions) return;
        decisionInFlightRef.current = true;
        setIsDeciding(true);
        try {
            const turnId = presentation?.turnId ?? props.request.turnId;
            if (decision === 'approve') {
                if (!presentation?.isCurrentTarget) return;
                await actions.respondToPermission({ id: props.request.id, approved: true, decision: 'approved', turnId });
            } else {
                await actions.respondToPermission({ id: props.request.id, approved: false, decision: 'denied', turnId });
            }
            markTranscriptPromptAnswered(source, props.request.id);
        } catch {
            Modal.alert(t('common.error'), t('approvals.decisionError'));
        } finally {
            decisionInFlightRef.current = false;
            setIsDeciding(false);
        }
    }, [actions, disabled, presentation, props.request.id, props.request.turnId, source]);

    if (props.disabledReason === 'inactive') return null;

    return (
        <ApprovalPromptChrome
            testID="action-confirmation-prompt-card"
            accessibilityRole="summary"
            chrome={chrome}
            tone="attention"
            title={presentation?.actionTitle ?? t('approvals.unsafeDetailsTitle')}
            subtitle={t('actionConfirmations.requestedByAgent')}
            footer={(
                <ApprovalDecisionFooter
                    requestId={props.request.id}
                    testIDPrefix="action-confirmation"
                    disabled={disabled}
                    disabledReason={props.disabledReason}
                    approveDisabled={!presentation?.isCurrentTarget}
                    isDeciding={isDeciding}
                    onApprove={() => { void decide('approve'); }}
                    onReject={() => { void decide('reject'); }}
                />
            )}
        >
            <View style={styles.details}>
                {presentation ? (
                    <>
                        <Text style={styles.identifier}>{presentation.actionId}</Text>
                        {props.serverId ? <Text style={styles.target}>{t('actionConfirmations.homeTarget', { serverId: props.serverId })}</Text> : null}
                        <Text style={styles.target}>{t('actionConfirmations.sessionTarget', { sessionId: presentation.targetSessionId })}</Text>
                        {presentation.previewSummary ? <Text style={styles.preview}>{presentation.previewSummary}</Text> : null}
                    </>
                ) : (
                    <Text style={styles.preview}>{t('approvals.unsafeDetailsBody')}</Text>
                )}
                <Text style={styles.consequence}>{t('actionConfirmations.oneShotConsequence')}</Text>
            </View>
        </ApprovalPromptChrome>
    );
});

const styles = StyleSheet.create((theme) => ({
    details: {
        gap: 5,
    },
    identifier: {
        fontSize: 12,
        color: theme.colors.text.primary,
    },
    target: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    preview: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    consequence: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
}));
