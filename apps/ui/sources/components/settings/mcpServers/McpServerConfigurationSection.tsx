import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    type McpServerCatalogEntryTransportV1,
    type McpServerCatalogEntryV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ValueRefRowsEditor } from '@/components/ui/forms/valueRefs/ValueRefRowsEditor';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { StringListField } from '@/components/ui/forms/StringListField';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

export type McpConfigurationSaveState = 'idle' | 'saving' | 'saved' | 'failed';

/** The one transport switch: a command keeps its command, an address keeps its address, the other side is dropped. */
export function withMcpServerTransport(current: McpServerCatalogEntryV1, transport: McpServerCatalogEntryTransportV1): McpServerCatalogEntryV1 {
    if (current.transport === transport) return current;
    return transport === 'stdio'
        ? { ...current, transport, stdio: current.stdio ?? { command: '', args: [] }, remote: undefined, updatedAt: Date.now() }
        : { ...current, transport, remote: current.remote ?? { url: '', headers: {} }, stdio: undefined, updatedAt: Date.now() };
}

/**
 * Everything the catalog entry holds about starting or reaching a server, edited in place (md C).
 * Local: command, arguments (one field each), working folder, environment. Remote: address, headers.
 * Each value commits when focus leaves it (`onCommit`); the server page saves there and says so in
 * the section's action. The new-server form (`mode="create"`) also chooses the transport.
 */
export const McpServerConfigurationSection = React.memo(function McpServerConfigurationSection(props: Readonly<{
    draftServer: McpServerCatalogEntryV1;
    /** The last reviewed/acknowledged server, separate from the controlled local draft. */
    committedServer?: McpServerCatalogEntryV1 | null;
    secrets: SavedSecret[];
    scope?: AccountSettingsScope | null;
    /**
     * `create` adds the transport choice; a saved server's transport is a fact of its header. `machine` edits the
     * values one machine runs, so the rows drop the descriptions that speak for every machine.
     */
    mode?: 'create' | 'edit' | 'machine';
    /**
     * The transports `create` offers (default all three). The Add dialog's Custom list already chose command or
     * remote, so its form offers only what is left of that choice; one option draws no picker.
     */
    transports?: readonly McpServerCatalogEntryTransportV1[];
    /** Shown but not editable (an add is pending): every field, list and value row holds still. */
    readOnly?: boolean;
    /** Section title and purpose (the server page names it Configuration). */
    title?: string;
    description?: string;
    /** A value was committed (field blur, a type or secret chosen, a row removed): save now. */
    onCommit?: () => void;
    saveState?: McpConfigurationSaveState;
    /** Names whose value is missing (the banner's "Add key" lands here). */
    attentionKeys?: ReadonlySet<string>;
    onChangeServer: (updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => void;
}>) {
    const { theme } = useUnistyles();
    const { onChangeServer, onCommit } = props;
    const server = props.draftServer;
    const committed = props.committedServer;
    const local = server.transport === 'stdio';
    const [folderMenuOpen, setFolderMenuOpen] = React.useState(false);
    const [folderChoice, setFolderChoice] = React.useState<'session' | 'path'>(server.stdio?.cwd?.t === 'path' ? 'path' : 'session');
    React.useEffect(() => { setFolderChoice(server.stdio?.cwd?.t === 'path' ? 'path' : 'session'); }, [server.stdio?.cwd?.t]);

    const readOnly = props.readOnly === true;
    const offered = props.transports;
    const transportOptions = React.useMemo(() => ([
        { id: 'stdio' as const, label: t('settings.mcpServersTransportLocalTitle'), description: t('settings.mcpServersTransportLocalSubtitle') },
        { id: 'http' as const, label: t('settings.mcpServersTransportHttpTitle'), description: t('settings.mcpServersTransportHttpSubtitle') },
        { id: 'sse' as const, label: t('settings.mcpServersTransportSseTitle'), description: t('settings.mcpServersTransportSseSubtitle') },
    ].filter(option => offered === undefined || offered.includes(option.id))), [offered]);

    const setTransport = React.useCallback((transport: McpServerCatalogEntryTransportV1) => {
        onChangeServer((current) => withMcpServerTransport(current, transport));
    }, [onChangeServer]);

    const setStdio = React.useCallback((patch: (stdio: NonNullable<McpServerCatalogEntryV1['stdio']>) => NonNullable<McpServerCatalogEntryV1['stdio']>) => {
        onChangeServer((current) => ({ ...current, stdio: patch(current.stdio ?? { command: '', args: [] }), updatedAt: Date.now() }));
    }, [onChangeServer]);

    const commitWith = React.useCallback((change: () => void) => {
        change();
        onCommit?.();
    }, [onCommit]);

    const folderItems = React.useMemo(() => [
        { id: 'session', title: t('capabilities.mcp.config.sessionFolder') },
        { id: 'path', title: t('capabilities.mcp.config.aFolder') },
    ], []);

    const savedLine = props.saveState === 'saved' || props.saveState === 'saving' || props.saveState === 'failed' ? (
        <View testID="mcp.server.config.saveState" style={styles.saved}>
            {props.saveState === 'saved' ? <Icon name="check" size={14} color={theme.colors.text.secondary} /> : null}
            <Text variant="meta" style={{ color: props.saveState === 'failed' ? theme.colors.state.danger.foreground : theme.colors.text.secondary }}>
                {props.saveState === 'saved' ? t('capabilities.mcp.config.saved')
                    : props.saveState === 'saving' ? t('capabilities.mcp.config.saving')
                        : t('capabilities.mcp.config.saveFailed')}
            </Text>
        </View>
    ) : undefined;

    return (
        <ItemGroup
            testID="mcp.server.config"
            title={props.title ?? t('mcpSettings.connectionSection')}
            description={props.description ?? (props.mode === 'machine' ? undefined : t('mcpSettings.connectionSectionDescription'))}
            action={savedLine}
        >
            {props.mode === 'create' ? (
                <Item
                    title={t('settings.mcpServersFieldName')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    disabled={readOnly}
                    rightElement={(
                        <FieldTextInput
                            testID="mcp.server.editor.name"
                            value={server.name}
                            onChangeText={(text) => onChangeServer((current) => ({ ...current, name: text, updatedAt: Date.now() }))}
                            accessibilityLabel={t('settings.mcpServersFieldName')}
                            placeholder="my_server"
                            monospace
                            editable={!readOnly}
                        />
                    )}
                />
            ) : null}
            {props.mode === 'create' && transportOptions.length > 1 ? (
                <SegmentedChoiceItem<McpServerCatalogEntryTransportV1>
                    testID="mcp.server.transport"
                    testIDPrefix="mcp.server.transport"
                    title={t('settings.mcpServersFieldTransport')}
                    value={server.transport}
                    options={transportOptions}
                    onChange={setTransport}
                    disabled={readOnly}
                />
            ) : null}
            {local ? (
                <>
                    <FieldValueItem
                        testID="mcp.server.config.command"
                        fieldTestID="mcp.server.editor.command"
                        title={t('capabilities.mcp.config.command')}
                        subtitle={props.mode === 'machine' ? undefined : t('capabilities.mcp.config.commandDescription')}
                        value={server.stdio?.command ?? ''}
                        committedValue={committed ? committed.stdio?.command ?? '' : undefined}
                        placeholder="npx"
                        monospace
                        disabled={readOnly}
                        onDraftChange={(command) => setStdio((stdio) => ({ ...stdio, command }))}
                        onCommit={(draft) => {
                            const command = draft.trim();
                            commitWith(() => setStdio((stdio) => ({ ...stdio, command })));
                        }}
                    />
                    <Item
                        testID="mcp.server.config.arguments"
                        title={t('capabilities.mcp.config.arguments')}
                        // One field per argument, as wide as the values below it (Environment's rhythm).
                        accessoryLayout="stacked"
                        showChevron={false}
                        disabled={readOnly}
                        rightElement={(
                            <StringListField
                                testID="mcp.server.editor.args"
                                values={server.stdio?.args ?? []}
                                onChange={(args) => setStdio((stdio) => ({ ...stdio, args }))}
                                onCommit={onCommit}
                                itemLabel={(position) => t('capabilities.mcp.config.argument', { position })}
                                removeLabel={(position) => t('capabilities.mcp.config.removeArgument', { position })}
                                addLabel={t('capabilities.mcp.config.addArgument')}
                                monospace
                                disabled={readOnly}
                            />
                        )}
                    />
                    <DropdownMenu
                        testID="mcp.server.config.folder"
                        open={folderMenuOpen && !readOnly}
                        onOpenChange={(open) => setFolderMenuOpen(open && !readOnly)}
                        variant="selectable"
                        search={false}
                        selectedId={folderChoice}
                        showCategoryTitles={false}
                        matchTriggerWidth
                        connectToTrigger
                        rowKind="item"
                        itemTrigger={{ title: t('capabilities.mcp.config.workingFolder'), subtitle: t('capabilities.mcp.config.workingFolderDescription'), showSelectedSubtitle: false,
                            // Held while a create is pending: the row dims like the fields above it.
                            ...(readOnly ? { itemProps: { disabled: true } } : {}) }}
                        items={folderItems}
                        onSelect={(id) => {
                            setFolderMenuOpen(false);
                            if (id === 'session') {
                                setFolderChoice('session');
                                commitWith(() => setStdio(({ cwd: _cwd, ...stdio }) => stdio));
                            } else {
                                setFolderChoice('path');
                            }
                        }}
                    />
                    {folderChoice === 'path' ? (
                        <FieldValueItem
                            testID="mcp.server.config.folderPath"
                            fieldTestID="mcp.server.editor.cwd"
                            title={t('capabilities.mcp.config.folderPath')}
                            value={server.stdio?.cwd?.t === 'path' ? server.stdio.cwd.path : ''}
                            committedValue={committed ? committed.stdio?.cwd?.t === 'path' ? committed.stdio.cwd.path : '' : undefined}
                            placeholder="/srv/project"
                            monospace
                            disabled={readOnly}
                            autoFocus={server.stdio?.cwd?.t !== 'path'}
                            onDraftChange={(path) => setStdio((stdio) => ({ ...stdio, cwd: { t: 'path', path } }))}
                            onCommit={(draft) => {
                                const path = draft.trim();
                                if (!path) return;
                                commitWith(() => setStdio((stdio) => ({ ...stdio, cwd: { t: 'path', path } })));
                            }}
                        />
                    ) : null}
                </>
            ) : (
                <FieldValueItem
                    testID="mcp.server.config.address"
                    fieldTestID="mcp.server.editor.url"
                    title={t('capabilities.mcp.config.address')}
                    subtitle={props.mode === 'machine' ? undefined : t('capabilities.mcp.config.addressDescription')}
                    // An address is long: it takes the row's width under its label.
                    accessoryLayout="stacked"
                    value={server.remote?.url ?? ''}
                    committedValue={committed ? committed.remote?.url ?? '' : undefined}
                    placeholder="https://example.com/mcp"
                    monospace
                    disabled={readOnly}
                    onDraftChange={(url) => onChangeServer((current) => ({ ...current, remote: { ...(current.remote ?? { headers: {} }), url }, updatedAt: Date.now() }))}
                    onCommit={(draft) => {
                        const url = draft.trim();
                        commitWith(() => onChangeServer((current) => ({ ...current, remote: { ...(current.remote ?? { headers: {} }), url }, updatedAt: Date.now() })));
                    }}
                />
            )}
            <Item
                testID={local ? 'mcp.server.config.env' : 'mcp.server.config.headers'}
                title={local ? t('capabilities.mcp.config.environment') : t('capabilities.mcp.config.headers')}
                subtitle={local ? t('capabilities.mcp.config.environmentDescription') : t('capabilities.mcp.config.headersDescription')}
                accessoryLayout="stacked"
                showChevron={false}
                disabled={readOnly}
                rightElement={local ? (
                    <ValueRefRowsEditor
                        kind="env"
                        entries={server.env}
                        secrets={props.secrets}
                        scope={props.scope}
                        attentionKeys={props.attentionKeys}
                        addLabel={t('capabilities.mcp.config.addVariable')}
                        readOnly={readOnly}
                        testIdPrefix="mcp.server.env"
                        onChangeEntries={(env) => commitWith(() => onChangeServer((current) => ({ ...current, env, updatedAt: Date.now() })))}
                    />
                ) : (
                    <ValueRefRowsEditor
                        kind="header"
                        entries={server.remote?.headers ?? {}}
                        secrets={props.secrets}
                        scope={props.scope}
                        attentionKeys={props.attentionKeys}
                        addLabel={t('capabilities.mcp.config.addHeader')}
                        readOnly={readOnly}
                        testIdPrefix="mcp.server.headers"
                        onChangeEntries={(headers) => commitWith(() => onChangeServer((current) => ({ ...current, remote: { ...(current.remote ?? { url: '' }), headers }, updatedAt: Date.now() })))}
                    />
                )}
            />
        </ItemGroup>
    );
});

const styles = StyleSheet.create((theme) => ({
    saved: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
}));
