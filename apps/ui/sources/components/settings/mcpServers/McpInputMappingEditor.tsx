import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { ImportedMcpInputDefinitionV1 } from '@/sync/domains/settings/mcpServers/parseImportedMcpServerJson';
import type { ImportedMcpInputResolutionV1 } from '@/sync/domains/settings/mcpServers/materializeImportedMcpServerDrafts';

export const McpInputMappingEditor = React.memo(function McpInputMappingEditor(props: Readonly<{
    inputs: readonly ImportedMcpInputDefinitionV1[];
    mappings: Record<string, ImportedMcpInputResolutionV1>;
    onChangeMapping: (inputId: string, next: ImportedMcpInputResolutionV1) => void;
}>) {
    const { theme } = useUnistyles();

    if (props.inputs.length === 0) return null;

    return (
        <>
            {props.inputs.map((input) => {
                const mapping = props.mappings[input.inputId];
                const mode = mapping?.mode ?? (input.secret ? 'savedSecret' : 'machineEnv');
                return (
                    <ItemGroup key={input.inputId} title={input.title} footer={input.description || undefined}>
                        {(['savedSecret', 'machineEnv'] as const).map((candidateMode) => {
                            const selected = mode === candidateMode;
                            return (
                                <Item
                                    key={candidateMode}
                                    title={candidateMode === 'savedSecret'
                                        ? t('settings.mcpServersImportMappingSavedSecret')
                                        : t('settings.mcpServersImportMappingMachineEnv')}
                                    subtitle={candidateMode === 'savedSecret'
                                        ? t('settings.mcpServersValueSourceSavedSecretSubtitle')
                                        : t('settings.mcpServersImportMachineEnvPlaceholder')}
                                    icon={<Ionicons name={candidateMode === 'savedSecret' ? 'key-outline' : 'terminal-outline'} size={29} color={theme.colors.accent.indigo} />}
                                    onPress={() => {
                                        props.onChangeMapping(
                                            input.inputId,
                                            candidateMode === 'savedSecret'
                                                ? {
                                                    mode: 'savedSecret',
                                                    secretName: input.title,
                                                    secretValue: '',
                                                    secretKind: input.secret ? 'token' : 'other',
                                                }
                                                : {
                                                    mode: 'machineEnv',
                                                    envVarName: input.suggestedEnvVarName,
                                                },
                                        );
                                    }}
                                    selected={selected}
                                    showChevron={false}
                                    rightElement={(
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={22}
                                            color={theme.colors.text.primary}
                                            style={{ opacity: selected ? 1 : 0 }}
                                        />
                                    )}
                                />
                            );
                        })}

                        <View style={styles.formContent}>
                            {mode === 'savedSecret' ? (
                                <>
                                    <Text style={styles.fieldLabel}>{t('settings.mcpServersImportSecretNamePlaceholder')}</Text>
                                    <TextInput
                                        value={mapping?.mode === 'savedSecret' ? mapping.secretName : input.title}
                                        onChangeText={(value) =>
                                            props.onChangeMapping(input.inputId, {
                                                mode: 'savedSecret',
                                                secretName: value,
                                                secretValue: mapping?.mode === 'savedSecret' ? mapping.secretValue : '',
                                                secretKind: mapping?.mode === 'savedSecret' ? mapping.secretKind : (input.secret ? 'token' : 'other'),
                                            })}
                                        placeholder={t('settings.mcpServersImportSecretNamePlaceholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        style={styles.textInput}
                                    />
                                    <Text style={styles.fieldLabel}>{t('settings.mcpServersImportSecretValuePlaceholder')}</Text>
                                    <TextInput
                                        value={mapping?.mode === 'savedSecret' ? mapping.secretValue : ''}
                                        onChangeText={(value) =>
                                            props.onChangeMapping(input.inputId, {
                                                mode: 'savedSecret',
                                                secretName: mapping?.mode === 'savedSecret' ? mapping.secretName : input.title,
                                                secretValue: value,
                                                secretKind: mapping?.mode === 'savedSecret' ? mapping.secretKind : (input.secret ? 'token' : 'other'),
                                            })}
                                        placeholder={t('settings.mcpServersImportSecretValuePlaceholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        style={styles.textInput}
                                        secureTextEntry
                                    />
                                </>
                            ) : (
                                <>
                                    <Text style={styles.fieldLabel}>{t('settings.mcpServersImportMachineEnvPlaceholder')}</Text>
                                    <TextInput
                                        value={mapping?.mode === 'machineEnv' ? mapping.envVarName : input.suggestedEnvVarName}
                                        onChangeText={(value) =>
                                            props.onChangeMapping(input.inputId, {
                                                mode: 'machineEnv',
                                                envVarName: value,
                                            })}
                                        placeholder={t('settings.mcpServersImportMachineEnvPlaceholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        style={styles.textInput}
                                        autoCapitalize="characters"
                                        autoCorrect={false}
                                    />
                                </>
                            )}
                        </View>
                    </ItemGroup>
                );
            })}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    formContent: {
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 16,
        gap: 10,
    },
    fieldLabel: {
        fontSize: 13,
        lineHeight: 16,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    textInput: {
        borderRadius: 12,
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        color: theme.colors.input.text,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...SETTINGS_TEXT_INPUT_METRICS,
    },
}));
