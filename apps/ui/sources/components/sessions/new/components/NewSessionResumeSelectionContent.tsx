import * as React from 'react';
import { InteractionManager, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { MultiTextInput, type MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    inputSection: {
        width: '100%',
    },
    inputContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
    },
    button: {
        minWidth: 60,
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
    clearButton: {
        marginTop: 12,
        alignSelf: 'flex-start',
        paddingVertical: 8,
        alignItems: 'center',
    },
    clearButtonText: {
        fontSize: 14,
        color: theme.colors.textDestructive,
        ...Typography.default('semiBold'),
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
    maxHeight?: number;
    showInlineHeader?: boolean;
    focusMode?: FocusMode;
}>;

export function NewSessionResumeSelectionContent(props: NewSessionResumeSelectionContentProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const agentType = isAgentId(props.agentType) ? props.agentType : DEFAULT_AGENT_ID;
    const agentLabel = t(getAgentCore(agentType).displayNameKey);

    const focusInputWithRetries = React.useCallback(() => {
        let cancelled = false;
        const focus = () => {
            if (cancelled) return;
            inputRef.current?.focus();
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
    }, []);

    React.useEffect(() => {
        return focusInputWithRetries();
    }, [focusInputWithRetries]);

    useFocusEffect(React.useCallback(() => {
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
    }, [focusInputWithRetries, props.focusMode]));

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

    return (
        <View style={[styles.container, props.maxHeight ? { maxHeight: props.maxHeight } : null]}>
            <View style={styles.inputSection}>
                <View style={styles.inputContainer}>
                    <MultiTextInput
                        ref={inputRef}
                        value={props.value}
                        onChangeText={props.onChangeValue}
                        placeholder={t('newSession.resume.placeholder', { agent: agentLabel })}
                        autoFocus={true}
                        maxHeight={80}
                        paddingTop={0}
                        paddingBottom={0}
                    />
                </View>

                <View style={styles.buttonRow}>
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
                        <Text style={styles.clearButtonText}>
                            {t('newSession.resume.clearAndRemove')}
                        </Text>
                    </Pressable>
                ) : null}

                <Text style={styles.helpText}>
                    {t('newSession.resume.helpText')}
                </Text>
            </View>
        </View>
    );
}
