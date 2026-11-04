import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import {
    AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE,
    AGENT_INPUT_ACTION_CHIP_STYLE,
    AGENT_INPUT_FIELD_PADDING_Y,
    resolveAgentInputActionChipTextStyle,
    resolveAgentInputPanelBackedEdgeStyle,
    resolveAgentInputPanelStyle,
} from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { MultiTextInput, type MultiTextInputHandle, type OnKeyPressCallback } from '@/components/ui/forms/MultiTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { KeyboardCommandHint, useKeyboardCommandHintLabel } from '@/components/ui/keyboard/KeyHint';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CaptureWindowNoteChips } from './CaptureWindowScreen';
import { resolveComposerSendShortcutAction } from '@/keyboard/composer';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import { t } from '@/text';

const noChooser = () => {};
const ACTION_HEIGHT = 32;
const NOTE_MAX_HEIGHT = 96;

export type CaptureWindowTarget = Readonly<{
    kind?: 'session' | 'newSession';
    title: string;
    /** The Agent's mark. */
    mark: React.ReactNode;
    machineName: string;
    disabledReason?: string;
    /** Why this Session leads when it was remembered rather than chosen; read quietly after the title. */
    cue?: string;
}>;
export type CaptureWindowUnreachable = Readonly<{ machineName: string; lastSeen: string | null }>;

/**
 * The note under the picture (lab `cw`, `st` OFF): the composer's own panel, chip and field anatomy, with
 * the target chip leading the rail and the delivery actions trailing it. The thin window loads no Sync,
 * so it draws those owners directly instead of mounting the session composer.
 */
export function CaptureWindowNote(props: Readonly<{
    note: string;
    onNoteChange: (note: string) => void;
    /** A video's time chips, drawn by the field's own inline references. */
    chips?: CaptureWindowNoteChips;
    target: CaptureWindowTarget | null;
    /** Supplied on show/target change, without a draft subscription in this window. */
    sendIncludesDraftText?: boolean;
    onChooseSession?: () => void;
    /** Unreachable Machine: Send stays in place, disabled, and Add to draft takes the lead (`st` OFF). */
    unreachable: CaptureWindowUnreachable | null;
    /** Drawn in the rail; the chooser's chip leads it and the actions trail it. */
    windowText: React.ReactNode;
    /** The chooser stands open from the chip. */
    choosing?: boolean;
    busy: boolean;
    onSend: () => void;
    onAddToDraft: () => void;
    chipRef?: React.Ref<View>;
    chipMarkRef?: React.Ref<View>;
    inputRef?: React.Ref<MultiTextInputHandle>;
    /** The same field, read back: the caret follows a chip that went in. */
    inputHandleRef?: React.RefObject<MultiTextInputHandle | null>;
    panelRef?: React.Ref<View>;
    onRailLayout?: (event: LayoutChangeEvent) => void;
}>) {
    const { theme } = useUnistyles();
    const caret = props.chips?.caret ?? null;
    const inputHandle = props.inputHandleRef;
    React.useEffect(() => {
        if (caret !== null) inputHandle?.current?.setSelection({ start: caret.at, end: caret.at });
    }, [caret, inputHandle]);

    const offline = props.unreachable !== null;
    const draftPrimary = offline || props.target?.kind === 'newSession';
    const noTarget = props.target === null;
    const targetDisabled = noTarget || Boolean(props.target?.disabledReason);
    const chipText = resolveAgentInputActionChipTextStyle(theme);
    const panel = React.useMemo(() => [
        resolveAgentInputPanelStyle(theme),
        resolveAgentInputPanelBackedEdgeStyle(theme),
    ], [theme]);
    const shortcuts = useSettingsValues([
        'keyboardShortcutsV2Enabled', 'keyboardSingleKeyShortcutsEnabled',
        'keyboardShortcutOverridesV1', 'keyboardShortcutDisabledCommandIdsV1',
    ]);
    // The field keeps its keys, so the send bindings are resolved the way the composer resolves them.
    const onKeyPress: OnKeyPressCallback = (event) => {
        const action = resolveComposerSendShortcutAction(event, {
            keyboardShortcutsV2Enabled: shortcuts.keyboardShortcutsV2Enabled === true,
            keyboardSingleKeyShortcutsEnabled: shortcuts.keyboardSingleKeyShortcutsEnabled === true,
            keyboardShortcutOverridesV1: shortcuts.keyboardShortcutOverridesV1 ?? {},
            keyboardShortcutDisabledCommandIdsV1: shortcuts.keyboardShortcutDisabledCommandIdsV1 ?? [],
            hasSendableInput: true,
            sendActionDisabled: props.busy || targetDisabled,
            platformOS: Platform.OS,
        });
        if (action === 'sendAlternate' && !draftPrimary) props.onSend();
        else if (action === 'sendInterrupt') props.onAddToDraft();
        return action !== null;
    };
    // The keys draw through the keycap owner, one cap per key (⌘ ↵ on a Mac), like every other hint.
    const sendKey = useKeyboardCommandHintLabel('composer.sendImmediate');
    const addKey = useKeyboardCommandHintLabel('composer.sendInterrupt');
    const disabledReason = noTarget ? t('screenCapture.window.chooseSession') : props.target?.disabledReason;
    return (
        <View ref={props.panelRef} collapsable={false} style={panel} testID="capture-window-note">
            <MultiTextInput
                ref={props.inputRef}
                onKeyPress={onKeyPress}
                value={props.note}
                onChangeText={props.onNoteChange}
                {...(props.chips ? {
                    references: props.chips.references,
                    onReferencesChange: props.chips.onReferencesChange,
                    onReferencePress: props.chips.onReferencePress,
                } : {})}
                placeholder={t('screenCapture.window.notePlaceholder')}
                placeholderTextColor={theme.colors.text.secondary}
                textStyle={styles.input as never}
                maxHeight={NOTE_MAX_HEIGHT}
                // The composer's own field step, so the note sits above the session row as a message sits above its chips.
                paddingTop={AGENT_INPUT_FIELD_PADDING_Y}
                paddingBottom={AGENT_INPUT_FIELD_PADDING_Y}
                paddingLeft={theme.space.s6}
                paddingRight={theme.space.s6}
                accessibilityLabel={t('screenCapture.window.notePlaceholder')}
                testID="capture-window-note-input"
            />
            <View style={styles.rail} onLayout={props.onRailLayout}>
                <View ref={props.chipRef} collapsable={false} style={[styles.sessionChipFrame, props.choosing ? styles.chipOpen : null]}>
                    <HappierPressable
                        accessibilityRole="button"
                        accessibilityLabel={props.target
                            ? t('screenCapture.window.sendTo', { session: props.target.title, machine: props.target.machineName })
                            : t('screenCapture.window.chooseSession')}
                        disabled={!props.onChooseSession}
                        hasPopup="dialog"
                        expanded={props.choosing === true}
                        {...(props.target?.cue ? { accessibilityHint: props.target.cue } : {})}
                        onPress={props.onChooseSession ?? noChooser}
                        style={({ pressed }) => [styles.chip, styles.sessionChip, pressed ? AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE : null]}
                        testID="capture-window-session-chip"
                    >
                        <View ref={props.chipMarkRef} collapsable={false}>
                            {props.target?.mark ?? <Icon name="chat-circle" size={14} color={theme.colors.composer.chipTint} />}
                        </View>
                        <WordCrossFade wordKey={props.target?.title ?? ''} style={styles.chipTitle}>
                            <Text numberOfLines={1} style={chipText}>
                                {props.target?.title ?? t('screenCapture.window.chooseSession')}
                            </Text>
                        </WordCrossFade>
                        {props.target?.cue ? (
                            <Text variant="meta" numberOfLines={1} style={styles.chipCue} testID="capture-window-session-cue">
                                {props.target.cue}
                            </Text>
                        ) : null}
                        {props.onChooseSession ? <Icon name="caret-down" size={12} color={theme.colors.composer.chipTint} /> : null}
                    </HappierPressable>
                </View>
                {props.windowText}
                <View style={styles.grow} />
                <RoundButton
                    size="small"
                    capsuleHeight={ACTION_HEIGHT}
                    display={draftPrimary ? 'default' : 'secondary'}
                    title={t('screenCapture.window.addToDraft')}
                    trailing={draftPrimary && addKey ? <KeyboardCommandHint commandId="composer.sendInterrupt" tone="onFill" /> : undefined}
                    disabled={props.busy || targetDisabled}
                    accessibilityHint={disabledReason}
                    onPress={props.onAddToDraft}
                    testID="capture-window-add"
                />
                <RoundButton
                    size="small"
                    capsuleHeight={ACTION_HEIGHT}
                    display={draftPrimary ? 'secondary' : 'default'}
                    title={t('screenCapture.window.send')}
                    trailing={!draftPrimary && sendKey ? <KeyboardCommandHint commandId="composer.sendImmediate" tone="onFill" /> : undefined}
                    disabled={props.busy || targetDisabled || draftPrimary}
                    accessibilityHint={disabledReason ?? (offline ? t('screenCapture.window.unreachable', { machine: props.unreachable!.machineName })
                        : props.target?.kind === 'newSession' ? t('transcript.selection.sendTo.newSessionSubtitle') : undefined)}
                    onPress={props.onSend}
                    testID="capture-window-send"
                />
            </View>
        </View>
    );
}

/** Why the chosen Session can't take this capture: its machine is away, or it can't take a picture at all. */
export type CaptureWindowTargetCause =
    | Readonly<{ kind: 'unreachable'; unreachable: CaptureWindowUnreachable }>
    | Readonly<{ kind: 'refused'; reason: string }>;

/** One cause, one line, the next action inside it (lab `st` OFF). */
export function CaptureWindowTargetLine(props: Readonly<{
    cause: CaptureWindowTargetCause;
    onChooseSession?: () => void;
}>) {
    const { theme } = useUnistyles();
    const { cause } = props;
    const unreachable = cause.kind === 'unreachable' ? cause.unreachable : null;
    return (
        <View style={styles.unreachable} testID={unreachable ? 'capture-window-unreachable' : 'capture-window-refused'}>
            <Icon name="warning" size={14} color={theme.colors.state.attention.foreground} />
            <Text variant="meta" numberOfLines={1} style={styles.unreachableText}>
                {unreachable ? (
                    <>
                        <Text variant="meta" emphasis="semiBold">{t('screenCapture.window.unreachable', { machine: unreachable.machineName })}</Text>
                        {unreachable.lastSeen ? ` · ${t('screenCapture.window.lastSeen', { time: unreachable.lastSeen })}` : ''}
                        {`. ${t('screenCapture.window.addOrPick')} `}
                    </>
                ) : (
                    // Add to draft can't help either: the Session can't read a picture at all.
                    <Text variant="meta" emphasis="semiBold">{`${cause.kind === 'refused' ? cause.reason : ''}. `}</Text>
                )}
                {props.onChooseSession ? (
                    <Text variant="meta" emphasis="medium" style={styles.unreachableLink} onPress={props.onChooseSession} accessibilityRole="link">
                        {unreachable ? t('screenCapture.window.pickAnother') : t('screenCapture.window.pickAnotherSession')}
                    </Text>
                ) : null}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    input: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
    },
    rail: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    chip: AGENT_INPUT_ACTION_CHIP_STYLE,
    sessionChipFrame: {
        flexShrink: 1,
        minWidth: 0,
        borderRadius: 16,
    },
    chipOpen: {
        boxShadow: `0 0 0 2px ${theme.colors.border.focus}`,
    } as never,
    sessionChip: {
        backgroundColor: theme.colors.surface.selected,
    },
    chipTitle: {
        flexShrink: 1,
        minWidth: 0,
    },
    // The window's metadata voice (its caption facts); the title names the target, so the cue gives way first.
    chipCue: {
        flexShrink: 1000,
        minWidth: 0,
        color: theme.colors.text.tertiary,
    },
    grow: {
        flexGrow: 1,
        minWidth: theme.space.s8,
    },
    unreachable: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s4,
        paddingBottom: theme.space.s8,
    },
    unreachableText: {
        flexShrink: 1,
        color: theme.colors.text.secondary,
        ...(Platform.OS === 'web' ? { whiteSpace: 'nowrap' } : {}),
    } as never,
    unreachableLink: {
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
}));
