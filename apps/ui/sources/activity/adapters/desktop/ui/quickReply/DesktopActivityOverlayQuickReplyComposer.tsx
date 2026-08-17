import * as React from 'react';
import { I18nManager, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
    createDesktopActivityOverlayInteriorSurfaceStyle,
} from '../DesktopActivityOverlayChrome';
import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';
import { Icon } from '@/components/ui/icons/Icon';

type StopPropagationEvent = Readonly<{
    stopPropagation?: () => void;
}>;

type WebStopPropagationProps = Readonly<{
    onClick: (event?: StopPropagationEvent) => void;
    onMouseDown: (event?: StopPropagationEvent) => void;
    onPointerDown: (event?: StopPropagationEvent) => void;
}>;

export function DesktopActivityOverlayQuickReplyComposer(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    phrases: readonly string[];
    draft?: string;
    targetAvailable?: boolean;
    onSend: (message: string) => boolean | Promise<boolean>;
    onDraftChange?: (draft: string) => void;
    onInputLockChange?: (locked: boolean) => void;
    onCleanEscape?: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { onCleanEscape, onDraftChange, onInputLockChange, onSend } = props;
    const [localDraft, setLocalDraft] = React.useState('');
    const controlledDraft = props.draft;
    const draft = controlledDraft ?? localDraft;
    const draftRef = React.useRef(draft);
    const [focused, setFocused] = React.useState(false);
    const [sendFailed, setSendFailed] = React.useState(false);
    const trimmedDraft = draft.trim();
    const targetUnavailable = props.targetAvailable === false;
    const canSendDraft = trimmedDraft.length > 0 && !targetUnavailable;
    const stopEventPropagation = React.useCallback((event?: StopPropagationEvent) => {
        event?.stopPropagation?.();
    }, []);
    const webStopPropagationProps = React.useMemo<WebStopPropagationProps>(() => ({
        onClick: stopEventPropagation,
        onMouseDown: stopEventPropagation,
        onPointerDown: stopEventPropagation,
    }), [stopEventPropagation]);

    const setInputLocked = React.useCallback((locked: boolean) => {
        onInputLockChange?.(locked);
    }, [onInputLockChange]);

    const sendMessage = React.useCallback(async (message: string) => {
        const trimmedMessage = message.trim();
        if (!trimmedMessage) {
            return;
        }
        if (targetUnavailable) {
            return;
        }
        if (sendFailed) {
            setSendFailed(false);
        }
        const sent = await onSend(trimmedMessage);
        if (!sent) {
            setSendFailed(true);
            return;
        }
        draftRef.current = '';
        if (controlledDraft === undefined) {
            setLocalDraft('');
        }
        onDraftChange?.('');
        setInputLocked(focused);
    }, [controlledDraft, focused, onDraftChange, onSend, sendFailed, setInputLocked, targetUnavailable]);

    const handleChangeText = React.useCallback((nextDraft: string) => {
        draftRef.current = nextDraft;
        if (controlledDraft === undefined) {
            setLocalDraft(nextDraft);
        }
        onDraftChange?.(nextDraft);
        setInputLocked(focused || nextDraft.length > 0);
    }, [controlledDraft, focused, onDraftChange, setInputLocked]);

    const handleFocus = React.useCallback(() => {
        setFocused(true);
        setInputLocked(true);
    }, [setInputLocked]);

    const handleBlur = React.useCallback(() => {
        setFocused(false);
        setInputLocked(draft.length > 0);
    }, [draft.length, setInputLocked]);

    const handleKeyPress = React.useCallback((key: string | undefined) => {
        if ((key === 'Escape' || key === 'Esc') && draftRef.current.length === 0) {
            onCleanEscape?.();
        }
    }, [onCleanEscape]);

    React.useEffect(() => {
        draftRef.current = draft;
    }, [draft]);

    React.useEffect(() => () => {
        setInputLocked(false);
    }, [setInputLocked]);

    return (
        <View
            testID="desktop-activity-overlay-quick-reply"
            style={[
                styles.container,
                createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                    visualMode: props.visualMode,
                    kind: 'card',
                }),
            ]}
        >
            {props.phrases.length > 0 ? (
                <View style={styles.phraseRow}>
                    {props.phrases.map((phrase) => (
                        <Pressable
                            key={phrase}
                            testID={`desktop-activity-overlay-quick-reply-phrase-${phrase}`}
                            accessibilityRole="button"
                            accessibilityLabel={phrase}
                            disabled={targetUnavailable}
                            onPress={() => {
                                void sendMessage(phrase);
                            }}
                            style={[
                                styles.phraseChip,
                                createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                    visualMode: props.visualMode,
                                    kind: 'action',
                                }),
                                targetUnavailable ? styles.disabledAction : null,
                            ]}
                        >
                            <Text
                                numberOfLines={1}
                                style={[styles.phraseText, { color: theme.colors.overlay.foreground }]}
                            >
                                {phrase}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}
            <Pressable
                {...webStopPropagationProps}
                testID="desktop-activity-overlay-quick-reply-input-shell"
                onPress={stopEventPropagation}
                onPressIn={stopEventPropagation}
                onStartShouldSetResponder={() => true}
                style={styles.inputShell}
            >
                <TextInput
                    {...webStopPropagationProps}
                    testID="desktop-activity-overlay-quick-reply-input"
                    accessibilityLabel={t('common.message')}
                    placeholder={t('common.message')}
                    placeholderTextColor={theme.colors.overlay.secondaryForeground}
                    value={draft}
                    onChangeText={handleChangeText}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                    onPress={stopEventPropagation}
                    onPressIn={stopEventPropagation}
                    onKeyPress={(event) => handleKeyPress(event.nativeEvent.key)}
                    onSubmitEditing={(event) => {
                        stopEventPropagation(event);
                        void sendMessage(trimmedDraft);
                    }}
                    returnKeyType="send"
                    style={[
                        styles.input,
                        I18nManager.isRTL ? styles.inputRtl : null,
                        {
                            color: theme.colors.overlay.foreground,
                            borderColor: theme.colors.overlay.secondaryForeground,
                        },
                    ]}
                />
                <Pressable
                    {...webStopPropagationProps}
                    testID="desktop-activity-overlay-quick-reply-send"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.send')}
                    disabled={!canSendDraft}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        void sendMessage(trimmedDraft);
                    }}
                    style={[
                        createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                            visualMode: props.visualMode,
                            kind: 'action',
                        }),
                        styles.sendButton,
                        I18nManager.isRTL ? styles.sendButtonRtl : null,
                        !canSendDraft ? styles.disabledAction : null,
                    ]}
                >
                    <Icon name="arrow-up" size={14} color={theme.colors.overlay.foreground} />
                </Pressable>
            </Pressable>
            {targetUnavailable ? (
                <Text
                    testID="desktop-activity-overlay-quick-reply-no-target"
                    style={[styles.errorText, { color: theme.colors.overlay.secondaryForeground }]}
                >
                    {t('errors.sessionNotFound')}
                </Text>
            ) : null}
            {sendFailed && !targetUnavailable ? (
                <Text
                    testID="desktop-activity-overlay-quick-reply-error"
                    style={[styles.errorText, { color: theme.colors.overlay.secondaryForeground }]}
                >
                    {t('errors.failedToSendMessage')}
                </Text>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    phraseRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    phraseChip: {
        minHeight: 28,
        maxWidth: 128,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 10,
        paddingVertical: 5,
    },
    phraseText: {
        fontSize: 11,
        fontWeight: '700',
    },
    inputShell: {
        minHeight: 34,
        position: 'relative',
    },
    input: {
        width: '100%',
        minWidth: 0,
        borderWidth: 0.5,
        borderRadius: 17,
        paddingLeft: 12,
        paddingRight: 40,
        paddingVertical: 7,
        fontSize: 12,
    },
    inputRtl: {
        paddingLeft: 40,
        paddingRight: 12,
    },
    sendButton: {
        position: 'absolute',
        right: 3,
        top: 2,
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 0,
    },
    sendButtonRtl: {
        right: undefined,
        left: 2,
    },
    disabledAction: {
        opacity: 0.45,
    },
    errorText: {
        fontSize: 11,
        fontWeight: '600',
    },
});
