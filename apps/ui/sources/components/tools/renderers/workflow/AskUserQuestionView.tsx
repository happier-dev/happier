import * as React from 'react';
import { View, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { sessionAllowWithAnswers } from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveAgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';


interface QuestionOption {
    label: string;
    description: string;
}

interface Question {
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
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginBottom: 4,
    },
    headerText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
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
        borderColor: theme.colors.divider,
        gap: 10,
        minHeight: 44, // Minimum touch target for mobile
    },
    optionButtonSelected: {
        backgroundColor: theme.colors.surfaceHigh,
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
        borderColor: theme.colors.textSecondary,
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
        borderColor: theme.colors.textSecondary,
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
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    freeformInput: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 14,
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
        minHeight: 44,
    },
    freeformDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
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
        color: theme.colors.textSecondary,
    },
    submittedValue: {
        fontSize: 13,
        color: theme.colors.text,
        flex: 1,
    },
}));

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId, interaction }) => {
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
    const [freeformAnswers, setFreeformAnswers] = React.useState<Map<number, string>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [isSubmitted, setIsSubmitted] = React.useState(false);

    // Parse input
    const input = tool.input as AskUserQuestionInput | undefined;
    const questions = input?.questions;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
        return null;
    }

    const isRunning = tool.state === 'running';
    const canApprovePermissions = interaction?.canApprovePermissions ?? true;
    const toolCallId = tool.permission?.id;
    const session = sessionId ? storage.getState().sessions[sessionId] : undefined;
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
        const answers: Record<string, string> = {};
        questions.forEach((q, qIndex) => {
            const questionKey = typeof q.question === 'string' && q.question.trim().length > 0 ? q.question : q.header;
            const options = Array.isArray(q.options) ? q.options : [];
            const typed = freeformAnswers.get(qIndex);
            const typedText = typeof typed === 'string' ? typed.trim() : '';
            if (options.length === 0) {
                if (typedText.length > 0) {
                    responseLines.push(`${q.header}: ${typedText}`);
                    answers[questionKey] = typedText;
                }
                return;
            }

            const selected = selections.get(qIndex);
            if (typedText.length > 0) {
                responseLines.push(`${q.header}: ${typedText}`);
                answers[questionKey] = typedText;
                return;
            }
            if (selected && selected.size > 0) {
                const selectedLabelsArray = Array.from(selected)
                    .map(optIndex => options[optIndex]?.label)
                    .filter(Boolean);
                const selectedLabelsText = selectedLabelsArray.join(', ');
                responseLines.push(`${q.header}: ${selectedLabelsText}`);
                answers[questionKey] = selectedLabelsText;
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

            setIsSubmitting(true);

            // HACK: Disable the form immediately by switching to the submitted view.
            // Without this, users could edit their selections while the network calls
            // are in flight, but those edits would be ignored since we've already
            // captured the values above. TODO: Revisit this logic.
            setIsSubmitted(true);

            await sessionAllowWithAnswers(sessionId, toolCallId, answers);
            setIsSubmitted(true);
        } catch (error) {
            setIsSubmitted(false);
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
        } finally {
            setIsSubmitting(false);
        }
    }, [sessionId, questions, selections, freeformAnswers, allQuestionsAnswered, isSubmitting, toolCallId]);

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
            <View style={styles.container}>
                {!canApprovePermissions && isRunning ? (
                    <Text style={{ color: theme.colors.textSecondary }}>
                        {disabledMessage}
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
                                            placeholderTextColor={theme.colors.textSecondary}
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

                                    return (
                                        <TouchableOpacity
                                            key={oIndex}
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
                            </View>
                        </View>
                    );
                })}

                {canInteract && (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            style={[
                                styles.submitButton,
                                (!allQuestionsAnswered || isSubmitting) && styles.submitButtonDisabled,
                            ]}
                            onPress={handleSubmit}
                            disabled={!allQuestionsAnswered || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
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
