import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierItemGroupBehavior, HappierPressable, useHappierItemGroupItemBehavior } from '@happier-dev/plugin-ui/presentation';
import type { InteractionTransientChoiceSelectionV1, InteractionTransientQuestionAnswerV1, InteractionTransientQuestionV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

export type TransientQuestionFormProps = Readonly<{
    questions: readonly InteractionTransientQuestionV1[];
    onAnswer(answers: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>): void;
    onCancel(): void;
}>;

const styles = StyleSheet.create((theme) => ({
    form: { gap: theme.space.s16 },
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

export function useTransientQuestionAnswers(questions: readonly InteractionTransientQuestionV1[]) {
    const [answers, setAnswers] = React.useState<Record<string, InteractionTransientQuestionAnswerV1>>({});
    const ready = questions.every((question) => hasRequiredAnswer(question, answers[question.id]));

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

    const setTextAnswer = React.useCallback((questionId: string, value: string) => setAnswers(current => ({
        ...current, [questionId]: { kind: 'text', value },
    })), []);
    return { answers, ready, setChoice, setTextAnswer };
}

export type TransientQuestionAnswerState = ReturnType<typeof useTransientQuestionAnswers>;

export function TransientQuestionFields(props: Readonly<{
    questions: readonly InteractionTransientQuestionV1[];
    state: TransientQuestionAnswerState;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { answers, setChoice, setTextAnswer } = props.state;

    return (
        <View style={styles.form}>
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
                            onChangeText={(value) => setTextAnswer(question.id, value)}
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
        </View>
    );
}

/** Standalone actions for the existing transient dialog; inline hosts share fields/state with their own footer. */
export function TransientQuestionForm(props: TransientQuestionFormProps): React.ReactElement {
    const { theme } = useUnistyles();
    const state = useTransientQuestionAnswers(props.questions);
    const { answers, ready } = state;
    return (
        <View style={styles.form}>
            <TransientQuestionFields questions={props.questions} state={state} />
            <View style={styles.actions}>
                <HappierPressable
                    testID="app-shell-question-cancel"
                    accessibilityRole="button"
                    hitReach={{ left: theme.space.s10 / 2, right: theme.space.s10 / 2 }}
                    onPress={() => { props.onCancel(); }}
                    style={styles.action}
                >
                    <Text style={styles.actionText}>{t('common.cancel')}</Text>
                </HappierPressable>
                <HappierPressable
                    testID="app-shell-question-submit"
                    accessibilityRole="button"
                    disabled={!ready}
                    hitReach={{ left: theme.space.s10 / 2, right: theme.space.s10 / 2 }}
                    onPress={() => { props.onAnswer(Object.freeze({ ...answers })); }}
                    style={[styles.action, !ready ? styles.disabled : null]}
                >
                    <Text style={styles.actionText}>{t('tools.askUserQuestion.submit')}</Text>
                </HappierPressable>
            </View>
        </View>
    );
}
