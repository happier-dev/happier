import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ImportedMcpInputResolutionV1 } from '@/sync/domains/settings/mcpServers/materializeImportedMcpServerDrafts';
import type { ParseImportedMcpServerJsonResult } from '@/sync/domains/settings/mcpServers/parseImportedMcpServerJson';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { McpInputMappingEditor } from './McpInputMappingEditor';
import { McpServerBadgePills } from './McpServerBadgePills';
import { McpServerRowSummary } from './McpServerRowSummary';
import { resolveTransportIconName, resolveTransportLabel } from './mcpServerUi';

export const McpServerImportJsonTab = React.memo(function McpServerImportJsonTab(props: Readonly<{
    rawJson: string;
    onChangeRawJson: (value: string) => void;
    parseResult: ParseImportedMcpServerJsonResult;
    machineItems: readonly DropdownMenuItem[];
    selectedMachineId: string | null;
    onSelectMachine: (machineId: string) => void;
    machineMenuOpen: boolean;
    onMachineMenuOpenChange: (open: boolean) => void;
    inputMappings: Record<string, ImportedMcpInputResolutionV1>;
    onChangeInputMapping: (inputId: string, next: ImportedMcpInputResolutionV1) => void;
    mappingIssues: readonly string[];
    onCancel: () => void;
    onImport: () => void;
}>) {
    const { theme } = useUnistyles();

    return (
        <>
            <ItemGroup title={t('settings.mcpServersImportJsonTitle')} footer={t('settings.mcpServersImportJsonSubtitle')}>
                <DropdownMenu
                    open={props.machineMenuOpen}
                    onOpenChange={props.onMachineMenuOpenChange}
                    items={props.machineItems}
                    selectedId={props.selectedMachineId}
                    onSelect={props.onSelectMachine}
                    itemTrigger={{
                        title: t('settings.mcpServersDetectedMachineTitle'),
                        subtitle: props.selectedMachineId ?? t('settings.mcpServersNoMachineSelected'),
                        icon: <Ionicons name="laptop-outline" size={29} color={theme.colors.accent.indigo} />,
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />

                <TextInput
                    testID="mcp.server.importJson.input"
                    multiline
                    style={styles.importInput}
                    value={props.rawJson}
                    onChangeText={props.onChangeRawJson}
                    placeholder={t('settings.mcpServersImportJsonPlaceholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </ItemGroup>

            {props.parseResult.errors.length > 0 ? (
                <ItemGroup title={t('settings.mcpServersImportJsonErrorTitle')}>
                    {props.parseResult.errors.map((error, index) => (
                        <Item
                            key={`error:${index}`}
                            title={t('settings.mcpServersImportJsonErrorTitle')}
                            subtitle={error}
                            icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.state.danger.foreground} />}
                            showChevron={false}
                            mode="info"
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {props.parseResult.warnings.length > 0 || props.mappingIssues.length > 0 ? (
                <ItemGroup title={t('settings.mcpServersImportJsonWarningsTitle')}>
                    {[...props.parseResult.warnings, ...props.mappingIssues].map((warning, index) => (
                        <Item
                            key={`warning:${index}`}
                            title={t('settings.mcpServersImportJsonWarningsTitle')}
                            subtitle={warning}
                            icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.text.secondary} />}
                            showChevron={false}
                            mode="info"
                        />
                    ))}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('settings.mcpServersSegmentConfigured')}>
                {props.parseResult.servers.length > 0 ? (
                    props.parseResult.servers.map((server) => (
                        <Item
                            key={server.name}
                            title={server.title || server.name}
                            subtitle={(
                                <McpServerRowSummary
                                    primary={server.transport === 'stdio'
                                        ? `${server.stdio?.command ?? ''} ${(server.stdio?.args ?? []).join(' ')}`.trim()
                                        : server.remote?.url ?? ''}
                                    secondary={server.enabled ? t('settings.mcpServersStatusActive') : t('settings.mcpServersStatusUnavailable')}
                                />
                            )}
                            icon={<Ionicons name={resolveTransportIconName(server.transport)} size={29} color={theme.colors.accent.blue} />}
                            detail={resolveTransportLabel(server.transport)}
                            rightElement={(
                                <McpServerBadgePills
                                    badges={[
                                        {
                                            key: `${server.name}:status`,
                                            label: server.enabled ? t('settings.mcpServersStatusActive') : t('settings.mcpServersStatusUnavailable'),
                                            tone: server.enabled ? 'success' : 'warning',
                                        },
                                    ]}
                                />
                            )}
                            showChevron={false}
                            mode="info"
                        />
                    ))
                ) : (
                    <Item
                        testID="mcp.server.importJson.empty"
                        title={t('settings.mcpServersImportJsonEmptyTitle')}
                        subtitle={t('settings.mcpServersImportJsonEmptySubtitle')}
                        icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                        mode="info"
                    />
                )}
            </ItemGroup>

            <McpInputMappingEditor
                inputs={props.parseResult.inputs}
                mappings={props.inputMappings}
                onChangeMapping={props.onChangeInputMapping}
            />

            <SettingsActionFooter
                secondaryLabel={t('common.cancel')}
                onSecondaryPress={props.onCancel}
                secondaryTestID="mcp.server.importJson.cancel"
                primaryLabel={t('settings.mcpServersImportJsonAction')}
                primaryDisabled={props.parseResult.errors.length > 0 || props.parseResult.servers.length === 0 || props.mappingIssues.length > 0}
                onPrimaryPress={props.onImport}
                primaryTestID="mcp.server.importJson.import"
            />
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    importInput: {
        minHeight: 220,
        marginHorizontal: 16,
        marginVertical: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        paddingHorizontal: 14,
        paddingVertical: 14,
        fontSize: 14,
        lineHeight: 20,
        textAlignVertical: 'top',
    },
}));
