import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { InputBrowseButton } from '@/components/ui/buttons/InputBrowseButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, tLoose } from '@/text';
import { getClipboardStringSafe } from '@/utils/ui/clipboard';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.surface.base,
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
        borderColor: theme.colors.border.default,
    },
    textInput: {
        flex: 1,
        color: theme.colors.input.text,
        paddingVertical: 0,
        minHeight: 24,
        textAlignVertical: 'center',
        ...Typography.default(),
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
        backgroundColor: theme.colors.surface.base,
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
    },
    buttonText: {
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    buttonTextPrimary: {
        color: theme.colors.button.primary.tint,
    },
    buttonTextSecondary: {
        color: theme.colors.text.primary,
    },
    buttonTextDestructive: {
        color: theme.colors.state.danger.foreground,
    },
    clearButton: {
        paddingVertical: 7,
        paddingHorizontal: 6,
    },
    helpText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginTop: 12,
        lineHeight: 20,
        ...Typography.default(),
    },
}));

export type NewSessionResumeSelectionContentProps = Readonly<{
    value: string;
    onChangeValue: (next: string) => void;
    onSave: (nextValue: string) => void;
    onClear: () => void;
    onClose: () => void;
    agentType?: AgentId | string | null;
    agentLabel?: string | null;
    resumeBrowse?: Readonly<{
        enabled: boolean;
        onBrowse: () => Promise<string | null> | string | null;
    }> | null;
    maxHeight?: number;
    showInlineHeader?: boolean;
}>;

export function NewSessionResumeSelectionContent(props: NewSessionResumeSelectionContentProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const agentType = isBundledAgentId(props.agentType) ? props.agentType : null;
    const agentLabel = props.agentLabel?.trim()
        || (agentType ? t(getAgentCore(agentType).displayNameKey) : tLoose('common.unknown'));

    // A pasted or typed resume id is the Agent's own opaque session identity.
    // Whitespace, newlines and base64 punctuation are part of those bytes, so
    // this surface only decides present-vs-absent through Protocol's one
    // opaque-identifier rule owner and never re-canonicalizes the value.
    const handlePaste = React.useCallback(async () => {
        const text = readNonBlankOpaqueIdentifier(await getClipboardStringSafe());
        if (text !== null) {
            props.onChangeValue(text);
        }
    }, [props]);

    const handleSave = React.useCallback(() => {
        props.onSave(readNonBlankOpaqueIdentifier(props.value) ?? '');
    }, [props]);

    const handleClear = React.useCallback(() => {
        props.onClear();
    }, [props]);

    const handleBrowse = React.useCallback(async () => {
        if (!props.resumeBrowse?.enabled) return;
        const selected = await props.resumeBrowse.onBrowse();
        // A browsed id is the Agent's own opaque session identity, so it is
        // saved byte-for-byte. Only present-vs-absent is decided here; the
        // canonical authoring-draft owner owns normalization.
        if (typeof selected !== 'string' || selected.trim().length === 0) return;
        props.onSave(selected);
    }, [props]);

    return (
        <View style={[styles.container, props.maxHeight ? { maxHeight: props.maxHeight } : null]}>
            <View style={styles.inputSection}>
                <View style={styles.inputRow}>
                    <View style={styles.inputContainer}>
                        <TextInput
                            testID="resume-id-input"
                            value={props.value}
                            onChangeText={props.onChangeValue}
                            placeholder={t('newSession.resume.placeholder', { agent: agentLabel })}
                            placeholderTextColor={theme.colors.input.placeholder}
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
                            testID="resume-id-paste-trigger"
                            onPress={() => {
                                void handlePaste();
                            }}
                            style={({ pressed }) => [
                                styles.button,
                                styles.buttonSecondary,
                                { opacity: pressed ? motionTokens.press.opacity : 1 },
                            ]}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Icon name="clipboard" size={16} color={theme.colors.text.primary} />
                                <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                                    {t('newSession.resume.paste')}
                                </Text>
                            </View>
                        </Pressable>
                        <Pressable
                            testID="resume-id-save-trigger"
                            onPress={handleSave}
                            style={({ pressed }) => [
                                styles.button,
                                styles.buttonPrimary,
                                { opacity: pressed ? motionTokens.press.opacity : 1 },
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
                                { opacity: pressed ? motionTokens.press.opacity : 1 },
                            ]}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Icon name="x-circle" size={16} color={theme.colors.state.danger.foreground} />
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
