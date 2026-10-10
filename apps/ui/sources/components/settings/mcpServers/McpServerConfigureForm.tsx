import * as React from 'react';

import {
    type McpServerBindingV1,
    type McpServerCatalogEntryTransportV1,
    type McpServerCatalogEntryV1,
} from '@happier-dev/protocol';

import { McpServerBindingEditor } from '@/components/settings/mcpServers/McpServerBindingEditor';
import { McpServerBindingDraftExpander } from '@/components/settings/mcpServers/McpServerBindingDraftExpander';
import { McpServerTestPanel } from '@/components/settings/mcpServers/McpServerTestPanel';
import { McpValueRefMapEditor } from '@/components/settings/mcpServers/McpValueRefMapEditor';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { StringListField } from '@/components/ui/forms/StringListField';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { parseMcpCommandLine } from '@/sync/domains/settings/mcpServers/parseMcpCommandLine';
import { t } from '@/text';

/**
 * The sections of one MCP server's editor: what it is called, how Happier starts or reaches it, the
 * values it receives, where it applies (each rule expands in place; a new rule is a draft row), and a
 * test against the managed machine. Saving and deleting belong to the page header.
 */
export const McpServerConfigureForm = React.memo(function McpServerConfigureForm(props: Readonly<{
    draftServer: McpServerCatalogEntryV1;
    draftBindings: McpServerBindingV1[];
    machines: readonly Machine[];
    targetSelection: MachineAdministrationTargetSelectionV1;
    secrets: SavedSecret[];
    scope?: AccountSettingsScope | null;
    onChangeServer: (updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => void;
    onChangeBindings: (updater: (current: McpServerBindingV1[]) => McpServerBindingV1[]) => void;
}>) {
    const [favoriteDirectoriesRaw, setFavoriteDirectoriesRaw] = useSettingMutable('favoriteDirectories');
    const favoriteDirectories = Array.isArray(favoriteDirectoriesRaw) ? favoriteDirectoriesRaw : [];
    const [advancedCommandEditorOpen, setAdvancedCommandEditorOpen] = React.useState(false);
    const { onChangeServer } = props;

    const transportOptions = React.useMemo(() => ([
        { id: 'stdio' as const, label: t('settings.mcpServersTransportLocalTitle'), description: t('settings.mcpServersTransportLocalSubtitle') },
        { id: 'http' as const, label: t('settings.mcpServersTransportHttpTitle'), description: t('settings.mcpServersTransportHttpSubtitle') },
        { id: 'sse' as const, label: t('settings.mcpServersTransportSseTitle'), description: t('settings.mcpServersTransportSseSubtitle') },
    ]), []);

    const setTransport = React.useCallback((transport: McpServerCatalogEntryTransportV1) => {
        onChangeServer((current) => {
            const now = Date.now();
            if (transport === 'stdio') {
                return {
                    ...current,
                    transport,
                    stdio: current.stdio ?? { command: '', args: [] },
                    remote: undefined,
                    updatedAt: now,
                };
            }
            return {
                ...current,
                transport,
                remote: current.remote ?? { url: '', headers: {} },
                stdio: undefined,
                updatedAt: now,
            };
        });
    }, [onChangeServer]);

    const commandLineValue = React.useMemo(() => {
        const command = props.draftServer.stdio?.command?.trim() ?? '';
        const args = props.draftServer.stdio?.args ?? [];
        return [command, ...args].filter(Boolean).join(' ');
    }, [props.draftServer.stdio?.args, props.draftServer.stdio?.command]);

    return (
        <>
            <ItemGroup title={t('mcpSettings.serverSection')} description={t('mcpSettings.serverSectionDescription')}>
                <Item
                    title={t('settings.mcpServersFieldName')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="mcp.server.editor.name"
                            value={props.draftServer.name}
                            onChangeText={(text) => onChangeServer((current) => ({ ...current, name: text, updatedAt: Date.now() }))}
                            accessibilityLabel={t('settings.mcpServersFieldName')}
                            placeholder="my_server"
                            monospace
                        />
                    )}
                />
                <Item
                    title={t('settings.mcpServersFieldTitle')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="mcp.server.editor.title"
                            value={props.draftServer.title ?? ''}
                            onChangeText={(text) => onChangeServer((current) => ({
                                ...current,
                                title: text.trim() ? text : undefined,
                                updatedAt: Date.now(),
                            }))}
                            accessibilityLabel={t('settings.mcpServersFieldTitle')}
                            placeholder={t('settings.mcpServersFieldTitlePlaceholder')}
                            autoCapitalize="words"
                        />
                    )}
                />
            </ItemGroup>

            <ItemGroup title={t('mcpSettings.connectionSection')} description={t('mcpSettings.connectionSectionDescription')}>
                <SegmentedChoiceItem<McpServerCatalogEntryTransportV1>
                    testID="mcp.server.transport"
                    testIDPrefix="mcp.server.transport"
                    title={t('settings.mcpServersFieldTransport')}
                    value={props.draftServer.transport}
                    options={transportOptions}
                    onChange={setTransport}
                />
                {props.draftServer.transport === 'stdio' ? (
                    <Item
                        title={t('settings.mcpServersFieldCommandLine')}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput
                                testID="mcp.server.editor.commandLine"
                                value={commandLineValue}
                                onChangeText={(text) => {
                                    const parsed = parseMcpCommandLine(text);
                                    onChangeServer((current) => ({
                                        ...current,
                                        stdio: { command: parsed.command, args: parsed.args },
                                        updatedAt: Date.now(),
                                    }));
                                }}
                                accessibilityLabel={t('settings.mcpServersFieldCommandLine')}
                                placeholder={t('settings.mcpServersFieldCommandLinePlaceholder')}
                                monospace
                            />
                        )}
                    />
                ) : (
                    <Item
                        title={t('settings.mcpServersFieldUrl')}
                        accessoryLayout="adaptive"
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput
                                testID="mcp.server.editor.url"
                                value={props.draftServer.remote?.url ?? ''}
                                onChangeText={(text) => onChangeServer((current) => ({
                                    ...current,
                                    remote: { url: text, headers: current.remote?.headers ?? {} },
                                    updatedAt: Date.now(),
                                }))}
                                accessibilityLabel={t('settings.mcpServersFieldUrl')}
                                placeholder="https://example.com/mcp"
                                keyboardType="url"
                                monospace
                            />
                        )}
                    />
                )}
                {props.draftServer.transport === 'stdio' ? (
                    <ExpandableItem
                        testID="mcp.server.editor.advancedCommand"
                        expanded={advancedCommandEditorOpen}
                        onExpandedChange={setAdvancedCommandEditorOpen}
                        header={({ headerProps }) => (
                            <Item
                                {...headerProps}
                                title={t('settings.mcpServersAdvancedCommandEditorTitle')}
                                subtitle={t('settings.mcpServersAdvancedCommandEditorSubtitle')}
                                showChevron={false}
                            />
                        )}
                    >
                        <Item
                            title={t('settings.mcpServersFieldCommand')}
                            accessoryLayout="adaptive"
                            showChevron={false}
                            showDivider={false}
                            rightElement={(
                                <FieldTextInput
                                    testID="mcp.server.editor.command"
                                    value={props.draftServer.stdio?.command ?? ''}
                                    onChangeText={(text) => onChangeServer((current) => ({
                                        ...current,
                                        stdio: { command: text, args: current.stdio?.args ?? [] },
                                        updatedAt: Date.now(),
                                    }))}
                                    accessibilityLabel={t('settings.mcpServersFieldCommand')}
                                    placeholder="node"
                                    monospace
                                />
                            )}
                        />
                        <Item
                            title={t('settings.mcpServersFieldArgs')}
                            accessoryLayout="stacked"
                            showChevron={false}
                            showDivider={false}
                            rightElement={(
                                <StringListField
                                    testID="mcp.server.editor.args"
                                    values={props.draftServer.stdio?.args ?? []}
                                    onChange={(args) => onChangeServer((current) => ({
                                        ...current,
                                        stdio: { command: current.stdio?.command ?? '', args },
                                        updatedAt: Date.now(),
                                    }))}
                                    itemLabel={(position) => t('settingsAgents.customAcp.argumentLabel', { position })}
                                    removeLabel={(position) => t('settingsAgents.customAcp.removeArgument', { position })}
                                    addLabel={t('settingsAgents.customAcp.addArgument')}
                                    itemPlaceholder={t('settingsAgents.customAcp.argumentPlaceholder')}
                                    monospace
                                />
                            )}
                        />
                    </ExpandableItem>
                ) : null}
            </ItemGroup>

            <McpValueRefMapEditor
                kind="env"
                title={t('settings.mcpServersEditorEnv')}
                description={t('mcpSettings.envDescription')}
                iconName="code"
                entries={props.draftServer.env}
                secrets={props.secrets}
                scope={props.scope}
                onChangeEntries={(next) => onChangeServer((current) => ({ ...current, env: next, updatedAt: Date.now() }))}
                addRowTitle={t('settings.mcpServersEnvAdd')}
                addRowSubtitle={t('settings.mcpServersEnvAddSubtitle')}
                emptyTitle={t('settings.mcpServersEnvEmptyTitle')}
                emptySubtitle={t('settings.mcpServersEnvEmptySubtitle')}
                testIdPrefix="mcp.server.env"
            />

            {props.draftServer.transport === 'stdio' ? null : (
                <McpValueRefMapEditor
                    kind="header"
                    title={t('settings.mcpServersEditorHeaders')}
                    description={t('mcpSettings.headersDescription')}
                    iconName="key"
                    entries={props.draftServer.remote?.headers ?? {}}
                    secrets={props.secrets}
                    scope={props.scope}
                    onChangeEntries={(next) =>
                        onChangeServer((current) => ({
                            ...current,
                            remote: { url: current.remote?.url ?? '', headers: next },
                            updatedAt: Date.now(),
                        }))}
                    addRowTitle={t('settings.mcpServersHeadersAdd')}
                    addRowSubtitle={t('settings.mcpServersHeadersAddSubtitle')}
                    emptyTitle={t('settings.mcpServersHeadersEmptyTitle')}
                    emptySubtitle={t('settings.mcpServersHeadersEmptySubtitle')}
                    testIdPrefix="mcp.server.headers"
                />
            )}

            <ItemGroup title={t('settings.mcpServersEditorAppliesTo')} description={t('settings.mcpServersEditorAppliesToSubtitle')}>
                {props.draftBindings.length === 0 ? (
                    <Item
                        title={t('settings.mcpServersBindingsEmptyTitle')}
                        subtitle={t('settings.mcpServersBindingsEmptySubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {props.draftBindings.map((binding) => (
                    <McpServerBindingEditor
                        key={binding.id}
                        binding={binding}
                        serverTransport={props.draftServer.transport}
                        secrets={props.secrets}
                        scope={props.scope}
                        machines={props.machines}
                        onChange={(next) => props.onChangeBindings((current) => current.map((item) => (item.id === binding.id ? next : item)))}
                        onDelete={() => props.onChangeBindings((current) => current.filter((item) => item.id !== binding.id))}
                    />
                ))}
                <McpServerBindingDraftExpander
                    serverId={props.draftServer.id}
                    machines={props.machines}
                    favoriteDirectories={favoriteDirectories}
                    onChangeFavoriteDirectories={setFavoriteDirectoriesRaw}
                    onAddBinding={(binding) => props.onChangeBindings((current) => [...current, binding])}
                />
            </ItemGroup>

            <McpServerTestPanel
                server={props.draftServer}
                bindings={props.draftBindings}
                machines={props.machines}
                targetSelection={props.targetSelection}
            />
        </>
    );
});
