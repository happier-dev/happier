import * as React from 'react';
import { I18nManager, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { TextInput } from '@/components/ui/text/Text';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import {
    createDesktopActivityOverlayFocusRingStyle,
    createDesktopActivityOverlayInteriorSurfaceStyle,
} from '../DesktopActivityOverlayChrome';
import {
    isDesktopActivityOverlayDismissKey,
    readDesktopActivityOverlayEventKey,
    type DesktopActivityOverlayKeyEvent,
} from '../desktopActivityOverlayKeyboard';
import type { DesktopActivityOverlayPressableInteractionState } from '../DesktopActivityOverlayPressableInteractionState';
import type { DesktopActivityOverlayFocusTargetRef } from '../resolveDesktopActivityOverlayInitialFocusTarget';
import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from '../shared/desktopActivityOverlaySelectors';
import type { DesktopActivityOverlayActionOutcome } from '../shared/desktopActivityOverlayUiModel';
import { readDesktopActivityOverlayActionFailureReason } from '../shared/readDesktopActivityOverlayActionFailureReason';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { setDesktopActivityOverlayKeyboardWanted } from '../../runtime/desktopActivityOverlayBridge';
import { DesktopActivityOverlayChip } from '../DesktopActivityOverlayChip';

type StopPropagationEvent = Readonly<{
    stopPropagation?: () => void;
}>;

type WebStopPropagationProps = Readonly<{
    onClick: (event?: StopPropagationEvent) => void;
    onMouseDown: (event?: StopPropagationEvent) => void;
    onPointerDown: (event?: StopPropagationEvent) => void;
}>;

type ReplyFailure = Readonly<{ message: string; source: 'draft' | 'phrase'; localId: string; errorCode?: string }>;

export function DesktopActivityOverlayQuickReplyComposer(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    phrases: readonly string[];
    draft?: string;
    /** Names who the reply goes to ("Reply to Flake hunter…"); the generic "Message" otherwise. */
    placeholder?: string;
    inputRef?: DesktopActivityOverlayFocusTargetRef;
    onSend: (message: string, localId: string) => Promise<DesktopActivityOverlayActionOutcome>;
    onDraftChange?: (draft: string) => void;
    onDismissKey?: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { onDismissKey, onDraftChange, onSend } = props;
    const [localDraft, setLocalDraft] = React.useState('');
    const controlledDraft = props.draft;
    const draft = controlledDraft ?? localDraft;
    const [failure, setFailure] = React.useState<ReplyFailure | null>(null);
    // The latest text, read when a send settles: anything typed while it was in flight is kept.
    const draftRef = React.useRef(draft);
    draftRef.current = draft;
    // One send at a time; the ref decides at event time, the state renders the disabled control.
    const sendingRef = React.useRef(false);
    const [sending, setSending] = React.useState(false);
    const trimmedDraft = draft.trim();
    const canSendDraft = trimmedDraft.length > 0 && !sending;
    const stopEventPropagation = React.useCallback((event?: StopPropagationEvent) => {
        event?.stopPropagation?.();
    }, []);
    const webStopPropagationProps = React.useMemo<WebStopPropagationProps>(() => ({
        onClick: stopEventPropagation,
        // The island never takes the keyboard until the person goes to type: pressing the field asks for
        // it before the field takes focus, and native gives it back when the island closes.
        onMouseDown: (event) => {
            stopEventPropagation(event);
            fireAndForget(setDesktopActivityOverlayKeyboardWanted(true), { tag: 'DesktopActivityOverlayQuickReplyComposer.keyboard' });
        },
        onPointerDown: stopEventPropagation,
    }), [stopEventPropagation]);

    /**
     * Sends through the island's one send path (`session.message.send`). A phrase never touches the
     * draft; a sent draft clears only the text that went out, so words typed during the send stay.
     */
    const sendMessage = React.useCallback(async (message: string, source: 'draft' | 'phrase') => {
        const trimmedMessage = message.trim();
        if (!trimmedMessage || sendingRef.current) {
            return;
        }
        sendingRef.current = true;
        // The owner may have admitted a reply whose result was lost. Retry that same Session input.
        const localId = failure?.message === trimmedMessage && failure.source === source ? failure.localId : randomUUID();
        setSending(true);
        setFailure(null);
        let outcome: DesktopActivityOverlayActionOutcome;
        try {
            outcome = await onSend(trimmedMessage, localId);
        } catch {
            outcome = { ok: false };
        } finally {
            sendingRef.current = false;
            setSending(false);
        }
        if (!outcome.ok) {
            setFailure({ message: trimmedMessage, source, localId, errorCode: outcome.errorCode });
            return;
        }
        if (source === 'phrase') return;
        const current = draftRef.current;
        const remaining = current.trim() === trimmedMessage ? ''
            : current.trimStart().startsWith(trimmedMessage) ? current.trimStart().slice(trimmedMessage.length).trimStart()
                : current;
        if (remaining === current) return;
        draftRef.current = remaining;
        if (controlledDraft === undefined) {
            setLocalDraft(remaining);
        }
        onDraftChange?.(remaining);
    }, [controlledDraft, failure, onDraftChange, onSend]);

    const handleChangeText = React.useCallback((nextDraft: string) => {
        draftRef.current = nextDraft;
        if (controlledDraft === undefined) {
            setLocalDraft(nextDraft);
        }
        onDraftChange?.(nextDraft);
    }, [controlledDraft, onDraftChange]);

    // `react-native-web`'s `TextInput` stops key propagation, so the dismiss key cannot bubble to the
    // island shell from here. Forward it to the route, which owns the dirty-draft dismissal lock.
    const handleKeyPress = React.useCallback((event: DesktopActivityOverlayKeyEvent) => {
        if (!isDesktopActivityOverlayDismissKey(readDesktopActivityOverlayEventKey(event))) {
            return;
        }
        onDismissKey?.();
    }, [onDismissKey]);

    return (
        <View
            testID="desktop-activity-overlay-quick-reply"
            style={styles.container}
        >
            {/* The shell only stops event propagation around the input. A `Pressable` would make it
                a react-native-web focus stop with no action, so it stays a plain view. */}
            <View
                {...webStopPropagationProps}
                testID="desktop-activity-overlay-quick-reply-input-shell"
                onStartShouldSetResponder={() => true}
                style={styles.inputShell}
            >
                <TextInput
                    {...webStopPropagationProps}
                    ref={props.inputRef}
                    testID="desktop-activity-overlay-quick-reply-input"
                    accessibilityLabel={props.placeholder ?? t('common.message')}
                    placeholder={props.placeholder ?? t('common.message')}
                    placeholderTextColor={theme.colors.text.tertiary}
                    value={draft}
                    onChangeText={handleChangeText}
                    onPress={stopEventPropagation}
                    onPressIn={stopEventPropagation}
                    onKeyPress={handleKeyPress}
                    onSubmitEditing={(event) => {
                        stopEventPropagation(event);
                        void sendMessage(draftRef.current, 'draft');
                    }}
                    returnKeyType="send"
                    style={[
                        styles.input,
                        // In flight, the words that went out dim; anything typed meanwhile stays the draft.
                        sending ? styles.inputSending : null,
                        createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                            visualMode: props.visualMode,
                            kind: 'field',
                        }),
                        I18nManager.isRTL ? styles.inputRtl : null,
                    ]}
                />
                <Pressable
                    {...webStopPropagationProps}
                    testID="desktop-activity-overlay-quick-reply-send"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.send')}
                    accessibilityState={{ disabled: !canSendDraft, busy: sending }}
                    disabled={!canSendDraft}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        void sendMessage(draftRef.current, 'draft');
                    }}
                    style={(state) => [
                        createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                            visualMode: props.visualMode,
                            kind: 'badge',
                        }),
                        styles.sendButton,
                        I18nManager.isRTL ? styles.sendButtonRtl : null,
                        // The session composer's pending send (`PrimaryCircleIconButton` loading): the well
                        // stays lit and holds progress, so a send in flight never reads as an empty field.
                        !canSendDraft && !sending ? styles.disabledAction : null,
                        createDesktopActivityOverlayFocusRingStyle(theme, (state as DesktopActivityOverlayPressableInteractionState).focused),
                    ]}
                >
                    {sending ? (
                        <View testID="desktop-activity-overlay-quick-reply-sending">
                            <ActivitySpinner size={SEND_GLYPH_SIZE} color={theme.colors.text.primary} />
                        </View>
                    ) : (
                        <Icon name="arrow-up" size={SEND_GLYPH_SIZE} color={theme.colors.text.primary} />
                    )}
                </Pressable>
            </View>
            {props.phrases.length > 0 ? (
                <View style={styles.phraseRow}>
                    {props.phrases.map((phrase) => (
                        <DesktopActivityOverlayChip
                            key={phrase}
                            role="phrase"
                            label={phrase}
                            testID={`desktop-activity-overlay-quick-reply-phrase-${phrase}`}
                            disabled={sending}
                            onPress={() => {
                                void sendMessage(phrase, 'phrase');
                            }}
                        />
                    ))}
                </View>
            ) : null}
            {failure ? (
                <SurfaceFreshnessLine
                    testID="desktop-activity-overlay-quick-reply-error"
                    tone="warning"
                    reason={readDesktopActivityOverlayActionFailureReason(failure.errorCode, t('errors.failedToSendMessage'))}
                    action={{ label: t('common.retry'), testID: 'desktop-activity-overlay-quick-reply-retry',
                        onPress: () => void sendMessage(failure.message, failure.source) }}
                />
            ) : null}
        </View>
    );
}

/** The send glyph at the quiet inline-icon size; its well is the field's height less an inset. */
const SEND_GLYPH_SIZE = 14;

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: theme.space.s8,
    },
    phraseRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    inputShell: {
        position: 'relative',
    },
    input: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
        width: '100%',
        minWidth: 0,
        minHeight: theme.space.s32,
        paddingLeft: theme.space.s12,
        paddingRight: theme.space.s40,
        paddingVertical: theme.space.s6,
    },
    inputRtl: {
        paddingLeft: theme.space.s40,
        paddingRight: theme.space.s12,
    },
    sendButton: {
        position: 'absolute',
        right: theme.space.s4,
        top: theme.space.s4,
        width: theme.space.s24,
        height: theme.space.s24,
        borderRadius: theme.space.s12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonRtl: {
        right: undefined,
        left: theme.space.s4,
    },
    inputSending: {
        color: theme.colors.text.secondary,
    },
    disabledAction: {
        opacity: 0.45,
    },
}));
