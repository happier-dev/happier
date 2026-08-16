import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { resolvePermissionRequestId } from '../core/resolvePermissionRequestId';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { sessionAllowWithAnswers } from '@/sync/ops';
import { storage, useSession, useSettingMutable } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveAgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    hasClaudeUnifiedOpenTerminalSecondaryAction,
    isClaudeUnifiedOpenTerminalNotice,
    resolveClaudeUnifiedDialogQuestionPresentation,
} from './resolveClaudeUnifiedDialogQuestionPresentation';
import {
    useOpenAttachedSessionTerminal,
    type AttachedSessionTerminalUnavailableReason,
} from '@/components/sessions/terminal/openAttachedSessionTerminal';
import { isClaudeUnifiedTerminalDialogChoiceAgentStateRequest } from '@happier-dev/agents';
import { getStructuredQuestionAnswersV1Supported } from '@/sync/domains/state/agentStateCapabilities';
import { Icon } from '@/components/ui/icons/Icon';
import {
    buildAskUserQuestionAnswerPayload,
    tryBuildAskUserQuestionAnswerPayload,
} from './buildAskUserQuestionAnswerPayload';
import {
    PUBLIC_RPC_HANDLER_ERROR_CODES,
    RPC_ERROR_CODES,
    readRpcErrorCode,
} from '@happier-dev/protocol';


interface QuestionOption {
    value?: string;
    choice?: string;
    label: string;
    description: string;
    settingMutation?: unknown;
}

interface Question {
    responseKey?: string;
    question: string;
    header: string;
    options: QuestionOption[];
    multiSelect: boolean;
    freeform?: {
        placeholder?: string;
        description?: string;
    };
}

interface AskUserQuestionInput {
    questions: Question[];
    happierDialog?: unknown;
}

type SubmissionFailureGuidance = 'update' | 'reconnect' | 'retry';

function resolveSubmissionFailureGuidance(error: unknown): SubmissionFailureGuidance | null {
    switch (readRpcErrorCode(error)) {
        case RPC_ERROR_CODES.METHOD_NOT_AVAILABLE:
        case RPC_ERROR_CODES.METHOD_NOT_FOUND:
            return 'update';
        case PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER:
            return 'reconnect';
        case PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID:
        case PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID:
        case PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_AMBIGUOUS:
            return 'retry';
        default:
            return null;
    }
}

function resolveAttachedTerminalUnavailableMessage(
    reason: AttachedSessionTerminalUnavailableReason | null,
): string | null {
    switch (reason) {
        case 'missing_machine':
            return t('terminalEmbedded.errors.missingMachineTarget');
        case 'terminal_disabled':
            return t('terminalEmbedded.errors.disabled');
        case 'cli_update_required':
            return t('deps.ui.notAvailableUpdateCli');
        default:
            return null;
    }
}

function parseAskUserQuestionAnswersFromToolResult(result: unknown): Record<string, string> | null {
    if (!result || typeof result !== 'object') return null;
    const maybeAnswers = (result as any).answers;
    if (!maybeAnswers || typeof maybeAnswers !== 'object' || Array.isArray(maybeAnswers)) return null;

    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(maybeAnswers as Record<string, unknown>)) {
        if (typeof value === 'string') {
            answers[key] = value;
        }
    }
    return answers;
}

// Styles MUST be defined outside the component to prevent infinite re-renders
// with react-native-unistyles. The theme is passed as a function parameter.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    questionSection: {
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surface.elevated,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginBottom: 4,
    },
    headerText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text.primary,
        marginBottom: 8,
    },
    optionsContainer: {
        gap: 4,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 10,
        minHeight: 44, // Minimum touch target for mobile
    },
    optionButtonSelected: {
        backgroundColor: theme.colors.surface.inset,
        borderColor: theme.colors.radio.active,
    },
    optionButtonDisabled: {
        opacity: 0.6,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.text.secondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    radioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    checkboxOuter: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: theme.colors.text.secondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    checkboxOuterSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
    optionContent: {
        flex: 1,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text.primary,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginTop: 2,
    },
    freeformInput: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 14,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.surface.base,
        minHeight: 44,
    },
    freeformDescription: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginTop: 6,
        marginLeft: 2,
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
        justifyContent: 'flex-end',
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44, // Minimum touch target for mobile
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 14,
        fontWeight: '600',
    },
    submittedContainer: {
        gap: 8,
    },
    submittedItem: {
        flexDirection: 'row',
        gap: 8,
    },
    submittedHeader: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    submittedValue: {
        fontSize: 13,
        color: theme.colors.text.primary,
        flex: 1,
    },
}));

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId, interaction }) => {
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
    const [freeformAnswers, setFreeformAnswers] = React.useState<Map<number, string>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [isSubmitted, setIsSubmitted] = React.useState(false);
    const [submissionGuidance, setSubmissionGuidance] = React.useState<SubmissionFailureGuidance | null>(null);
    const [, setWorkspaceTrust] = useSettingMutable('claudeUnifiedTerminalWorkspaceTrust');
    const [, setResumeChoice] = useSettingMutable('claudeUnifiedTerminalResumeChoice');
    const attachedSessionTerminal = useOpenAttachedSessionTerminal(sessionId ?? null);
    const session = useSession(sessionId ?? '');

    // Parse input
    const input = tool.input as AskUserQuestionInput | undefined;
    const questions = input
        ? resolveClaudeUnifiedDialogQuestionPresentation(input, (key) => t(key)).questions as Question[]
        : undefined;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
        return null;
    }

    const isRunning = tool.state === 'running';
    const canApprovePermissions = interaction?.canApprovePermissions ?? true;
    const toolCallId = resolvePermissionRequestId(tool);
    const activeMatchingRequest = toolCallId ? (session as any)?.agentState?.requests?.[toolCallId] : null;
    const hasActiveAskUserQuestionRequest =
        activeMatchingRequest?.tool === 'AskUserQuestion' &&
        resolveAgentRequestKind({ toolName: activeMatchingRequest.tool, requestKind: activeMatchingRequest.kind }) === 'user_action';
    const canInteract = isRunning && !isSubmitted && canApprovePermissions && hasActiveAskUserQuestionRequest;
    const disabledMessage =
        interaction?.permissionDisabledReason === 'public'
            ? t('session.sharing.permissionApprovalsDisabledPublic')
            : interaction?.permissionDisabledReason === 'readOnly'
                ? t('session.sharing.permissionApprovalsDisabledReadOnly')
                : t('session.sharing.permissionApprovalsDisabledNotGranted');
    const isAttachedTerminalNotice = isClaudeUnifiedOpenTerminalNotice(input?.happierDialog);
    const hasAttachedTerminalSecondaryAction = hasClaudeUnifiedOpenTerminalSecondaryAction(input?.happierDialog);
    const canOpenAttachedTerminal = Boolean(
        sessionId
        && isRunning
        && canApprovePermissions
        && attachedSessionTerminal.available,
    );
    const attachedTerminalUnavailableMessage = resolveAttachedTerminalUnavailableMessage(
        attachedSessionTerminal.unavailableReason,
    );

    if (isAttachedTerminalNotice && tool.state !== 'completed') {
        const question = questions[0];
        return (
            <ToolSectionView>
                <View testID="ask-user-question" style={styles.container}>
                    <View style={styles.questionSection}>
                        <View style={styles.headerChip}>
                            <Text style={styles.headerText}>{question?.header}</Text>
                        </View>
                        <Text style={styles.questionText}>{question?.question}</Text>
                        {canOpenAttachedTerminal ? (
                            <TouchableOpacity
                                testID="ask-user-question.open-claude-terminal"
                                accessibilityRole="button"
                                accessibilityLabel={t('tools.askUserQuestion.claudeDialogNotice.openTerminal')}
                                style={styles.optionButton}
                                onPress={attachedSessionTerminal.open}
                                activeOpacity={0.7}
                            >
                                <Icon name="terminal" size={20} color={theme.colors.text.secondary} />
                                <View style={styles.optionContent}>
                                    <Text style={styles.optionLabel}>{t('tools.askUserQuestion.claudeDialogNotice.openTerminal')}</Text>
                                    <Text style={styles.optionDescription}>{t('tools.askUserQuestion.claudeDialogNotice.description')}</Text>
                                </View>
                            </TouchableOpacity>
                        ) : !canApprovePermissions ? (
                            <Text style={styles.optionDescription}>{disabledMessage}</Text>
                        ) : isRunning && attachedTerminalUnavailableMessage ? (
                            <Text
                                testID="ask-user-question.attached-terminal-unavailable"
                                style={styles.optionDescription}
                            >
                                {attachedTerminalUnavailableMessage}
                            </Text>
                        ) : null}
                    </View>
                </View>
            </ToolSectionView>
        );
    }

    // Check if all questions have at least one selection
    const allQuestionsAnswered = questions.every((_, qIndex) => {
        const q = questions[qIndex];
        const options = Array.isArray(q?.options) ? q.options : [];
        const hasFreeform = Boolean(q?.freeform);
        const typed = freeformAnswers.get(qIndex);
        const hasTyped = typeof typed === 'string' && typed.trim().length > 0;
        if (options.length === 0) {
            return hasTyped;
        }
        const selected = selections.get(qIndex);
        const hasSelection = Boolean(selected && selected.size > 0);
        return hasFreeform ? (hasSelection || hasTyped) : hasSelection;
    });
    const prospectivePayload = allQuestionsAnswered
        ? tryBuildAskUserQuestionAnswerPayload({
            questions,
            selections,
            freeformAnswers,
            structuredQuestionAnswersV1Supported: getStructuredQuestionAnswersV1Supported(
                session?.agentState?.capabilities,
            ),
        })
        : null;
    const requiresCliUpdate = prospectivePayload?.ok === true
        && prospectivePayload.payload.kind === 'requires_cli_update';
    const canSubmit = allQuestionsAnswered
        && prospectivePayload?.ok === true
        && prospectivePayload.payload.kind !== 'requires_cli_update';

    const handleOptionToggle = React.useCallback((questionIndex: number, optionIndex: number, multiSelect: boolean) => {
        if (!canInteract) return;

        setSelections(prev => {
            const newMap = new Map(prev);
            const currentSet = newMap.get(questionIndex) || new Set();

            if (multiSelect) {
                // Toggle for multi-select
                const newSet = new Set(currentSet);
                if (newSet.has(optionIndex)) {
                    newSet.delete(optionIndex);
                } else {
                    newSet.add(optionIndex);
                }
                newMap.set(questionIndex, newSet);
            } else {
                // Replace for single-select
                newMap.set(questionIndex, new Set([optionIndex]));
            }

            return newMap;
        });
        setSubmissionGuidance(null);

        // If the user chooses a structured option, clear any typed freeform value so we have a single source of truth.
        setFreeformAnswers((prev) => {
            if (!prev.has(questionIndex)) return prev;
            const next = new Map(prev);
            next.delete(questionIndex);
            return next;
        });
    }, [canInteract]);

    const handleSubmit = React.useCallback(async () => {
        if (!sessionId || !allQuestionsAnswered || isSubmitting) return;

        // Format answers as readable text
        const responseLines: string[] = [];
        questions.forEach((q, qIndex) => {
            const options = Array.isArray(q.options) ? q.options : [];
            const typed = freeformAnswers.get(qIndex);
            const typedText = typeof typed === 'string' ? typed.trim() : '';
            if (options.length === 0) {
                if (typedText.length > 0) {
                    responseLines.push(`${q.header}: ${typedText}`);
                }
                return;
            }

            const selected = selections.get(qIndex);
            if (typedText.length > 0) {
                responseLines.push(`${q.header}: ${typedText}`);
                return;
            }
            if (selected && selected.size > 0) {
                const selectedLabelsArray = Array.from(selected)
                    .map(optIndex => options[optIndex]?.label)
                    .filter(Boolean);
                const selectedLabelsText = selectedLabelsArray.join(', ');
                responseLines.push(`${q.header}: ${selectedLabelsText}`);
            }
        });

        const responseText = responseLines.join('\n');

        try {
            if (!toolCallId) {
                Modal.alert(t('common.error'), t('errors.missingPermissionId'));
                return;
            }

            const latestSession = storage.getState().sessions[sessionId];
            const latestRequest = (latestSession as any)?.agentState?.requests?.[toolCallId];
            const hasLiveMatchingRequest =
                latestRequest?.tool === 'AskUserQuestion' &&
                resolveAgentRequestKind({ toolName: latestRequest.tool, requestKind: latestRequest.kind }) === 'user_action';
            if (!hasLiveMatchingRequest) {
                return;
            }

            const payload = buildAskUserQuestionAnswerPayload({
                questions,
                selections,
                freeformAnswers,
                structuredQuestionAnswersV1Supported: getStructuredQuestionAnswersV1Supported(
                    latestSession?.agentState?.capabilities,
                ),
            });
            if (payload.kind === 'requires_cli_update') {
                Modal.alert(t('common.error'), t('deps.ui.notAvailableUpdateCli'));
                return;
            }

            setIsSubmitting(true);
            setSubmissionGuidance(null);

            // HACK: Disable the form immediately by switching to the submitted view.
            // Without this, users could edit their selections while the network calls
            // are in flight, but those edits would be ignored since we've already
            // captured the values above. TODO: Revisit this logic.
            setIsSubmitted(true);

            await sessionAllowWithAnswers(sessionId, toolCallId, payload.send);
            const dialog = input?.happierDialog;
            if (dialog && typeof dialog === 'object' && !Array.isArray(dialog)) {
                const metadata = dialog as Record<string, unknown>;
                if (isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(latestRequest) && metadata.kind === 'recognized') {
                    for (const [questionIndex, selectedIndexes] of selections) {
                        for (const optionIndex of selectedIndexes) {
                            const mutation = questions[questionIndex]?.options?.[optionIndex]?.settingMutation;
                            if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) continue;
                            const candidate = mutation as Record<string, unknown>;
                            if (
                                metadata.dialogId === 'trust_folder'
                                && candidate.settingId === 'claudeUnifiedTerminalWorkspaceTrust'
                                && (
                                    candidate.value === 'always_trust_happier_workspaces'
                                    || candidate.value === 'always_reject_happier_workspaces'
                                )
                            ) {
                                setWorkspaceTrust(candidate.value);
                            } else if (
                                metadata.dialogId === 'resume_choice'
                                && candidate.settingId === 'claudeUnifiedTerminalResumeChoice'
                                && (
                                    candidate.value === 'resume_from_summary'
                                    || candidate.value === 'resume_full_session'
                                )
                            ) {
                                setResumeChoice(candidate.value);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            setIsSubmitted(false);
            const guidance = resolveSubmissionFailureGuidance(error);
            if (guidance) {
                setSubmissionGuidance(guidance);
            } else {
                Modal.alert(t('common.error'), t('errors.failedToSendMessage'));
            }
        } finally {
            setIsSubmitting(false);
        }
    }, [sessionId, questions, selections, freeformAnswers, allQuestionsAnswered, input?.happierDialog, isSubmitting, setResumeChoice, setWorkspaceTrust, toolCallId]);

    // Show submitted state
    if (isSubmitted || tool.state === 'completed') {
        const answersFromResult = parseAskUserQuestionAnswersFromToolResult(tool.result);
        return (
            <ToolSectionView>
                <View style={styles.submittedContainer}>
                    {questions.map((q, qIndex) => {
                        const selected = selections.get(qIndex);
                        const questionKey = typeof q.question === 'string' && q.question.trim().length > 0 ? q.question : q.header;
                        const options = Array.isArray(q.options) ? q.options : [];
                        const freeform = freeformAnswers.get(qIndex);
                        const selectedLabels =
                            options.length === 0
                                ? ((typeof freeform === 'string' && freeform.trim().length > 0)
                                    ? freeform.trim()
                                    : (answersFromResult?.[questionKey] ?? '-'))
                                : ((typeof freeform === 'string' && freeform.trim().length > 0)
                                    ? freeform.trim()
                                    : (selected && selected.size > 0
                                        ? Array.from(selected)
                                            .map(optIndex => options[optIndex]?.label)
                                            .filter(Boolean)
                                            .join(', ')
                                        : (answersFromResult?.[questionKey] ?? '-')));
                        return (
                            <View key={qIndex} style={styles.submittedItem}>
                                <Text style={styles.submittedHeader}>{q.header}:</Text>
                                <Text style={styles.submittedValue}>{selectedLabels}</Text>
                            </View>
                        );
                    })}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            <View testID="ask-user-question" style={styles.container}>
                {!canApprovePermissions && isRunning ? (
                    <Text style={{ color: theme.colors.text.secondary }}>
                        {disabledMessage}
                    </Text>
                ) : null}
                {hasAttachedTerminalSecondaryAction && canOpenAttachedTerminal ? (
                    <TouchableOpacity
                        testID="ask-user-question.open-claude-terminal"
                        accessibilityRole="button"
                        accessibilityLabel={t('tools.askUserQuestion.claudeDialogNotice.openTerminal')}
                        style={styles.optionButton}
                        onPress={attachedSessionTerminal.open}
                        activeOpacity={0.7}
                    >
                        <Icon name="terminal" size={20} color={theme.colors.text.secondary} />
                        <View style={styles.optionContent}>
                            <Text style={styles.optionLabel}>{t('tools.askUserQuestion.claudeDialogNotice.openTerminal')}</Text>
                            <Text style={styles.optionDescription}>{t('tools.askUserQuestion.claudeDialogNotice.description')}</Text>
                        </View>
                    </TouchableOpacity>
                ) : hasAttachedTerminalSecondaryAction && isRunning && canApprovePermissions && attachedTerminalUnavailableMessage ? (
                    <Text
                        testID="ask-user-question.attached-terminal-unavailable"
                        style={styles.optionDescription}
                    >
                        {attachedTerminalUnavailableMessage}
                    </Text>
                ) : null}
                {questions.map((question, qIndex) => {
                    const selectedOptions = selections.get(qIndex) || new Set();
                    const options = Array.isArray(question.options) ? question.options : [];

                    return (
                        <View key={qIndex} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{question.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{question.question}</Text>
                            <View style={styles.optionsContainer}>
                                {options.length === 0 || question.freeform ? (
                                    <View>
                                        <TextInput
                                            testID={`ask-user-question.freeform:${qIndex}`}
                                            style={styles.freeformInput}
                                            value={freeformAnswers.get(qIndex) ?? ''}
                                            onChangeText={(text) => {
                                                if (!canInteract) return;
                                                setFreeformAnswers((prev) => {
                                                    const next = new Map(prev);
                                                    next.set(qIndex, text);
                                                    return next;
                                                });
                                                if (options.length > 0 && text.trim().length > 0) {
                                                    setSelections((prev) => {
                                                        if (!prev.has(qIndex)) return prev;
                                                        const next = new Map(prev);
                                                        next.delete(qIndex);
                                                        return next;
                                                    });
                                                }
                                            }}
                                            placeholder={question.freeform?.placeholder ?? t('tools.askUserQuestion.otherPlaceholder')}
                                            placeholderTextColor={theme.colors.input.placeholder}
                                            editable={canInteract}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                        />
                                        {question.freeform?.description ? (
                                            <Text style={styles.freeformDescription}>{question.freeform.description}</Text>
                                        ) : null}
                                    </View>
                                ) : null}
                                {options.map((option, oIndex) => {
                                    const isSelected = selectedOptions.has(oIndex);
                                    const testID = `ask-user-question.option:${qIndex}:${oIndex}`;

                                    return (
                                        <TouchableOpacity
                                            key={oIndex}
                                            testID={testID}
                                            accessibilityRole="button"
                                            accessibilityLabel={option.label}
                                            accessibilityState={{ selected: isSelected }}
                                            style={[
                                                styles.optionButton,
                                                isSelected && styles.optionButtonSelected,
                                                !canInteract && styles.optionButtonDisabled,
                                            ]}
                                            onPress={() => handleOptionToggle(qIndex, oIndex, question.multiSelect)}
                                            disabled={!canInteract}
                                            activeOpacity={0.7}
                                        >
                                            {question.multiSelect ? (
                                                <View style={[
                                                    styles.checkboxOuter,
                                                    isSelected && styles.checkboxOuterSelected,
                                                ]}>
                                                    {isSelected && (
                                                        <Icon name="check" size={14} color={theme.colors.button.primary.tint} />
                                                    )}
                                                </View>
                                            ) : (
                                                <View style={[
                                                    styles.radioOuter,
                                                    isSelected && styles.radioOuterSelected,
                                                ]}>
                                                    {isSelected && <View style={styles.radioInner} />}
                                                </View>
                                            )}
                                            <View style={styles.optionContent}>
                                                <Text style={styles.optionLabel}>{option.label}</Text>
                                                {option.description && (
                                                    <Text style={styles.optionDescription}>{option.description}</Text>
                                                )}
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                    );
                })}

                {submissionGuidance ? (
                    <Text
                        testID="ask-user-question.submission-guidance"
                        style={styles.optionDescription}
                    >
                        {t(`tools.askUserQuestion.submissionFailures.${submissionGuidance}`)}
                    </Text>
                ) : null}

                {canInteract && (
                    <View style={styles.actionsContainer}>
                        {requiresCliUpdate ? (
                            <Text style={styles.optionDescription}>{t('deps.ui.notAvailableUpdateCli')}</Text>
                        ) : null}
                        <TouchableOpacity
                            testID="ask-user-question.submit"
                            accessibilityRole="button"
                            accessibilityLabel={t('tools.askUserQuestion.submit')}
                            style={[
                                styles.submitButton,
                                (!canSubmit || isSubmitting) && styles.submitButtonDisabled,
                            ]}
                            onPress={handleSubmit}
                            disabled={!canSubmit || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivitySpinner size="small" color={theme.colors.button.primary.tint} />
                            ) : (
                                <Text style={styles.submitButtonText}>{t('tools.askUserQuestion.submit')}</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});
