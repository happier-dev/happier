import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { resolvePermissionRequestId } from '../core/resolvePermissionRequestId';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { sessionAllowWithAnswers } from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveAgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    buildAskUserQuestionAnswerPayload,
    normalizeAskUserQuestionRenderQuestions,
    tryBuildAskUserQuestionAnswerPayload,
} from './buildAskUserQuestionAnswerPayload';
import { getStructuredQuestionAnswersV1Supported } from '@/sync/domains/state/agentStateCapabilities';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { PUBLIC_RPC_HANDLER_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import {
    isAskUserQuestionToolName,
    resolveStructuredQuestionOptionAnswerValue,
    STRUCTURED_QUESTION_LIMITS,
} from '@happier-dev/protocol';


interface QuestionOption {
    label: string;
    description: string;
    value?: string;
    choice?: string;
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
}

function readRenderableQuestion(value: unknown): Partial<Question> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<Question>
        : {};
}

function parseAskUserQuestionAnswersFromToolResult(result: unknown): Record<string, readonly string[]> | null {
    if (!result || typeof result !== 'object') return null;
    const record = result as Record<string, unknown>;
    const maybeAnswers = record.structuredAnswersV1 ?? record.answers;
    if (!maybeAnswers || typeof maybeAnswers !== 'object' || Array.isArray(maybeAnswers)) return null;

    const answers = Object.create(null) as Record<string, readonly string[]>;
    for (const [key, value] of Object.entries(maybeAnswers as Record<string, unknown>)) {
        if (Array.isArray(value) && value.every((item) => typeof item === 'string')) answers[key] = value as string[];
        else if (typeof value === 'string') answers[key] = [value];
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
    const [submissionGuidance, setSubmissionGuidance] = React.useState<'update' | 'reconnect' | null>(null);

    const input = tool.input as AskUserQuestionInput | undefined;
    const hasQuestionArray = Array.isArray(input?.questions) && input.questions.length > 0;
    const renderQuestions = hasQuestionArray
        ? normalizeAskUserQuestionRenderQuestions(input)
        : null;
    const questions = renderQuestions?.ok ? renderQuestions.questions : [];
    const hasInvalidRenderQuestions = hasQuestionArray && renderQuestions?.ok === false;

    const isRunning = tool.state === 'running';
    const canApprovePermissions = interaction?.canApprovePermissions ?? true;
    const toolCallId = resolvePermissionRequestId(tool);
    const structuredQuestionAnswersV1Supported = storage((state) => getStructuredQuestionAnswersV1Supported(
        sessionId ? state.sessions[sessionId]?.agentState?.capabilities : undefined,
    ));
    const hasActiveAskUserQuestionRequest = storage((state) => {
        const activeMatchingRequest = sessionId && toolCallId
            ? state.sessions[sessionId]?.agentState?.requests?.[toolCallId]
            : null;
        return isAskUserQuestionToolName(activeMatchingRequest?.tool)
            && resolveAgentRequestKind({
                toolName: activeMatchingRequest.tool,
                requestKind: activeMatchingRequest.kind,
            }) === 'user_action';
    });
    const canInteract = isRunning && !isSubmitted && canApprovePermissions && hasActiveAskUserQuestionRequest;
    const disabledMessage =
        interaction?.permissionDisabledReason === 'public'
            ? t('session.sharing.permissionApprovalsDisabledPublic')
            : interaction?.permissionDisabledReason === 'readOnly'
                ? t('session.sharing.permissionApprovalsDisabledReadOnly')
                : t('session.sharing.permissionApprovalsDisabledNotGranted');

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
    const prospectiveBuild = allQuestionsAnswered
        ? tryBuildAskUserQuestionAnswerPayload({
            questions,
            selections,
            freeformAnswers,
            structuredQuestionAnswersV1Supported,
        })
        : null;
    const prospectivePayload = prospectiveBuild?.ok ? prospectiveBuild.payload : null;
    const hasProspectivePayloadError = prospectiveBuild?.ok === false;
    const requiresCliUpdate = prospectivePayload?.kind === 'requires_cli_update';

    const handleOptionToggle = React.useCallback((questionIndex: number, optionIndex: number, multiSelect: boolean) => {
        if (!canInteract) return;
        setSubmissionGuidance(null);

        setSelections(prev => {
            const newMap = new Map(prev);
            const currentSet = newMap.get(questionIndex) || new Set();

            if (multiSelect) {
                // Toggle for multi-select
                const newSet = new Set(currentSet);
                if (newSet.has(optionIndex)) {
                    newSet.delete(optionIndex);
                } else if (newSet.size >= STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion) {
                    return prev;
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

        try {
            if (!toolCallId) {
                Modal.alert(t('common.error'), t('errors.missingPermissionId'));
                return;
            }

            const latestSession = storage.getState().sessions[sessionId];
            const latestRequest = latestSession?.agentState?.requests?.[toolCallId];
            const hasLiveMatchingRequest =
                isAskUserQuestionToolName(latestRequest?.tool) &&
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
                setSubmissionGuidance('update');
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
        } catch (error) {
            setIsSubmitted(false);
            const errorCode = readRpcErrorCode(error);
            if (errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE || errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
                setSubmissionGuidance('update');
            } else if (
                errorCode === PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER
                || errorCode === PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID
                || errorCode === PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID
                || errorCode === PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_AMBIGUOUS
            ) {
                setSubmissionGuidance('reconnect');
            } else {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
            }
        } finally {
            setIsSubmitting(false);
        }
    }, [sessionId, questions, selections, freeformAnswers, allQuestionsAnswered, isSubmitting, toolCallId]);

    if (!hasQuestionArray) return null;
    if (hasInvalidRenderQuestions) {
        return (
            <ToolSectionView>
                <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.text.secondary }}>
                    {t('errors.failedToSendMessage')}
                </Text>
            </ToolSectionView>
        );
    }

    // Show submitted state
    if (isSubmitted || tool.state === 'completed') {
        const answersFromResult = parseAskUserQuestionAnswersFromToolResult(tool.result);
        return (
            <ToolSectionView>
                <View style={styles.submittedContainer}>
                    {questions.map((rawQuestion, qIndex) => {
                        const q = readRenderableQuestion(rawQuestion);
                        const selected = selections.get(qIndex);
                        const questionKey = typeof q.responseKey === 'string'
                            ? q.responseKey
                            : typeof q.question === 'string' && q.question.trim().length > 0
                            ? q.question
                            : typeof q.header === 'string'
                                ? q.header
                                : '';
                        const options = Array.isArray(q.options) ? q.options : [];
                        const freeform = freeformAnswers.get(qIndex);
                        const displayedResultAnswers = answersFromResult?.[questionKey]?.map((answer: string) => (
                            options.find((option) => resolveStructuredQuestionOptionAnswerValue(option) === answer)?.label
                            ?? answer
                        ));
                        const selectedLabels =
                            options.length === 0
                                ? ((typeof freeform === 'string' && freeform.trim().length > 0)
                                    ? freeform.trim()
                                    : (displayedResultAnswers?.join(', ') ?? '-'))
                                : ((typeof freeform === 'string' && freeform.trim().length > 0)
                                    ? freeform.trim()
                                    : (selected && selected.size > 0
                                        ? Array.from(selected)
                                            .map(optIndex => options[optIndex]?.label)
                                            .filter(Boolean)
                                            .join(', ')
                                        : (displayedResultAnswers?.join(', ') ?? '-')));
                        return (
                            <View key={qIndex} style={styles.submittedItem}>
                                <Text style={styles.submittedHeader}>{typeof q.header === 'string' ? q.header : ''}:</Text>
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
                {(requiresCliUpdate || submissionGuidance === 'update') ? (
                    <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.text.secondary }}>
                        {t('deps.ui.notAvailableUpdateCli')}
                    </Text>
                ) : submissionGuidance === 'reconnect' || hasProspectivePayloadError ? (
                    <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.text.secondary }}>
                        {t('errors.failedToSendMessage')}
                    </Text>
                ) : null}
                {questions.map((rawQuestion, qIndex) => {
                    const question = readRenderableQuestion(rawQuestion);
                    const selectedOptions = selections.get(qIndex) || new Set();
                    const options = Array.isArray(question.options) ? question.options : [];
                    const selectionLimitReached = question.multiSelect === true
                        && selectedOptions.size >= STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion;

                    return (
                        <View key={qIndex} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{typeof question.header === 'string' ? question.header : ''}</Text>
                            </View>
                            <Text style={styles.questionText}>{typeof question.question === 'string' ? question.question : ''}</Text>
                            <View style={styles.optionsContainer}>
                                {options.length === 0 || question.freeform ? (
                                    <View>
                                        <TextInput
                                            testID={`ask-user-question.freeform:${qIndex}`}
                                            style={styles.freeformInput}
                                            value={freeformAnswers.get(qIndex) ?? ''}
                                            onChangeText={(text) => {
                                                if (!canInteract) return;
                                                setSubmissionGuidance(null);
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
                                            maxLength={STRUCTURED_QUESTION_LIMITS.maxStringLength}
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
                                    const isOptionDisabled = !canInteract || (selectionLimitReached && !isSelected);
                                    const testID = `ask-user-question.option:${qIndex}:${oIndex}`;

                                    return (
                                        <TouchableOpacity
                                            key={oIndex}
                                            testID={testID}
                                            accessibilityRole="button"
                                            accessibilityLabel={option.label}
                                            style={[
                                                styles.optionButton,
                                                isSelected && styles.optionButtonSelected,
                                                isOptionDisabled && styles.optionButtonDisabled,
                                            ]}
                                            onPress={() => handleOptionToggle(qIndex, oIndex, question.multiSelect === true)}
                                            disabled={isOptionDisabled}
                                            activeOpacity={0.7}
                                        >
                                            {question.multiSelect === true ? (
                                                <View style={[
                                                    styles.checkboxOuter,
                                                    isSelected && styles.checkboxOuterSelected,
                                                ]}>
                                                    {isSelected && (
                                                        <Ionicons name="checkmark" size={14} color={theme.colors.button.primary.tint} />
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
                                {selectionLimitReached ? (
                                    <Text accessibilityLiveRegion="polite" style={styles.freeformDescription}>
                                        {t('tools.askUserQuestion.selectionLimit', {
                                            count: STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion,
                                        })}
                                    </Text>
                                ) : null}
                            </View>
                        </View>
                    );
                })}

                {canInteract && (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            testID="ask-user-question.submit"
                            accessibilityRole="button"
                            accessibilityLabel={t('tools.askUserQuestion.submit')}
                            style={[
                                styles.submitButton,
                                (!allQuestionsAnswered || isSubmitting || requiresCliUpdate || hasProspectivePayloadError) && styles.submitButtonDisabled,
                            ]}
                            onPress={handleSubmit}
                            disabled={!allQuestionsAnswered || isSubmitting || requiresCliUpdate || hasProspectivePayloadError}
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
