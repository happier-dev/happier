import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { knownTools } from '../../catalog';
import { resolvePermissionRequestId } from '../core/resolvePermissionRequestId';
import { normalizeToolNameForView } from '@/components/tools/normalization/policy/normalizeToolNameForView';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { resolvePermissionDisabledMessage } from '@/components/tools/shell/permissions/permissionDisabledMessage';
import { usePendingPromptPrimaryFocus, markTranscriptPromptAnswered } from '@/components/tools/shell/permissions/usePendingPromptPrimaryFocus';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { useToolFindState } from '../core/ToolFindText';
import { useTranscriptFindActive } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { getSessionPermissionChoiceKind, resolveSessionPermissionChoices } from '@/sync/ops/sessionPermissionChoices';
import { answerSessionPermission } from '@/sync/ops/sessionPermissionAnswers';
import { recordPermissionActionFailure } from '@/components/tools/shell/permissions/permissionActionFailure';
import { PermissionFooterOfferedChoices } from '@/components/tools/shell/permissions/PermissionFooterOfferedChoices';
import { PermissionFeedbackInput } from '@/components/tools/shell/permissions/PermissionFeedbackInput';
import { isOfferedPermissionChoice, selectPrimaryOfferedChoice } from '@/components/tools/shell/permissions/offeredChoiceLayout';

function resolvePlan(tool: ToolViewProps['tool']): string {
    const parsed = knownTools.ExitPlanMode.input.safeParse(tool.input);
    const plan = parsed.success ? parsed.data.plan : null;
    return typeof plan === 'string' && plan.trim().length > 0 ? plan : t('tools.exitPlanMode.planMissing');
}

export const projectExitPlanDisplayText: ToolDisplayTextProjector = (tool) => toolTextBlock('tool-plan', resolvePlan(tool), 'markdown');

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        gap: theme.space.s16,
    },
    planContainer: {
        paddingHorizontal: theme.space.s8,
        marginTop: -10,
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: theme.space.s12,
        marginTop: theme.space.s16,
        paddingHorizontal: theme.space.s8,
        justifyContent: 'flex-end',
    },
    feedbackContainer: {
        paddingHorizontal: theme.space.s8,
        gap: theme.space.s10,
    },
    feedbackActions: {
        flexDirection: 'row',
        gap: theme.space.s12,
        justifyContent: 'flex-end',
    },
    approveButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: theme.space.s20,
        paddingVertical: theme.space.s12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s6,
        minHeight: 44,
        flexGrow: 1,
    },
    approveMenuButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    rejectButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        paddingHorizontal: theme.space.s20,
        paddingVertical: theme.space.s12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s6,
        minHeight: 44,
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    approveButtonText: {
        color: theme.colors.button.primary.tint,
        ...Typography.variant('label', 'semiBold'),
    },
    rejectButtonText: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
    },
    requestChangesButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s6,
        minHeight: 44,
    },
    requestChangesButtonText: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
    },
    respondedContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        marginTop: theme.space.s12,
    },
    respondedText: {
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
}));

export const ExitPlanToolView = React.memo<ToolViewProps>(({ tool, sessionId, messageId, interaction }) => {
    const find = useToolFindState(messageId);
    const findActive = useTranscriptFindActive();
    const source = useSessionTranscriptSource();
    const sourceInteraction = source.useInteraction();
    const agentState = source.useAgentState();
    const currentAgentState = React.useRef(agentState);
    currentAgentState.current = agentState;
    const actions = source.actions;
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [isApproving, setIsApproving] = React.useState(false);
    const [isRejecting, setIsRejecting] = React.useState(false);
    const [isResponded, setIsResponded] = React.useState(false);
    const [isRequestingChanges, setIsRequestingChanges] = React.useState(false);
    const [nativeBusyChoiceId, setNativeBusyChoiceId] = React.useState<string | null>(null);
    const [changeRequestText, setChangeRequestText] = React.useState('');
    const isSendingChangeRequest = isRequestingChanges && isRejecting;

    const plan = resolvePlan(tool);

    const isRunning = tool.state === 'running';
    const canApprovePermissions = actions !== null && sourceInteraction.canApprovePermissions && interaction?.canApprovePermissions !== false;
    const permissionRequestId = resolvePermissionRequestId(tool);
    const activeRequest = permissionRequestId ? agentState?.requests?.[permissionRequestId] : null;
    const pendingRequest = source.usePendingRequests().permissionRequests.find(request => request.id === permissionRequestId);
    const nativeChoices = pendingRequest ? pendingRequest.nativeChoices : activeRequest?.nativeChoices;
    const nativePermissionChoices = resolveSessionPermissionChoices({ toolName: tool.name,
        nativeChoices, nativeChoiceAvailability: pendingRequest?.nativeChoiceAvailability });
    const hasActivePlanRequest = typeof activeRequest?.tool === 'string'
        && normalizeToolNameForView(activeRequest.tool) === 'ExitPlanMode';
    const canInteract = isRunning && !isResponded && sessionId && canApprovePermissions && hasActivePlanRequest;
    const hasLivePlanRequest = React.useCallback(() => {
        const request = permissionRequestId ? currentAgentState.current?.requests?.[permissionRequestId] : null;
        return typeof request?.tool === 'string' && normalizeToolNameForView(request.tool) === 'ExitPlanMode';
    }, [permissionRequestId]);
    const disabledMessage =
        resolvePermissionDisabledMessage(interaction?.permissionDisabledReason ?? sourceInteraction.permissionDisabledReason);
    const primaryAnswerRef = usePendingPromptPrimaryFocus(permissionRequestId,
        Boolean(canInteract) && !isApproving && !isRejecting && !isRequestingChanges, messageId);
    const handleChooseNative = React.useCallback(async (choiceId: string, feedback?: string) => {
        if (!canInteract || isApproving || isRejecting || !permissionRequestId || !actions || !hasLivePlanRequest()) return;
        const choice = nativePermissionChoices.find(candidate => candidate.id === choiceId);
        const answer = choice?.response.nativeChoice;
        if (!choice || !answer) return;
        setIsApproving(true);
        try {
            await answerSessionPermission({ requestId: permissionRequestId,
                ...(pendingRequest?.turnId ? { turnId: pendingRequest.turnId } : {}),
                nativeChoice: { ...answer, ...(feedback !== undefined ? { feedback } : {}) },
                respondToPermission: actions.respondToPermission });
            markTranscriptPromptAnswered(source, permissionRequestId);
            setIsResponded(true);
        } catch (error) {
            recordPermissionActionFailure(getSessionPermissionChoiceKind(choice), error, null);
            if (hasLivePlanRequest()) Modal.alert(t('common.error'), `${t('errors.operationFailed')} ${t('errors.tryAgain')}`);
        } finally {
            setIsApproving(false);
        }
    }, [actions, source, nativePermissionChoices, pendingRequest?.turnId, permissionRequestId, canInteract, hasLivePlanRequest, isApproving, isRejecting]);
    const handleApprove = React.useCallback(async (mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', opts?: { updatedPermissions?: unknown }) => {
        if (nativeChoices !== undefined) return;
        if (!sessionId || isApproving || isRejecting || !canInteract || !hasLivePlanRequest()) return;
        const permissionId = permissionRequestId;
        if (!permissionId) {
            Modal.alert(t('common.error'), t('errors.missingPermissionId'));
            return;
        }

        setIsApproving(true);
        try {
            if (!actions) return;
            await actions.respondToPermission({
                id: permissionId, approved: true,
                ...(mode !== undefined ? { mode } : {}),
                ...(opts?.updatedPermissions !== undefined ? { updatedPermissions: opts.updatedPermissions } : {}),
            });
            markTranscriptPromptAnswered(source, permissionId);
            setIsResponded(true);
        } catch (error) {
            console.error('Failed to approve plan:', error);
        } finally {
            setIsApproving(false);
        }
    }, [actions, source, sessionId, permissionRequestId, canInteract, hasLivePlanRequest, isApproving, isRejecting, nativeChoices]);

    const handleApproveOptions = React.useCallback(() => {
        if (nativeChoices !== undefined) return;
        if (!canInteract || isApproving || isRejecting || !hasLivePlanRequest()) return;

        const suggestionsRaw = tool.permission?.suggestions;
        const suggestionList = Array.isArray(suggestionsRaw) ? suggestionsRaw : [];

        type SetModeSuggestion = Readonly<{
            type: 'setMode';
            mode: string;
            destination: 'session';
        }>;

        const isSetModeSuggestion = (value: unknown): value is SetModeSuggestion => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const rec = value as Record<string, unknown>;
            return (
                rec.type === 'setMode' &&
                typeof rec.mode === 'string' &&
                rec.destination === 'session'
            );
        };

        const setModeSuggestions = suggestionList.filter(isSetModeSuggestion);
        const suggestionByMode = new Map<string, SetModeSuggestion>();
        for (const suggestion of setModeSuggestions) {
            // Prefer first suggestion for a given mode to preserve provider ordering.
            if (!suggestionByMode.has(suggestion.mode)) {
                suggestionByMode.set(suggestion.mode, suggestion);
            }
        }

        const labelForMode = (mode: string): string => {
            if (mode === 'default') return t('agentInput.permissionMode.default');
            if (mode === 'acceptEdits') return t('agentInput.permissionMode.acceptEdits');
            if (mode === 'bypassPermissions') return t('agentInput.permissionMode.badgeBypassAllPermissions');
            return mode;
        };

        const standardModes = new Set(['default', 'acceptEdits', 'bypassPermissions']);
        const extraSetModeSuggestions = setModeSuggestions.filter((s) => !standardModes.has(s.mode));

        Modal.alert(t('tools.exitPlanMode.approve'), undefined, [
            ...extraSetModeSuggestions.map((suggestion) => ({
                text: `${t('tools.exitPlanMode.approve')} (${labelForMode(suggestion.mode)})`,
                onPress: () => handleApprove(undefined, { updatedPermissions: [suggestion] }),
            })),
            {
                text: `${t('tools.exitPlanMode.approve')} (${t('agentInput.permissionMode.default')})`,
                onPress: () => handleApprove('default', { updatedPermissions: [suggestionByMode.get('default') ?? { type: 'setMode', mode: 'default', destination: 'session' }] }),
            },
            {
                text: `${t('tools.exitPlanMode.approve')} (${t('agentInput.permissionMode.acceptEdits')})`,
                onPress: () => handleApprove('acceptEdits', { updatedPermissions: [suggestionByMode.get('acceptEdits') ?? { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }),
            },
            {
                text: `${t('tools.exitPlanMode.approve')} (${t('agentInput.permissionMode.badgeBypassAllPermissions')})`,
                onPress: () => handleApprove('bypassPermissions', { updatedPermissions: [suggestionByMode.get('bypassPermissions') ?? { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }),
                style: 'destructive',
            },
            {
                text: t('common.cancel'),
                style: 'cancel',
            },
        ]);
    }, [canInteract, hasLivePlanRequest, isApproving, isRejecting, handleApprove, tool.permission?.suggestions, nativeChoices]);

    const handleReject = React.useCallback(async () => {
        if (nativeChoices !== undefined) return;
        if (!sessionId || isApproving || isRejecting || !canInteract || !hasLivePlanRequest()) return;
        const permissionId = permissionRequestId;
        if (!permissionId) {
            Modal.alert(t('common.error'), t('errors.missingPermissionId'));
            return;
        }

        setIsRejecting(true);
        try {
            if (!actions) return;
            await actions.respondToPermission({ id: permissionId, approved: false });
            markTranscriptPromptAnswered(source, permissionId);
            setIsResponded(true);
        } catch (error) {
            console.error('Failed to reject plan:', error);
        } finally {
            setIsRejecting(false);
        }
    }, [actions, source, sessionId, permissionRequestId, canInteract, hasLivePlanRequest, isApproving, isRejecting, nativeChoices]);

    const handleRequestChanges = React.useCallback(() => {
        if (!canInteract || isApproving || isRejecting || !hasLivePlanRequest()) return;
        setIsRequestingChanges(true);
    }, [canInteract, hasLivePlanRequest, isApproving, isRejecting]);

    const handleCancelRequestChanges = React.useCallback(() => {
        if (isApproving || isRejecting) return;
        setIsRequestingChanges(false);
        setChangeRequestText('');
    }, [isApproving, isRejecting]);

    const handleSendChangeRequest = React.useCallback(async () => {
        if (nativeChoices !== undefined) return;
        if (!sessionId || isApproving || isRejecting || !canInteract || !hasLivePlanRequest()) return;
        const permissionId = permissionRequestId;
        if (!permissionId) {
            Modal.alert(t('common.error'), t('errors.missingPermissionId'));
            return;
        }

        const trimmed = changeRequestText.trim();
        if (!trimmed) {
            Modal.alert(t('common.error'), t('tools.exitPlanMode.requestChangesEmpty'));
            return;
        }

        setIsRejecting(true);
        try {
            if (!actions) return;
            await actions.respondToPermission({ id: permissionId, approved: false, reason: trimmed });
            markTranscriptPromptAnswered(source, permissionId);
            setIsResponded(true);
        } catch (error) {
            console.error('Failed to request plan changes:', error);
            Modal.alert(t('common.error'), t('tools.exitPlanMode.requestChangesFailed'));
        } finally {
            setIsRejecting(false);
        }
    }, [actions, source, sessionId, permissionRequestId, canInteract, hasLivePlanRequest, isApproving, isRejecting, changeRequestText, nativeChoices]);

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <View style={styles.planContainer}>
                    <MarkdownView markdown={plan} findActive={findActive} findSourceRanges={find.ranges('tool-plan')} agentTexMath />
                </View>

                {isResponded || tool.state === 'completed' ? (
                    <View style={styles.respondedContainer}>
                        <Icon
                            name="check-circle"
                            size={16}
                            color={theme.colors.text.secondary}
                        />
                        <Text style={styles.respondedText}>
                            {t('tools.exitPlanMode.responded')}
                        </Text>
                    </View>
                ) : canInteract && nativeChoices !== undefined ? (
                    // A native occurrence offers its own choices, verbatim and in its order (lab mb B).
                    <PermissionFooterOfferedChoices
                        choices={nativePermissionChoices.filter(isOfferedPermissionChoice)}
                        permissionOwnerLabel={pendingRequest?.permissionOwnerLabel}
                        primaryId={selectPrimaryOfferedChoice(nativePermissionChoices.filter(isOfferedPermissionChoice))}
                        disabled={isApproving || isRejecting}
                        busyChoiceId={nativeBusyChoiceId}
                        onChoose={(choiceId, feedback) => {
                            setNativeBusyChoiceId(choiceId);
                            void handleChooseNative(choiceId, feedback).finally(() => setNativeBusyChoiceId(null));
                        }}
                        primaryRef={primaryAnswerRef}
                    />
                ) : canInteract ? (
                    <>
                        {isRequestingChanges ? (
                            <View style={styles.feedbackContainer}>
                                <PermissionFeedbackInput
                                    testID="exit-plan-request-changes-input"
                                    value={changeRequestText}
                                    onChangeText={setChangeRequestText}
                                    placeholder={t('tools.exitPlanMode.requestChangesPlaceholder')}
                                    editable={!isApproving && !isRejecting}
                                />
                                <View style={styles.feedbackActions}>
                                    <TouchableOpacity
                                        testID="exit-plan-request-changes-cancel"
                                        style={[
                                            styles.rejectButton,
                                            (isApproving || isRejecting) && styles.buttonDisabled,
                                        ]}
                                        onPress={handleCancelRequestChanges}
                                        disabled={isApproving || isRejecting}
                                        activeOpacity={0.7}
                                    >
                                        <Text style={styles.rejectButtonText}>
                                            {t('common.cancel')}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        testID="exit-plan-request-changes-send"
                                        style={[
                                            styles.approveButton,
                                            (isApproving || isRejecting || !changeRequestText.trim()) && styles.buttonDisabled,
                                        ]}
                                        onPress={handleSendChangeRequest}
                                        disabled={isApproving || isRejecting || !changeRequestText.trim()}
                                        activeOpacity={0.7}
                                    >
                                        {isSendingChangeRequest ? (
                                            <ActivitySpinner size="small" color={theme.colors.button.primary.tint} />
                                        ) : (
                                            <Text style={styles.approveButtonText}>
                                                {t('tools.exitPlanMode.requestChangesSend')}
                                            </Text>
                                        )}
                                    </TouchableOpacity>
                                </View>
                            </View>
                        ) : (
                            <View style={styles.actionsContainer}>
                                <TouchableOpacity
                                    testID="exit-plan-reject"
                                    style={[
                                        styles.rejectButton,
                                        (isApproving || isRejecting) && styles.buttonDisabled,
                                    ]}
                                    onPress={handleReject}
                                    disabled={isApproving || isRejecting}
                                    activeOpacity={0.7}
                                >
                                    {isRejecting ? (
                                        <ActivitySpinner size="small" color={theme.colors.text.primary} />
                                    ) : (
                                        <>
                                            <Icon name="x" size={16} color={theme.colors.text.primary} />
                                            <Text style={styles.rejectButtonText}>
                                                {t('tools.exitPlanMode.reject')}
                                            </Text>
                                        </>
                                    )}
                                </TouchableOpacity>
                                <TouchableOpacity
                                    testID="exit-plan-request-changes"
                                    style={[
                                        styles.requestChangesButton,
                                        (isApproving || isRejecting) && styles.buttonDisabled,
                                    ]}
                                    onPress={handleRequestChanges}
                                    disabled={isApproving || isRejecting}
                                    activeOpacity={0.7}
                                >
                                    <Text style={styles.requestChangesButtonText}>
                                        {t('tools.exitPlanMode.requestChanges')}
                                    </Text>
                                </TouchableOpacity>
                                  <TouchableOpacity
                                      testID="exit-plan-approve"
                                      ref={primaryAnswerRef}
                                      style={[
                                          styles.approveButton,
                                          (isApproving || isRejecting) && styles.buttonDisabled,
                                      ]}
                                      onPress={() => handleApprove()}
                                      disabled={isApproving || isRejecting}
                                      activeOpacity={0.7}
                                  >
                                      {isApproving ? (
                                          <ActivitySpinner size="small" color={theme.colors.button.primary.tint} />
                                    ) : (
                                        <>
                                            <Icon name="check" size={16} color={theme.colors.button.primary.tint} />
                                              <Text style={styles.approveButtonText}>
                                                  {t('tools.exitPlanMode.approve')}
                                              </Text>
                                          </>
                                      )}
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                      testID="exit-plan-approve-menu"
                                      style={[
                                          styles.approveMenuButton,
                                          (isApproving || isRejecting) && styles.buttonDisabled,
                                      ]}
                                      onPress={handleApproveOptions}
                                      disabled={isApproving || isRejecting}
                                      activeOpacity={0.7}
                                  >
                                      <Icon name="caret-down" size={16} color={theme.colors.button.primary.tint} />
                                  </TouchableOpacity>
                              </View>
                          )}
                      </>
                  ) : (isRunning && !canApprovePermissions ? (
                    <View style={styles.respondedContainer}>
                        <Icon
                            name="lock"
                            size={16}
                            color={theme.colors.text.secondary}
                        />
                        <Text style={styles.respondedText}>
                            {disabledMessage}
                        </Text>
                    </View>
                ) : null)}
            </View>
        </ToolSectionView>
    );
});
