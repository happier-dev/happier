import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierItemGroupBehavior,
    HappierPressable,
    useHappierItemGroupItemBehavior,
} from '@happier-dev/plugin-ui/presentation';
import { createTransientInteractionOwner } from '@happier-dev/protocol/plugins/interactions/owner';
import type {
    InteractionTransientChoiceSelectionV1,
    InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1,
    InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionV1,
    InteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1,
    InteractionTransientRequestV1,
    InteractionTransientRequesterV1,
    InteractionTransientResultV1,
} from '@happier-dev/protocol/plugins/interactions/transientV1';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal, type CustomModalInjectedProps, type IModal } from '@/modal';
import { t } from '@/text';
import {
    composeAppShellInvocationSignal,
} from './pluginUiInvocationHost';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

const styles = StyleSheet.create((theme) => ({
    body: { maxHeight: 520, padding: theme.space.s16, gap: theme.space.s16 },
    question: { gap: theme.space.s8 },
    prompt: { color: theme.colors.text.primary, ...Typography.variant('label', 'regular') },
    choice: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        justifyContent: 'center',
    },
    choiceContent: { alignItems: 'center', flexDirection: 'row', gap: theme.space.s12 },
    choiceCopy: { flex: 1 },
    choiceIndicator: { alignItems: 'center', justifyContent: 'center', width: 20 },
    selected: { borderColor: theme.colors.text.link },
    choiceLabel: { color: theme.colors.text.primary, ...Typography.variant('label', 'regular') },
    choiceDescription: { color: theme.colors.text.secondary, ...Typography.variant('meta'), marginTop: theme.space.s2 },
    input: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        color: theme.colors.text.primary,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
    },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.space.s10 },
    action: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8, justifyContent: 'center' },
    actionText: { color: theme.colors.text.link, ...Typography.variant('label') },
    disabled: { opacity: 0.45 },
}));

type QuestionDialogProps = CustomModalInjectedProps & Readonly<{
    questions: readonly InteractionTransientQuestionV1[];
    onAnswer(answers: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>): void;
    onCancel(): void;
}>;

// The Protocol schema intentionally represents both choice question kinds in
// one branch, so Extract<..., { type: 'singleChoice' }> would be never.
type InteractionTransientChoiceQuestionV1 = Exclude<
    InteractionTransientQuestionV1,
    Readonly<{ type: 'text' }>
>;
type InteractionTransientChoiceV1 = InteractionTransientChoiceQuestionV1['choices'][number];

function isChoiceSelected(
    answer: InteractionTransientQuestionAnswerV1 | undefined,
    choiceId: string,
): boolean {
    if (answer?.kind === 'singleChoice') {
        return answer.answer.kind === 'choice' && answer.answer.choiceId === choiceId;
    }
    return answer?.kind === 'multipleChoice'
        && answer.answers.some((item) => item.kind === 'choice' && item.choiceId === choiceId);
}

function hasRequiredAnswer(
    question: InteractionTransientQuestionV1,
    answer: InteractionTransientQuestionAnswerV1 | undefined,
): boolean {
    if (!question.required) return true;
    if (question.type === 'text') return answer?.kind === 'text' && answer.value.trim().length > 0;
    if (question.type === 'singleChoice') {
        return answer?.kind === 'singleChoice'
            && (answer.answer.kind === 'choice' || answer.answer.value.trim().length > 0);
    }
    return answer?.kind === 'multipleChoice'
        && answer.answers.some((item) => item.kind === 'choice' || item.value.trim().length > 0);
}

function readTextAnswer(answer: InteractionTransientQuestionAnswerV1 | undefined): string {
    return answer?.kind === 'text' ? answer.value : '';
}

type SingleChoiceOptionProps = Readonly<{
    questionId: string;
    choice: InteractionTransientChoiceV1;
    selected: boolean;
    onPress(): void;
    itemGroupRadioIndex?: number;
    accessibilityRole?: 'radio';
}>;

function ChoiceContent(props: Readonly<{
    questionId: string;
    choice: InteractionTransientChoiceV1;
    selected: boolean;
    indicatorColor: string;
}>): React.ReactElement {
    return (
        <View style={styles.choiceContent}>
            <View style={styles.choiceCopy}>
                <Text style={styles.choiceLabel}>{props.choice.label}</Text>
                {props.choice.description ? <Text style={styles.choiceDescription}>{props.choice.description}</Text> : null}
            </View>
            <View style={styles.choiceIndicator}>
                {props.selected ? (
                    <Icon
                        testID={`app-shell-question-${props.questionId}-choice-${props.choice.id}-selected-indicator`}
                        name="check-circle"
                        size={20}
                        color={props.indicatorColor}
                        weight="fill"
                    />
                ) : null}
            </View>
        </View>
    );
}

function SingleChoiceOption(props: SingleChoiceOptionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const groupItem = useHappierItemGroupItemBehavior({
        role: 'radio',
        itemGroupRadioIndex: props.itemGroupRadioIndex,
    });

    return (
        <HappierPressable
            controlRef={groupItem.grouped ? groupItem.targetRef : undefined}
            testID={`app-shell-question-${props.questionId}-choice-${props.choice.id}`}
            accessibilityRole="radio"
            checked={props.selected}
            accessibilityLabel={props.choice.label}
            tabIndex={isWeb && groupItem.grouped
                ? groupItem.tabStopIndex === props.itemGroupRadioIndex ? 0 : -1
                : undefined}
            onKeyDown={groupItem.onKeyDown}
            // The radio rows touch inside their group: each hit area stays on its own row.
            hitReach={{ top: 0, bottom: 0 }}
            onPress={props.onPress}
            style={[styles.choice, props.selected ? styles.selected : null]}
        >
            <ChoiceContent
                questionId={props.questionId}
                choice={props.choice}
                selected={props.selected}
                indicatorColor={theme.colors.text.link}
            />
        </HappierPressable>
    );
}

function SingleChoiceQuestionOptions(props: Readonly<{
    question: InteractionTransientChoiceQuestionV1;
    answer: InteractionTransientQuestionAnswerV1 | undefined;
    onSelect(choiceId: string): void;
}>): React.ReactElement {
    const isWeb = Platform.OS === 'web';
    return (
        <HappierItemGroupBehavior
            accessibilityRole="radiogroup"
            accessibilityLabel={props.question.prompt}
            selectableItemCount={props.question.choices.length}
            renderContent={(choices) => (
                <View
                    testID={`app-shell-question-${props.question.id}-group`}
                    accessibilityRole={isWeb ? undefined : 'radiogroup'}
                    accessibilityLabel={props.question.prompt}
                    role={isWeb ? 'radiogroup' : undefined}
                    aria-label={isWeb ? props.question.prompt : undefined}
                >
                    {choices}
                </View>
            )}
        >
            {props.question.choices.map((choice) => (
                <SingleChoiceOption
                    key={choice.id}
                    accessibilityRole="radio"
                    questionId={props.question.id}
                    choice={choice}
                    selected={isChoiceSelected(props.answer, choice.id)}
                    onPress={() => props.onSelect(choice.id)}
                />
            ))}
        </HappierItemGroupBehavior>
    );
}

export function AppShellQuestionDialog(props: QuestionDialogProps): React.ReactElement {
    const { theme } = useUnistyles();
    const [answers, setAnswers] = React.useState<Record<string, InteractionTransientQuestionAnswerV1>>({});
    const ready = props.questions.every((question) => hasRequiredAnswer(question, answers[question.id]));

    const setChoice = React.useCallback((
        question: InteractionTransientQuestionV1,
        next: InteractionTransientChoiceSelectionV1,
    ) => {
        setAnswers((current) => {
            if (question.type === 'singleChoice') {
                return { ...current, [question.id]: { kind: 'singleChoice', answer: next } };
            }
            if (question.type !== 'multipleChoice') return current;
            const prior = current[question.id];
            const items: InteractionTransientChoiceSelectionV1[] = prior?.kind === 'multipleChoice'
                ? [...prior.answers]
                : [];
            const key = next.kind === 'choice' ? `choice:${next.choiceId}` : 'custom';
            const index = items.findIndex((item) => (
                item.kind === 'choice' ? `choice:${item.choiceId}` : 'custom'
            ) === key);
            if (next.kind === 'choice' && index >= 0) items.splice(index, 1);
            else if (index >= 0) items[index] = next;
            else items.push(next);
            if (items.length === 0) {
                const { [question.id]: _removed, ...rest } = current;
                return rest;
            }
            return {
                ...current,
                [question.id]: {
                    kind: 'multipleChoice',
                    answers: items as [InteractionTransientChoiceSelectionV1, ...InteractionTransientChoiceSelectionV1[]],
                },
            };
        });
    }, []);

    return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {props.questions.map((question) => (
                <View key={question.id} style={styles.question}>
                    <Text style={styles.prompt}>{question.prompt}</Text>
                    {question.description ? (
                        <Text
                            testID={`app-shell-question-${question.id}-description`}
                            style={styles.choiceDescription}
                        >
                            {question.description}
                        </Text>
                    ) : null}
                    {question.type === 'text' ? (
                        <TextInput
                            testID={`app-shell-question-${question.id}-text`}
                            accessibilityLabel={question.prompt}
                            value={readTextAnswer(answers[question.id])}
                            onChangeText={(value) => setAnswers((current) => ({
                                ...current,
                                [question.id]: { kind: 'text', value },
                            }))}
                            style={styles.input}
                        />
                    ) : (
                        <>
                            {question.type === 'singleChoice' ? (
                                <SingleChoiceQuestionOptions
                                    question={question}
                                    answer={answers[question.id]}
                                    onSelect={(choiceId) => setChoice(question, {
                                        kind: 'choice',
                                        choiceId,
                                    })}
                                />
                            ) : question.choices.map((choice) => {
                                const selected = isChoiceSelected(answers[question.id], choice.id);
                                return (
                                    <HappierPressable
                                        key={choice.id}
                                        testID={`app-shell-question-${question.id}-choice-${choice.id}`}
                                        accessibilityRole="checkbox"
                                        checked={selected}
                                        accessibilityLabel={choice.label}
                                        // The rows stand one stack gap apart: each hit area takes half of it.
                                        hitReach={{ top: theme.space.s8 / 2, bottom: theme.space.s8 / 2 }}
                                        onPress={() => setChoice(question, { kind: 'choice', choiceId: choice.id })}
                                        style={[styles.choice, selected ? styles.selected : null]}
                                    >
                                        <ChoiceContent
                                            questionId={question.id}
                                            choice={choice}
                                            selected={selected}
                                            indicatorColor={theme.colors.text.link}
                                        />
                                    </HappierPressable>
                                );
                            })}
                            {question.allowCustom ? (
                                <TextInput
                                    testID={`app-shell-question-${question.id}-custom`}
                                    accessibilityLabel={t('tools.askUserQuestion.other')}
                                    placeholder={t('tools.askUserQuestion.otherPlaceholder')}
                                    value={(() => {
                                        const answer = answers[question.id];
                                        if (answer?.kind === 'singleChoice' && answer.answer.kind === 'custom') {
                                            return answer.answer.value;
                                        }
                                        if (answer?.kind === 'multipleChoice') {
                                            return answer.answers.find((item) => item.kind === 'custom')?.value ?? '';
                                        }
                                        return '';
                                    })()}
                                    onChangeText={(value) => setChoice(question, { kind: 'custom', value })}
                                    style={styles.input}
                                />
                            ) : null}
                        </>
                    )}
                </View>
            ))}
            <View style={styles.actions}>
                <HappierPressable
                    testID="app-shell-question-cancel"
                    accessibilityRole="button"
                    hitReach={{ left: theme.space.s10 / 2, right: theme.space.s10 / 2 }}
                    onPress={() => { props.onCancel(); props.onClose(); }}
                    style={styles.action}
                >
                    <Text style={styles.actionText}>{t('common.cancel')}</Text>
                </HappierPressable>
                <HappierPressable
                    testID="app-shell-question-submit"
                    accessibilityRole="button"
                    disabled={!ready}
                    hitReach={{ left: theme.space.s10 / 2, right: theme.space.s10 / 2 }}
                    onPress={() => { props.onAnswer(Object.freeze({ ...answers })); props.onClose(); }}
                    style={[styles.action, !ready ? styles.disabled : null]}
                >
                    <Text style={styles.actionText}>{t('tools.askUserQuestion.submit')}</Text>
                </HappierPressable>
            </View>
        </ScrollView>
    );
}

type QuestionModal = Pick<IModal, 'show' | 'hide'>;

/** Host-private chrome only; it never changes the stamped Interaction request. */
type AppShellTransientConfirmationPresentation = Readonly<{
    confirmLabel?: string;
    /** `null` preserves an author request that intentionally omitted a heading. */
    title?: string | null;
}>;

function readConfirmationPresentation(
    value: unknown,
): AppShellTransientConfirmationPresentation | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const confirmLabel = record.confirmLabel;
    const title = record.title;
    const hasTitle = title === null || (typeof title === 'string' && title.trim().length > 0);
    return (
        (typeof confirmLabel === 'string' && confirmLabel.trim().length > 0) || hasTitle
    )
        ? Object.freeze({
            ...(typeof confirmLabel === 'string' && confirmLabel.trim().length > 0 ? { confirmLabel } : {}),
            ...(hasTitle ? { title: title as string | null } : {}),
        })
        : null;
}

type ConfirmationDialogProps = CustomModalInjectedProps & Readonly<{
    description: string;
    confirmLabel: string;
    onConfirm(): void;
    onCancel(): void;
}>;

export function AppShellConfirmationDialog(props: ConfirmationDialogProps): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={styles.body}>
            <Text style={styles.prompt}>{props.description}</Text>
            <View style={styles.actions}>
                {/*
                  * This control settles `declined` — an explicit negative
                  * DECISION the requester acts on — while dismissing the dialog
                  * settles `userCancelled`. Labelling it "Cancel" told the user
                  * it did the same thing as walking away, so it names the
                  * decision it actually makes.
                  */}
                <HappierPressable
                    testID="app-shell-confirmation-decline"
                    accessibilityRole="button"
                    hitReach={{ left: theme.space.s10 / 2, right: theme.space.s10 / 2 }}
                    onPress={() => { props.onCancel(); props.onClose(); }}
                    style={styles.action}
                >
                    <Text style={styles.actionText}>{t('common.decline')}</Text>
                </HappierPressable>
                <HappierPressable
                    testID="app-shell-confirmation-confirm"
                    accessibilityRole="button"
                    hitReach={{ left: theme.space.s10 / 2, right: theme.space.s10 / 2 }}
                    onPress={() => { props.onConfirm(); props.onClose(); }}
                    style={styles.action}
                >
                    <Text style={styles.actionText}>{props.confirmLabel}</Text>
                </HappierPressable>
            </View>
        </View>
    );
}

function unavailableCandidate(request: InteractionTransientRequestV1): InteractionTransientResultV1 {
    if (request.kind === 'questions') {
        return Object.freeze({ requestId: request.requestId, kind: 'questions', status: 'unavailable' });
    }
    if (request.kind === 'approval') {
        return Object.freeze({ requestId: request.requestId, kind: 'approval', status: 'unavailable' });
    }
    return Object.freeze({ requestId: request.requestId, kind: 'confirmation', status: 'unavailable' });
}

function userCancelledCandidate(request: InteractionTransientRequestV1): InteractionTransientResultV1 {
    if (request.kind === 'questions') {
        return Object.freeze({ requestId: request.requestId, kind: 'questions', status: 'userCancelled' });
    }
    if (request.kind === 'approval') {
        return Object.freeze({ requestId: request.requestId, kind: 'approval', status: 'userCancelled' });
    }
    return Object.freeze({ requestId: request.requestId, kind: 'confirmation', status: 'userCancelled' });
}

/**
 * Presentation-only adapter for a request already normalized and stamped by
 * the current-Session interaction owner. It returns a candidate; that owner
 * alone validates currentness and settles the interaction lifecycle.
 */
export async function presentAppShellTransientInteraction(input: Readonly<{
    request: InteractionTransientRequestV1;
    signal: AbortSignal;
    modal?: QuestionModal;
    presentationContext?: unknown;
}>): Promise<InteractionTransientResultV1> {
    if (input.signal.aborted) return unavailableCandidate(input.request);
    const modal = input.modal ?? Modal;
    return await new Promise<InteractionTransientResultV1>((resolve) => {
        let modalId = '';
        const complete = (candidate: InteractionTransientResultV1, hide = false) => {
            input.signal.removeEventListener('abort', abort);
            if (hide && modalId) modal.hide(modalId);
            resolve(candidate);
        };
        const abort = () => complete(unavailableCandidate(input.request), true);
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) {
            abort();
            return;
        }

        if (input.request.kind === 'questions') {
            const request = input.request;
            modalId = modal.show({
                component: AppShellQuestionDialog,
                props: {
                    questions: request.questions,
                    onAnswer: (answers) => complete({
                        requestId: request.requestId,
                        kind: 'questions',
                        status: 'answered',
                        answers: { ...answers },
                    }),
                    onCancel: () => complete(userCancelledCandidate(request)),
                },
                onRequestClose: () => complete(userCancelledCandidate(request)),
                onHostUnmount: () => complete(unavailableCandidate(request)),
                chrome: {
                    kind: 'card',
                    title: request.title ?? t('tools.askUserQuestion.submit'),
                    testID: 'app-shell-question-dialog',
                    bodyScroll: 'auto',
                    dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.85, size: 'dialog' },
                },
                closeOnBackdrop: true,
            });
        } else {
            const request = input.request;
            const presentation = readConfirmationPresentation(input.presentationContext);
            const description = request.kind === 'confirmation'
                ? request.message
                : request.description ?? request.subject.name;
            const title = presentation && Object.prototype.hasOwnProperty.call(presentation, 'title')
                ? presentation.title ?? undefined
                : request.title;
            modalId = modal.show({
                component: AppShellConfirmationDialog,
                props: {
                    description,
                    confirmLabel: presentation?.confirmLabel ?? t('common.ok'),
                    onConfirm: () => complete(request.kind === 'approval'
                        ? { requestId: request.requestId, kind: 'approval', status: 'approved' }
                        : { requestId: request.requestId, kind: 'confirmation', status: 'approved' }),
                    onCancel: () => complete(request.kind === 'approval'
                        ? { requestId: request.requestId, kind: 'approval', status: 'declined' }
                        : { requestId: request.requestId, kind: 'confirmation', status: 'declined' }),
                },
                onRequestClose: () => complete(userCancelledCandidate(request)),
                onHostUnmount: () => complete(unavailableCandidate(request)),
                chrome: {
                    kind: 'card',
                    ...(title === undefined ? {} : { title }),
                    testID: 'app-shell-transient-interaction-dialog',
                    dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.7, size: 'dialog' },
                },
                closeOnBackdrop: true,
            });
        }
        if (!modalId) complete(unavailableCandidate(input.request));
    });
}

/**
 * Thin present-user app adapter over the Protocol lifecycle owner. The active
 * app-shell invocation supplies identity, cancellation and currentness; the
 * Protocol owner settles the interaction on its lifecycle or the user's answer.
 */
export function createAppShellTransientInteractions(input: Readonly<{
    requester: InteractionTransientRequesterV1;
    signal: AbortSignal;
    isCurrent(): boolean;
    modal?: QuestionModal;
}>): Readonly<{
    askQuestions(
        request: InteractionTransientQuestionsAuthorRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<InteractionTransientQuestionsResultV1>;
    confirm(
        request: InteractionTransientConfirmationAuthorRequestV1,
        options?: Readonly<{
            signal?: AbortSignal;
            presentationContext?: unknown;
        }>,
    ): Promise<InteractionTransientConfirmationResultV1>;
}> {
    const owner = createTransientInteractionOwner({
        scope: Object.freeze({ kind: 'app' }),
        isOccurrenceCurrent: input.isCurrent,
        deadlineMs: null,
        present: async (request, options) => await presentAppShellTransientInteraction({
            request,
            signal: options.signal,
            ...(input.modal ? { modal: input.modal } : {}),
            ...(options.presentationContext === undefined
                ? {}
                : { presentationContext: options.presentationContext }),
        }),
    });
    return Object.freeze({
        async askQuestions(request, options) {
            const operation = composeAppShellInvocationSignal(input.signal, options?.signal);
            try {
                const result = await owner.request(request, {
                    requester: input.requester,
                    signal: operation.signal,
                });
                if (result.kind !== 'questions') {
                    throw new Error('Transient interaction owner returned an incompatible question result');
                }
                return result;
            } finally {
                operation.dispose();
            }
        },
        async confirm(request, options) {
            const operation = composeAppShellInvocationSignal(input.signal, options?.signal);
            try {
                const result = await owner.request(request, {
                    requester: input.requester,
                    signal: operation.signal,
                    ...(options?.presentationContext === undefined
                        ? {}
                        : { presentationContext: options.presentationContext }),
                });
                if (result.kind !== 'confirmation') {
                    throw new Error('Transient interaction owner returned an incompatible confirmation result');
                }
                return result;
            } finally {
                operation.dispose();
            }
        },
    });
}
