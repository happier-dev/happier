import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ImportedMcpInputResolutionV1 } from '@/sync/domains/settings/mcpServers/materializeImportedMcpServerDrafts';
import type { McpQuickInstallPresetId } from '@/sync/domains/settings/mcpServers/mcpQuickInstallCatalog';
import { buildQuickInstallMcpDraft, listMcpQuickInstallPresets } from '@/sync/domains/settings/mcpServers/mcpQuickInstallCatalog';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { t } from '@/text';

import { McpInputMappingEditor } from './McpInputMappingEditor';

export const McpServerQuickInstallTab = React.memo(function McpServerQuickInstallTab(props: Readonly<{
    machineItems: readonly DropdownMenuItem[];
    selectedMachineId: string | null;
    onSelectMachine: (machineId: string) => void;
    machineMenuOpen: boolean;
    onMachineMenuOpenChange: (open: boolean) => void;
    selectedPresetIds: readonly McpQuickInstallPresetId[];
    onTogglePresetId: (presetId: McpQuickInstallPresetId) => void;
    inputMappingsByPreset: Partial<Record<McpQuickInstallPresetId, Record<string, ImportedMcpInputResolutionV1>>>;
    onChangeInputMapping: (presetId: McpQuickInstallPresetId, inputId: string, next: ImportedMcpInputResolutionV1) => void;
    mappingIssuesByPreset: Partial<Record<McpQuickInstallPresetId, readonly string[]>>;
    onCancel: () => void;
    onInstall: () => void;
}>) {
    const { theme } = useUnistyles();
    const presets = React.useMemo(() => listMcpQuickInstallPresets(), []);
    const selectedPresetIdSet = React.useMemo(() => new Set(props.selectedPresetIds), [props.selectedPresetIds]);
    const selectedDrafts = React.useMemo(
        () => props.selectedPresetIds.map((presetId) => buildQuickInstallMcpDraft(presetId)),
        [props.selectedPresetIds],
    );
    const hasMappingIssues = React.useMemo(
        () => selectedDrafts.some((draft) => (props.mappingIssuesByPreset[draft.preset.id]?.length ?? 0) > 0),
        [props.mappingIssuesByPreset, selectedDrafts],
    );

    return (
        <>
            <ItemGroup title={t('settings.mcpServersQuickInstallTitle')} footer={t('settings.mcpServersQuickInstallSubtitle')}>
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

                {presets.map((preset) => {
                    const selected = selectedPresetIdSet.has(preset.id);
                    return (
                        <Item
                            key={preset.id}
                            testID={`mcp.server.quickInstall.preset.${preset.id}`}
                            title={preset.title}
                            subtitle={preset.description}
                            icon={<Ionicons name="flash-outline" size={29} color={theme.colors.state.success.foreground} />}
                            selected={selected}
                            rightElement={(
                                <Ionicons
                                    name="checkmark-circle"
                                    size={22}
                                    color={theme.colors.text.primary}
                                    style={{ opacity: selected ? 1 : 0 }}
                                />
                            )}
                            onPress={() => props.onTogglePresetId(preset.id)}
                        />
                    );
                })}
            </ItemGroup>

            {selectedDrafts.length === 0 ? (
                <ItemGroup>
                    <Item
                        testID="mcp.server.quickInstall.empty"
                        title={t('settings.mcpServersQuickInstallEmptyTitle')}
                        subtitle={t('settings.mcpServersQuickInstallEmptySubtitle')}
                        icon={<Ionicons name="flash-outline" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : (
                selectedDrafts.map((draft) => {
                    const mappingIssues = props.mappingIssuesByPreset[draft.preset.id] ?? [];
                    return (
                        <React.Fragment key={draft.preset.id}>
                            <McpInputMappingEditor
                                inputs={draft.inputs}
                                mappings={props.inputMappingsByPreset[draft.preset.id] ?? {}}
                                onChangeMapping={(inputId, next) => props.onChangeInputMapping(draft.preset.id, inputId, next)}
                            />

                            {mappingIssues.length > 0 ? (
                                <ItemGroup title={t('settings.mcpServersImportJsonWarningsTitle')}>
                                    {mappingIssues.map((warning) => (
                                        <Item
                                            key={`${draft.preset.id}:${warning}`}
                                            title={draft.preset.title}
                                            subtitle={warning}
                                            icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.text.secondary} />}
                                            showChevron={false}
                                            mode="info"
                                        />
                                    ))}
                                </ItemGroup>
                            ) : null}
                        </React.Fragment>
                    );
                })
            )}

            <SettingsActionFooter
                secondaryLabel={t('common.cancel')}
                onSecondaryPress={props.onCancel}
                secondaryTestID="mcp.server.quickInstall.cancel"
                primaryLabel={t('settings.mcpServersQuickInstallAction')}
                primaryDisabled={selectedDrafts.length === 0 || hasMappingIssues}
                onPrimaryPress={props.onInstall}
                primaryTestID="mcp.server.quickInstall.install"
            />
        </>
    );
});
