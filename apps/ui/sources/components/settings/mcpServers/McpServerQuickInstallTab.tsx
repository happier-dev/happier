import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ImportedMcpInputResolutionV1 } from '@/sync/domains/settings/mcpServers/materializeImportedMcpServerDrafts';
import type { McpQuickInstallPresetId } from '@/sync/domains/settings/mcpServers/mcpQuickInstallCatalog';
import { buildQuickInstallMcpDraft, listMcpQuickInstallPresets } from '@/sync/domains/settings/mcpServers/mcpQuickInstallCatalog';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { t } from '@/text';

import { McpInputMappingEditor } from './McpInputMappingEditor';
import { Icon } from '@/components/ui/icons/Icon';

export const McpServerQuickInstallTab = React.memo(function McpServerQuickInstallTab(props: Readonly<{
    canExecute: boolean;
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
                {presets.map((preset) => {
                    const selected = selectedPresetIdSet.has(preset.id);
                    return (
                        <Item
                            key={preset.id}
                            testID={`mcp.server.quickInstall.preset.${preset.id}`}
                            title={preset.title}
                            subtitle={preset.description}
                            icon={<Icon name="lightning" size={29} color={theme.colors.state.success.foreground} />}
                            selected={selected}
                            rightElement={(
                                <Icon
                                    name="check-circle"
                                    size={20}
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
                        icon={<Icon name="lightning" size={29} color={theme.colors.text.secondary} />}
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
                                            icon={<Icon name="warning-circle" size={29} color={theme.colors.text.secondary} />}
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
                primaryDisabled={!props.canExecute || selectedDrafts.length === 0 || hasMappingIssues}
                onPrimaryPress={props.onInstall}
                primaryTestID="mcp.server.quickInstall.install"
            />
        </>
    );
});
