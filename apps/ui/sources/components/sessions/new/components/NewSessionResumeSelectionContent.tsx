import * as React from 'react';
import { InteractionManager, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { InputBrowseButton } from '@/components/ui/buttons/InputBrowseButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        // Match the path popover header padding more closely.
        paddingVertical: 12,
    },
    inputSection: {
        width: '100%',
    },
    inputRow: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    inputContainer: {
        flex: 1,
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        minHeight: 40,
        justifyContent: 'center',
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    textInput: {
        flex: 1,
        color: theme.colors.input.text,
        paddingVertical: 0,
        minHeight: 24,
        textAlignVertical: 'center',
        ...Typography.default(),
        ...(Platform.OS === 'web'
            ? ({
                outlineStyle: 'none',
                outlineWidth: 0,
                boxShadow: 'none',
            } as any)
            : undefined),
    },
    buttonRow: {
        flexDirection: 'row',
        marginTop: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    buttonRowLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flexShrink: 1,
    },
    button: {
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: theme.colors.surface,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    buttonText: {
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    buttonTextPrimary: {
        color: theme.colors.button.primary.tint,
    },
    buttonTextSecondary: {
        color: theme.colors.text,
    },
    buttonTextDestructive: {
        color: theme.colors.textDestructive,
    },
    clearButton: {
        paddingVertical: 7,
        paddingHorizontal: 6,
    },
    helpText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 12,
        lineHeight: 20,
        ...Typography.default(),
    },
}));

type FocusMode = 'mount' | 'routeFocus';

export type NewSessionResumeSelectionContentProps = Readonly<{
    value: string;
    onChangeValue: (next: string) => void;
    onSave: (nextValue: string) => void;
    onClear: () => void;
    onClose: () => void;
    agentType?: AgentId | string | null;
    resumeBrowse?: Readonly<{
        enabled: boolean;
        onBrowse: () => Promise<string | null> | string | null;
    }> | null;
    maxHeight?: number;
    showInlineHeader?: boolean;
    focusMode?: FocusMode;
}>;

export function NewSessionResumeSelectionContent(props: NewSessionResumeSelectionContentProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const inputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
    const agentType = isAgentId(props.agentType) ? props.agentType : DEFAULT_AGENT_ID;
    const agentLabel = t(getAgentCore(agentType).displayNameKey);
    const shouldAutoFocus = Platform.OS === 'web';

    const focusInputWithRetries = React.useCallback(() => {
        if (!shouldAutoFocus) {
            return () => undefined;
        }

        let cancelled = false;
        const focus = () => {
            if (cancelled) return;
            inputRef.current?.focus?.();
        };

        focus();

        let rafAttempts = 0;
        const raf =
            typeof (globalThis as any).requestAnimationFrame === 'function'
                ? ((globalThis as any).requestAnimationFrame as (cb: (ts: number) => void) => unknown).bind(globalThis)
                : (cb: (ts: number) => void) => setTimeout(() => cb(Date.now()), 16);
        const caf =
            typeof (globalThis as any).cancelAnimationFrame === 'function'
                ? ((globalThis as any).cancelAnimationFrame as (id: unknown) => void).bind(globalThis)
                : (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>);
        let rafId: unknown = null;
        const rafLoop = () => {
            rafAttempts += 1;
            focus();
            if (rafAttempts < 8) {
                rafId = raf(rafLoop);
            }
        };
        rafId = raf(rafLoop);

        const timer = setTimeout(focus, 300);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            if (rafId !== null) {
                caf(rafId);
            }
        };
    }, [shouldAutoFocus]);

    React.useEffect(() => {
        if (!shouldAutoFocus) {
            return undefined;
        }
        return focusInputWithRetries();
    }, [focusInputWithRetries]);

    useFocusEffect(React.useCallback(() => {
        if (!shouldAutoFocus) {
            return undefined;
        }
        if (props.focusMode !== 'routeFocus') {
            return undefined;
        }

        const cleanup = focusInputWithRetries();
        let interactionCleanup: (() => void) | undefined;
        const task = InteractionManager.runAfterInteractions(() => {
            interactionCleanup = focusInputWithRetries();
        });

        return () => {
            task.cancel?.();
            interactionCleanup?.();
            cleanup();
        };
    }, [focusInputWithRetries, props.focusMode, shouldAutoFocus]));

    const handlePaste = React.useCallback(async () => {
        const text = await getClipboardStringTrimmedSafe();
        if (text) {
            props.onChangeValue(text);
        }
    }, [props]);

    const handleSave = React.useCallback(() => {
        props.onSave(props.value.trim());
    }, [props]);

    const handleClear = React.useCallback(() => {
        props.onClear();
    }, [props]);

    const handleBrowse = React.useCallback(async () => {
        if (!props.resumeBrowse?.enabled) return;
        const selected = await props.resumeBrowse.onBrowse();
        const trimmed = typeof selected === 'string' ? selected.trim() : '';
        if (!trimmed) return;
        props.onSave(trimmed);
    }, [props]);

    return (
        <View style={[styles.container, props.maxHeight ? { maxHeight: props.maxHeight } : null]}>
            <View style={styles.inputSection}>
                <View style={styles.inputRow}>
                    <View style={styles.inputContainer}>
                        <TextInput
                            testID="resume-id-input"
                            ref={inputRef}
                            value={props.value}
                            onChangeText={props.onChangeValue}
                            placeholder={t('newSession.resume.placeholder', { agent: agentLabel })}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoFocus={shouldAutoFocus}
                            style={styles.textInput}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="off"
                            textContentType="none"
                            importantForAutofill="no"
                            returnKeyType="done"
                            blurOnSubmit={true}
                            multiline={false}
                        />
                    </View>
                    {props.resumeBrowse?.enabled ? (
                        <InputBrowseButton
                            testID="resume-id-browse-trigger"
                            accessibilityLabel={t('newSession.resume.browse')}
                            onPress={handleBrowse}
                        />
                    ) : null}
                </View>

                <View style={styles.buttonRow}>
                    <View style={styles.buttonRowLeft}>
                        <Pressable
                            onPress={() => {
                                void handlePaste();
                            }}
                            style={({ pressed }) => [
                                styles.button,
                                styles.buttonSecondary,
                                { opacity: pressed ? 0.7 : 1 },
                            ]}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Ionicons name="clipboard-outline" size={16} color={theme.colors.text} />
                                <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                                    {t('newSession.resume.paste')}
                                </Text>
                            </View>
                        </Pressable>
                        <Pressable
                            onPress={handleSave}
                            style={({ pressed }) => [
                                styles.button,
                                styles.buttonPrimary,
                                { opacity: pressed ? 0.7 : 1 },
                            ]}
                        >
                            <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
                                {t('newSession.resume.save')}
                            </Text>
                        </Pressable>
                    </View>

                    {props.value.trim() ? (
                        <Pressable
                            onPress={handleClear}
                            style={({ pressed }) => [
                                styles.clearButton,
                                { opacity: pressed ? 0.7 : 1 },
                            ]}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Ionicons name="close-circle-outline" size={16} color={theme.colors.textDestructive} />
                                <Text style={[styles.buttonText, styles.buttonTextDestructive]}>
                                    {t('newSession.resume.clearAndRemove')}
                                </Text>
                            </View>
                        </Pressable>
                    ) : null}
                </View>

                <Text style={styles.helpText}>
                    {t('newSession.resume.helpText')}
                </Text>
            </View>
        </View>
    );
}
