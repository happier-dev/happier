import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    McpServerBindingV1Schema,
    type McpServerBindingTargetV1,
    type McpServerBindingV1,
    type McpServerCatalogEntryTransportV1,
    type McpServerCatalogEntryV1,
} from '@happier-dev/protocol';

import { McpBindingTargetFields, describeBindingTarget } from '@/components/settings/mcpServers/McpBindingTargetFields';
import { McpServerBindingEditor } from '@/components/settings/mcpServers/McpServerBindingEditor';
import { McpServerTestPanel } from '@/components/settings/mcpServers/McpServerTestPanel';
import { McpValueRefMapEditor } from '@/components/settings/mcpServers/McpValueRefMapEditor';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { parseMcpCommandLine } from '@/sync/domains/settings/mcpServers/parseMcpCommandLine';
import { t } from '@/text';
import { McpWorkspaceRootPickerModal } from './McpWorkspaceRootPickerModal';

function createDraftBinding(serverId: string, machines: readonly Machine[]): McpServerBindingV1 {
    const now = Date.now();
    return {
        id: randomUUID(),
        serverId,
        enabled: true,
        target: {
            t: 'machine',
            machineId: machines[0]?.id ?? 'unknown',
        },
        createdAt: now,
        updatedAt: now,
    };
}

export const McpServerConfigureForm = React.memo(function McpServerConfigureForm(props: Readonly<{
    draftServer: McpServerCatalogEntryV1;
    draftBindings: McpServerBindingV1[];
    machines: readonly Machine[];
    secrets: SavedSecret[];
    onChangeSecrets: (next: SavedSecret[]) => void;
    onChangeServer: (updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => void;
    onChangeBindings: (updater: (current: McpServerBindingV1[]) => McpServerBindingV1[]) => void;
    onSave: () => void;
    onDelete: () => void;
    saveDisabled: boolean;
    isExistingServer: boolean;
}>) {
    const { theme } = useUnistyles();
    const [favoriteDirectoriesRaw, setFavoriteDirectoriesRaw] = useSettingMutable('favoriteDirectories');
    const favoriteDirectories = Array.isArray(favoriteDirectoriesRaw) ? favoriteDirectoriesRaw : [];
    const [advancedCommandEditorOpen, setAdvancedCommandEditorOpen] = React.useState(false);
    const [isAddBindingOpen, setIsAddBindingOpen] = React.useState(false);
    const [draftBinding, setDraftBinding] = React.useState<McpServerBindingV1>(() => createDraftBinding(props.draftServer.id, props.machines));

    React.useEffect(() => {
        setDraftBinding((current) => ({
            ...current,
            serverId: props.draftServer.id,
        }));
    }, [props.draftServer.id]);

    const transportItems = React.useMemo(() => ([
        {
            key: 'stdio',
            title: t('settings.mcpServersTransportLocalTitle'),
        },
        {
            key: 'http',
            title: t('settings.mcpServersTransportHttpTitle'),
        },
        {
            key: 'sse',
            title: t('settings.mcpServersTransportSseTitle'),
        },
    ]), []);

    const setTransport = React.useCallback((transport: McpServerCatalogEntryTransportV1) => {
        props.onChangeServer((current) => {
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
    }, [props]);

    const commandLineValue = React.useMemo(() => {
        const command = props.draftServer.stdio?.command?.trim() ?? '';
        const args = props.draftServer.stdio?.args ?? [];
        return [command, ...args].filter(Boolean).join(' ');
    }, [props.draftServer.stdio?.args, props.draftServer.stdio?.command]);

    const resetDraftBinding = React.useCallback(() => {
        setDraftBinding(createDraftBinding(props.draftServer.id, props.machines));
    }, [props.draftServer.id, props.machines]);

    const updateDraftBinding = React.useCallback((updater: (current: McpServerBindingV1) => McpServerBindingV1) => {
        setDraftBinding((current) => updater(current));
    }, []);

    const setDraftBindingTargetType = React.useCallback((nextType: McpServerBindingTargetV1['t']) => {
        updateDraftBinding((current) => {
            const now = Date.now();
            if (nextType === 'allMachines') {
                return { ...current, target: { t: 'allMachines' }, updatedAt: now };
            }

            const fallbackMachineId = current.target.t === 'allMachines'
                ? (props.machines[0]?.id ?? 'unknown')
                : current.target.machineId;

            if (nextType === 'machine') {
                return { ...current, target: { t: 'machine', machineId: fallbackMachineId }, updatedAt: now };
            }

            return {
                ...current,
                target: { t: 'workspace', machineId: fallbackMachineId, workspaceRoot: '/' },
                updatedAt: now,
            };
        });
    }, [props.machines, updateDraftBinding]);

    const setDraftBindingMachineId = React.useCallback((machineId: string) => {
        updateDraftBinding((current) => {
            const now = Date.now();
            if (current.target.t === 'allMachines') return current;
            return { ...current, target: { ...current.target, machineId }, updatedAt: now };
        });
    }, [updateDraftBinding]);

    const openDraftWorkspacePicker = React.useCallback(() => {
        const { target } = draftBinding;
        if (target.t !== 'workspace') return;
        const machine = props.machines.find((item) => item.id === target.machineId) ?? null;
        const homeDir = machine?.metadata?.homeDir || '/home';
        Modal.show({
            component: McpWorkspaceRootPickerModal,
            props: {
                machineId: target.machineId,
                machineHomeDir: homeDir,
                selectedPath: target.workspaceRoot,
                onSelectPath: (workspaceRoot: string) =>
                    updateDraftBinding((current) => {
                        if (current.target.t !== 'workspace') return current;
                        return {
                            ...current,
                            target: { ...current.target, workspaceRoot },
                            updatedAt: Date.now(),
                        };
                    }),
                favoriteDirectories,
                onChangeFavoriteDirectories: setFavoriteDirectoriesRaw,
            },
            closeOnBackdrop: true,
        });
    }, [draftBinding.target, favoriteDirectories, props.machines, setFavoriteDirectoriesRaw, updateDraftBinding]);

    const handleSaveDraftBinding = React.useCallback(() => {
        const parsed = McpServerBindingV1Schema.safeParse(draftBinding);
        if (!parsed.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        props.onChangeBindings((current) => [...current, parsed.data]);
        setIsAddBindingOpen(false);
        resetDraftBinding();
    }, [draftBinding, props, resetDraftBinding]);

    const handleCancelDraftBinding = React.useCallback(() => {
        setIsAddBindingOpen(false);
        resetDraftBinding();
    }, [resetDraftBinding]);

    return (
        <>
            <ItemGroup title={t('settings.mcpServersEditorBasics')}>
                <View style={styles.sectionContent}>
                    <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldName')}</Text>
                    <TextInput
                        testID="mcp.server.editor.name"
                        style={styles.textInput}
                        value={props.draftServer.name}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onChangeText={(text) => props.onChangeServer((current) => ({ ...current, name: text, updatedAt: Date.now() }))}
                        placeholder="my_server"
                        placeholderTextColor={theme.colors.input.placeholder}
                    />

                    <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldTitle')}</Text>
                    <TextInput
                        style={styles.textInput}
                        value={props.draftServer.title ?? ''}
                        onChangeText={(text) => props.onChangeServer((current) => ({
                            ...current,
                            title: text.trim() ? text : undefined,
                            updatedAt: Date.now(),
                        }))}
                        placeholder={t('settings.mcpServersFieldTitlePlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                    />
                </View>
            </ItemGroup>

            <ItemGroup title={t('settings.mcpServersFieldTransport')}>
                <View style={styles.sectionContent}>
                    <View style={styles.segmentedTabsContainer}>
                        <SegmentedTabBar
                            tabs={transportItems.map((item) => ({ id: item.key as McpServerCatalogEntryTransportV1, label: item.title }))}
                            activeTabId={props.draftServer.transport}
                            onSelectTab={(key) => setTransport(key)}
                            testIDPrefix="mcp.server.transport"
                        />
                    </View>

                    {props.draftServer.transport === 'stdio' ? (
                        <>
                            <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldCommandLine')}</Text>
                            <TextInput
                                testID="mcp.server.editor.commandLine"
                                style={styles.textInput}
                                value={commandLineValue}
                                autoCapitalize="none"
                                autoCorrect={false}
                                onChangeText={(text) => {
                                    const parsed = parseMcpCommandLine(text);
                                    props.onChangeServer((current) => ({
                                        ...current,
                                        stdio: { command: parsed.command, args: parsed.args },
                                        updatedAt: Date.now(),
                                    }));
                                }}
                                placeholder={t('settings.mcpServersFieldCommandLinePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                            />

                            <View style={styles.advancedEditorRow}>
                                <Item
                                    title={t('settings.mcpServersAdvancedCommandEditorTitle')}
                                    subtitle={t('settings.mcpServersAdvancedCommandEditorSubtitle')}
                                    icon={<Ionicons name="options-outline" size={29} color={theme.colors.textSecondary} />}
                                    selected={advancedCommandEditorOpen}
                                    onPress={() => setAdvancedCommandEditorOpen((value) => !value)}
                                />
                            </View>

                            {advancedCommandEditorOpen ? (
                                <View style={styles.advancedEditorFields}>
                                    <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldCommand')}</Text>
                                    <TextInput
                                        style={styles.textInput}
                                        value={props.draftServer.stdio?.command ?? ''}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        onChangeText={(text) =>
                                            props.onChangeServer((current) => ({
                                                ...current,
                                                stdio: { command: text, args: current.stdio?.args ?? [] },
                                                updatedAt: Date.now(),
                                            }))}
                                        placeholder="node"
                                        placeholderTextColor={theme.colors.input.placeholder}
                                    />

                                    <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldArgs')}</Text>
                                    <TextInput
                                        style={styles.textInput}
                                        value={(props.draftServer.stdio?.args ?? []).join('\n')}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        multiline
                                        onChangeText={(text) =>
                                            props.onChangeServer((current) => ({
                                                ...current,
                                                stdio: {
                                                    command: current.stdio?.command ?? '',
                                                    args: text.split('\n').map((line) => line.trim()).filter(Boolean),
                                                },
                                                updatedAt: Date.now(),
                                            }))}
                                        placeholder={t('settings.mcpServersArgsPlaceholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                    />
                                </View>
                            ) : null}
                        </>
                    ) : (
                        <>
                            <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldUrl')}</Text>
                            <TextInput
                                style={styles.textInput}
                                value={props.draftServer.remote?.url ?? ''}
                                autoCapitalize="none"
                                autoCorrect={false}
                                onChangeText={(text) =>
                                    props.onChangeServer((current) => ({
                                        ...current,
                                        remote: { url: text, headers: current.remote?.headers ?? {} },
                                        updatedAt: Date.now(),
                                    }))}
                                placeholder="https://example.com/mcp"
                                placeholderTextColor={theme.colors.input.placeholder}
                            />
                        </>
                    )}
                </View>
            </ItemGroup>

            <McpValueRefMapEditor
                kind="env"
                title={t('settings.mcpServersEditorEnv')}
                iconName="code-outline"
                entries={props.draftServer.env}
                secrets={props.secrets}
                onChangeSecrets={props.onChangeSecrets}
                onChangeEntries={(next) => props.onChangeServer((current) => ({ ...current, env: next, updatedAt: Date.now() }))}
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
                    iconName="key-outline"
                    entries={props.draftServer.remote?.headers ?? {}}
                    secrets={props.secrets}
                    onChangeSecrets={props.onChangeSecrets}
                    onChangeEntries={(next) =>
                        props.onChangeServer((current) => ({
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

            {props.draftBindings.length === 0 ? (
                <ItemGroup title={t('settings.mcpServersEditorAppliesTo')} footer={t('settings.mcpServersEditorAppliesToSubtitle')}>
                    <Item
                        title={t('settings.mcpServersBindingsEmptyTitle')}
                        subtitle={t('settings.mcpServersBindingsEmptySubtitle')}
                        icon={<Ionicons name="pin-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {props.draftBindings.map((binding) => (
                <McpServerBindingEditor
                    key={binding.id}
                    binding={binding}
                    serverTransport={props.draftServer.transport}
                    secrets={props.secrets}
                    onChangeSecrets={props.onChangeSecrets}
                    machines={props.machines}
                    onChange={(next) => props.onChangeBindings((current) => current.map((item) => (item.id === binding.id ? next : item)))}
                    onDelete={() => props.onChangeBindings((current) => current.filter((item) => item.id !== binding.id))}
                />
            ))}

            <ItemGroup>
                <InlineAddExpander
                    isOpen={isAddBindingOpen}
                    onOpenChange={(nextOpen) => {
                        setIsAddBindingOpen(nextOpen);
                        if (nextOpen) {
                            resetDraftBinding();
                        } else {
                            handleCancelDraftBinding();
                        }
                    }}
                    title={t('settings.mcpServersAddApplyRule')}
                    subtitle={t('settings.mcpServersAddApplyRuleSubtitle')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.success} />}
                    helpText={t('settings.mcpServersAddApplyRuleHelp')}
                    onCancel={handleCancelDraftBinding}
                    onSave={handleSaveDraftBinding}
                    saveDisabled={!McpServerBindingV1Schema.safeParse(draftBinding).success}
                    cancelLabel={t('common.cancel')}
                    saveLabel={t('settings.mcpServersAddApplyRuleSave')}
                    expandedContainerStyle={styles.expandedBindingContainer}
                >
                    <Text style={styles.draftBindingSummary}>
                        {describeBindingTarget(draftBinding.target, props.machines)}
                    </Text>
                    <McpBindingTargetFields
                        target={draftBinding.target}
                        machines={props.machines}
                        onChangeTargetType={setDraftBindingTargetType}
                        onChangeMachineId={setDraftBindingMachineId}
                        onOpenWorkspacePicker={openDraftWorkspacePicker}
                    />
                </InlineAddExpander>
            </ItemGroup>

            <McpServerTestPanel
                server={props.draftServer}
                bindings={props.draftBindings}
                machines={props.machines}
            />

            <SettingsActionFooter
                primaryLabel={t('common.save')}
                primaryDisabled={props.saveDisabled}
                primaryTestID="mcp.server.editor.save"
                onPrimaryPress={props.onSave}
                secondaryLabel={props.isExistingServer ? t('common.delete') : t('common.cancel')}
                secondaryTestID="mcp.server.editor.secondaryAction"
                secondaryTone={props.isExistingServer ? 'destructive' : 'default'}
                onSecondaryPress={props.onDelete}
            />
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    sectionContent: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
    },
    segmentedTabsContainer: {
        paddingBottom: 12,
    },
    fieldLabel: {
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 8,
        marginTop: 12,
        fontWeight: '600',
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...SETTINGS_TEXT_INPUT_METRICS,
        color: theme.colors.input.text,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    advancedEditorRow: {
        marginTop: 12,
    },
    advancedEditorFields: {
        paddingTop: 8,
    },
    expandedBindingContainer: {
        paddingTop: 0,
    },
    draftBindingSummary: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
}));
