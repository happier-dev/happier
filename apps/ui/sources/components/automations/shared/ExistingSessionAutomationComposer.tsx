import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import type { ExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/sessionAuthoringContext';
import { updateSessionAuthoringDraftPrompt } from '@/components/sessions/authoring/draft/updateSessionAuthoringDraftFields';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    contentContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    label: {
        fontSize: 12,
        fontWeight: '700',
        color: theme.colors.textSecondary,
        letterSpacing: 0.6,
        marginBottom: 6,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
        color: theme.colors.text,
    },
    helpText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 6,
    },
}));

export function ExistingSessionAutomationComposer(props: Readonly<{
    context: ExistingSessionAutomationAuthoringContext;
    onChangeDraft: React.Dispatch<React.SetStateAction<import('@/components/sessions/authoring/draft/sessionAuthoringDraft').SessionAuthoringDraft | null>>;
    onSubmit: () => void;
    submitAccessibilityLabel: string;
    isSubmitDisabled: boolean;
    editable?: boolean;
}>): React.JSX.Element {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <>
            <ItemGroup title={t('common.message')}>
                <View style={styles.contentContainer}>
                    <Text style={styles.label}>{t('automations.edit.messageLabel')}</Text>
                    <TextInput
                        style={styles.textInput}
                        value={props.context.draft.prompt}
                        onChangeText={(value) => {
                            props.onChangeDraft((current) => current ? updateSessionAuthoringDraftPrompt(current, value) : current);
                        }}
                        placeholder={t('automations.edit.messagePlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="sentences"
                        autoCorrect={true}
                        multiline={true}
                        editable={props.editable !== false}
                    />
                    <Text style={styles.helpText}>{t('automations.edit.messageHelpText')}</Text>
                </View>
            </ItemGroup>

            <ItemGroup title={t('common.actions')}>
                <Item
                    title={props.submitAccessibilityLabel}
                    icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.success} />}
                    onPress={props.onSubmit}
                    disabled={props.isSubmitDisabled || props.editable === false}
                    showChevron={false}
                />
            </ItemGroup>
        </>
    );
}
