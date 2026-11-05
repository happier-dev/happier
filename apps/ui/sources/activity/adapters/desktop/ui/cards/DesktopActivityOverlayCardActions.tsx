import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

import { RoundButton, type RoundButtonDisplay } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { setDesktopActivityOverlayKeyboardWanted } from '../../runtime/desktopActivityOverlayBridge';
import { DesktopActivityOverlayChip } from '../DesktopActivityOverlayChip';
import {
    createDesktopActivityOverlayFocusRingStyle,
    createDesktopActivityOverlayInteriorSurfaceStyle,
} from '../DesktopActivityOverlayChrome';
import type { DesktopActivityOverlayPressableInteractionState } from '../DesktopActivityOverlayPressableInteractionState';
import {
    isDesktopActivityOverlayDismissKey,
    readDesktopActivityOverlayEventKey,
    type DesktopActivityOverlayKeyEvent,
} from '../desktopActivityOverlayKeyboard';
import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from '../shared/desktopActivityOverlaySelectors';
import type { DesktopActivityOverlayActionDescriptor, DesktopActivityOverlayActionHandler } from '../shared/desktopActivityOverlayUiModel';
import {
    resolveDesktopActivityOverlayCardActionInstanceTestID,
    resolveDesktopActivityOverlayCardActionKindTestID,
} from '../shared/desktopActivityOverlaySelectors.mjs';

/**
 * The shared button variants on the tinted ask (owner ruling 13: every choice must read as a button):
 * the one primary action is the filled button, and every other choice, Deny and the quiet Always allow
 * alike, is the bordered one at full ink (a dimmed label read as disabled). The quiet choice leads the
 * row, so the decision still ends on the primary.
 */
function resolveActionDisplay(tone: DesktopActivityOverlayActionDescriptor['tone']): RoundButtonDisplay {
    return tone === 'primary' ? 'default' : 'secondary';
}

/** The island's controls are pills at the small control height, one family with the choice chips. */
const ACTION_CAPSULE_HEIGHT = PAGE_LIST_METRICS.smallControlHeightPx;

/** Reading order ends on the decision: quiet text, then the alternatives, then the one primary (lab `.nt-acts`). */
function rankActionTone(tone: DesktopActivityOverlayActionDescriptor['tone']): number {
    return tone === 'quiet' ? 0 : tone === 'primary' ? 2 : 1;
}

/** Hands the shared button's focus handle to the island's initial-focus ref (the route only calls `focus()`). */
function bindInitialFocusRef(ref: React.Ref<View> | undefined, node: { focus: () => void } | null): void {
    const target = node as unknown as View | null;
    if (typeof ref === 'function') ref(target);
    else if (ref) (ref as React.MutableRefObject<View | null>).current = target;
}

/**
 * A card's actions. A permission's `decision` reads quiet text, then the alternatives, then the one
 * primary, at the card's trailing edge (lab `.nt-acts`). A question's `choices` are equal answers:
 * compact chips that wrap from the leading edge in the asker's order, with a free answer ("Other")
 * that opens its own field only when chosen.
 */
export function DesktopActivityOverlayCardActions(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    cardId: string;
    actions: readonly DesktopActivityOverlayActionDescriptor[];
    layout?: 'decision' | 'choices';
    inlineQuestionText?: string | null;
    initialFocusActionId?: string | null;
    initialFocusRef?: React.Ref<View>;
    onAction?: DesktopActivityOverlayActionHandler;
    onDismissKey?: () => void;
}>): React.ReactElement | null {
    // Keep the choices until the addressed action succeeds; failures remain retryable in place.
    const [answer, setAnswer] = React.useState<string | null>(null);
    const answerWith = React.useCallback(async (action: DesktopActivityOverlayActionDescriptor, label: string) => {
        if (await props.onAction?.(action)) setAnswer(label);
    }, [props.onAction]);
    if (props.actions.length === 0) {
        return null;
    }
    if (answer !== null) {
        return <DesktopActivityOverlayAnswered cardId={props.cardId} label={answer} />;
    }
    if (props.layout === 'choices') {
        return <DesktopActivityOverlayChoiceActions {...props} onAnswer={answerWith} />;
    }
    const ordered = [...props.actions].sort((left, right) => rankActionTone(left.tone) - rankActionTone(right.tone));

    return (
        <View style={styles.decision}>
            {ordered.map((action) => (
                <View
                    key={action.id}
                    testID={resolveDesktopActivityOverlayCardActionKindTestID(action.id)}
                    style={styles.actionItem}
                >
                    <RoundButton
                        size="small"
                        capsuleHeight={ACTION_CAPSULE_HEIGHT}
                        display={resolveActionDisplay(action.tone)}
                        title={action.label}
                        accessibilityLabel={action.accessibilityLabel ?? action.label}
                        testID={resolveDesktopActivityOverlayCardActionInstanceTestID(props.cardId, action.id)}
                        controlRef={action.id === props.initialFocusActionId && props.initialFocusRef
                            ? (node) => bindInitialFocusRef(props.initialFocusRef, node)
                            : undefined}
                        onPress={() => answerWith(action, action.label)}
                    />
                </View>
            ))}
        </View>
    );
}

/** What was answered: a check and the chosen words, where the choices stood. */
function DesktopActivityOverlayAnswered(props: Readonly<{ cardId: string; label: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View testID={`desktop-activity-overlay-card-answered-${props.cardId}`} style={styles.answered}>
            <Icon name="check" size={ANSWERED_GLYPH_SIZE} color={theme.colors.state.success.foreground} />
            <Text variant="body" numberOfLines={1} style={styles.answeredText}>{props.label}</Text>
        </View>
    );
}

function DesktopActivityOverlayChoiceActions(props: React.ComponentProps<typeof DesktopActivityOverlayCardActions> & Readonly<{
    onAnswer: (action: DesktopActivityOverlayActionDescriptor, label: string) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [freeAnswerOpen, setFreeAnswerOpen] = React.useState(false);
    const [freeAnswer, setFreeAnswer] = React.useState('');
    const freeAnswerRef = React.useRef('');
    const freeAction = props.actions.find((action) => action.inputKind === 'inline_text') ?? null;
    const questionText = props.inlineQuestionText?.trim() ?? '';
    const canSendFreeAnswer = freeAnswer.trim().length > 0 && questionText.length > 0;
    const sendFreeAnswer = () => {
        const answer = freeAnswerRef.current.trim();
        if (!freeAction || !answer || !questionText) return;
        props.onAnswer({
            ...freeAction,
            data: { ...(freeAction.data ?? {}), answers: [{ question: questionText, answer }] },
        }, answer);
    };

    return (
        <View style={styles.choices}>
            <View style={styles.choiceRow}>
                {props.actions.map((action) => (
                    <View
                        key={action.id}
                        testID={resolveDesktopActivityOverlayCardActionKindTestID(action.id)}
                        style={styles.choiceItem}
                    >
                        <DesktopActivityOverlayChip
                            role="choice"
                            label={action.label}
                            accessibilityLabel={action.accessibilityLabel ?? action.label}
                            testID={resolveDesktopActivityOverlayCardActionInstanceTestID(props.cardId, action.id)}
                            controlRef={action.id === props.initialFocusActionId && props.initialFocusRef
                                ? (node) => bindInitialFocusRef(props.initialFocusRef, node as { focus: () => void } | null)
                                : undefined}
                            onPress={() => {
                                if (action.inputKind === 'inline_text') {
                                    // Opening the field is going to type: the island takes the keyboard for it.
                                    if (!freeAnswerOpen) fireAndForget(setDesktopActivityOverlayKeyboardWanted(true), { tag: 'DesktopActivityOverlayCardActions.keyboard' });
                                    setFreeAnswerOpen((open) => !open);
                                } else props.onAnswer(action, action.label);
                            }}
                        />
                    </View>
                ))}
            </View>
            {freeAction && freeAnswerOpen ? (
                <View style={styles.freeAnswer}>
                    <TextInput
                        testID={`desktop-activity-overlay-question-other-input-${props.cardId}`}
                        accessibilityLabel={freeAction.label}
                        autoFocus
                        placeholder={t('tools.askUserQuestion.otherPlaceholder')}
                        value={freeAnswer}
                        onChangeText={(value) => {
                            freeAnswerRef.current = value;
                            setFreeAnswer(value);
                        }}
                        onSubmitEditing={sendFreeAnswer}
                        returnKeyType="send"
                        // react-native-web's TextInput owns key propagation, so Escape cannot reach the
                        // expanded shell. Forward an empty answer to the route's dismissal owner; keep a
                        // typed one in place.
                        onKeyPress={(event: DesktopActivityOverlayKeyEvent) => {
                            if (!isDesktopActivityOverlayDismissKey(readDesktopActivityOverlayEventKey(event))) return;
                            if (freeAnswerRef.current.trim()) return;
                            props.onDismissKey?.();
                        }}
                        placeholderTextColor={theme.colors.text.tertiary}
                        style={[
                            styles.freeAnswerInput,
                            createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                visualMode: props.visualMode,
                                kind: 'field',
                            }),
                        ]}
                    />
                    <Pressable
                        testID={`desktop-activity-overlay-question-other-send-${props.cardId}`}
                        accessibilityRole="button"
                        accessibilityLabel={t('tools.askUserQuestion.submit')}
                        disabled={!canSendFreeAnswer}
                        onPress={sendFreeAnswer}
                        style={(state) => [
                            createDesktopActivityOverlayInteriorSurfaceStyle(theme, { visualMode: props.visualMode, kind: 'badge' }),
                            styles.freeAnswerSend,
                            !canSendFreeAnswer ? styles.disabled : null,
                            createDesktopActivityOverlayFocusRingStyle(theme, (state as DesktopActivityOverlayPressableInteractionState).focused),
                        ]}
                    >
                        <Icon name="arrow-up" size={FREE_ANSWER_SEND_GLYPH_SIZE} color={theme.colors.text.primary} />
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
}

/** The send glyph at the quiet inline-icon size, as in the quick reply field. */
const FREE_ANSWER_SEND_GLYPH_SIZE = 14;
/** The answered check, at the same quiet inline-icon size. */
const ANSWERED_GLYPH_SIZE = 14;

const styles = StyleSheet.create((theme) => ({
    // Compact actions at the card's trailing edge, each as wide as its words.
    decision: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
        gap: theme.space.s4,
    },
    actionItem: {
        flexShrink: 0,
    },
    choices: {
        gap: theme.space.s6,
    },
    // Answers wrap from the leading edge, under the question they answer.
    choiceRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: theme.space.s4,
    },
    choiceItem: {
        maxWidth: '100%',
    },
    freeAnswer: {
        position: 'relative',
    },
    freeAnswerInput: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
        width: '100%',
        minWidth: 0,
        minHeight: theme.space.s32,
        paddingLeft: theme.space.s12,
        paddingRight: theme.space.s40,
        paddingVertical: theme.space.s6,
    },
    freeAnswerSend: {
        position: 'absolute',
        right: theme.space.s4,
        top: theme.space.s4,
        width: theme.space.s24,
        height: theme.space.s24,
        borderRadius: theme.space.s12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    disabled: {
        opacity: 0.45,
    },
    answered: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minHeight: PAGE_LIST_METRICS.smallControlHeightPx,
    },
    answeredText: {
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
}));
