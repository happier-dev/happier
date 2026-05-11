import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
    McpServerBindingV1Schema,
    McpServerCatalogEntryV1Schema,
    type McpServerBindingV1,
    type McpServerCatalogEntryV1,
} from '@happier-dev/protocol';

import { McpServerConfigureForm } from '@/components/settings/mcpServers/McpServerConfigureForm';
import { McpServerImportJsonTab } from '@/components/settings/mcpServers/McpServerImportJsonTab';
import { McpServerQuickInstallTab } from '@/components/settings/mcpServers/McpServerQuickInstallTab';
import { McpSegmentedHeader } from '@/components/settings/mcpServers/McpSegmentedHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import { deleteMcpServerCatalogEntryV1, upsertMcpServerWithBindingsV1 } from '@/sync/domains/settings/mcpServers/mcpServerCrud';
import {
    materializeImportedMcpServerDrafts,
    type ImportedMcpInputResolutionV1,
} from '@/sync/domains/settings/mcpServers/materializeImportedMcpServerDrafts';
import { getImportedMcpInputResolutionIssues } from '@/sync/domains/settings/mcpServers/importedMcpInputResolutionValidation';
import { buildQuickInstallMcpDraft, type McpQuickInstallPresetId } from '@/sync/domains/settings/mcpServers/mcpQuickInstallCatalog';
import { normalizeMcpServersSettingsV1 } from '@/sync/domains/settings/mcpServers/normalizeMcpServersSettingsV1';
import { parseImportedMcpServerJson } from '@/sync/domains/settings/mcpServers/parseImportedMcpServerJson';
import { t } from '@/text';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { useActiveUnsavedChangesGuard } from '@/utils/navigation/useActiveUnsavedChangesGuard';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';

type NavigationLike = Readonly<{
    setOptions?: (options: Readonly<Record<string, unknown>>) => void;
    dispatch?: (action: unknown) => void;
}>;

function createDefaultServerName(existingNames: ReadonlySet<string>): string {
    if (!existingNames.has('server')) return 'server';
    for (let index = 2; index < 999; index += 1) {
        const candidate = `server_${index}`;
        if (!existingNames.has(candidate)) return candidate;
    }
    return `server_${Date.now()}`;
}

function createDraftServer(existingNames: ReadonlySet<string>): McpServerCatalogEntryV1 {
    const now = Date.now();
    return {
        id: randomUUID(),
        name: createDefaultServerName(existingNames),
        transport: 'stdio',
        stdio: { command: '', args: [] },
        env: {},
        createdAt: now,
        updatedAt: now,
    };
}

function createDefaultInputMappings(inputs: ReadonlyArray<{ inputId: string; title: string; suggestedEnvVarName: string; secret: boolean }>): Record<string, ImportedMcpInputResolutionV1> {
    return Object.fromEntries(inputs.map((input) => [
        input.inputId,
        input.secret
            ? {
                mode: 'savedSecret',
                secretName: input.title,
                secretValue: '',
                secretKind: 'token',
            }
            : {
                mode: 'machineEnv',
                envVarName: input.suggestedEnvVarName,
            },
    ]));
}

function collectInputMappingIssues(
    inputs: ReadonlyArray<{ inputId: string; title: string; suggestedEnvVarName: string; secret: boolean }>,
    mappings: Record<string, ImportedMcpInputResolutionV1>,
): string[] {
    const issues: string[] = [];

    for (const input of inputs) {
        const mapping = mappings[input.inputId];
        for (const issue of getImportedMcpInputResolutionIssues(mapping)) {
            switch (issue) {
                case 'missingSecretName':
                    issues.push(t('settings.mcpServersImportMappingMissingSecretName', { input: input.title }));
                    break;
                case 'missingSecretValue':
                    issues.push(t('settings.mcpServersImportMappingMissingSecretValue', { input: input.title }));
                    break;
                case 'missingMachineEnvName':
                    issues.push(t('settings.mcpServersImportMappingMissingMachineEnvName', { input: input.title }));
                    break;
            }
        }
    }

    return issues;
}

export const McpServerEditorScreen = React.memo(function McpServerEditorScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const nav = navigation as NavigationLike;
    const ignoreBeforeRemoveRef = React.useRef(false);
    const isDirtyRef = React.useRef(false);
    const machines = useAllMachines();
    const [secrets, setSecrets] = useSettingMutable('secrets');

    const {
        serverId: serverIdParam,
        addMode: addModeParam,
        presetId: presetIdParam,
    } = useLocalSearchParams<{ serverId?: string; addMode?: string; presetId?: string }>();
    const serverId = typeof serverIdParam === 'string' && serverIdParam.trim() ? serverIdParam.trim() : null;
    const addMode = typeof addModeParam === 'string' && addModeParam.trim() ? addModeParam.trim() : null;
    const presetId = typeof presetIdParam === 'string' && presetIdParam.trim() ? presetIdParam.trim() as McpQuickInstallPresetId : null;

    const [mcpSettings, setMcpSettings] = useSettingMutable('mcpServersSettingsV1');
    const normalizedSettings = React.useMemo(() => normalizeMcpServersSettingsV1(mcpSettings), [mcpSettings]);
    const existingNames = React.useMemo(() => new Set(normalizedSettings.servers.map((server) => server.name)), [normalizedSettings.servers]);

    const existingServer: McpServerCatalogEntryV1 | null = React.useMemo(() => {
        if (!serverId) return null;
        return normalizedSettings.servers.find((server) => server.id === serverId) ?? null;
    }, [normalizedSettings, serverId]);

    const existingBindings: McpServerBindingV1[] = React.useMemo(() => {
        if (!serverId) return [];
        return normalizedSettings.bindings.filter((binding) => binding.serverId === serverId);
    }, [normalizedSettings, serverId]);

    const [draftServer, setDraftServer] = React.useState<McpServerCatalogEntryV1>(() => existingServer ?? createDraftServer(existingNames));
    const [draftBindings, setDraftBindings] = React.useState<McpServerBindingV1[]>(() => existingBindings);
    const [isDirty, setIsDirty] = React.useState(false);
    const [activeTab, setActiveTab] = React.useState<'configure' | 'importJson' | 'quickInstall'>(() => {
        if (serverId) return 'configure';
        if (addMode === 'import-json') return 'importJson';
        if (addMode === 'quick-install') return 'quickInstall';
        return 'configure';
    });
    const [importJsonText, setImportJsonText] = React.useState('');
    const [importInputMappings, setImportInputMappings] = React.useState<Record<string, ImportedMcpInputResolutionV1>>({});
    const [quickInstallPresetIds, setQuickInstallPresetIds] = React.useState<readonly McpQuickInstallPresetId[]>(() => (presetId ? [presetId] : []));
    const [quickInstallInputMappingsByPreset, setQuickInstallInputMappingsByPreset] = React.useState<
        Partial<Record<McpQuickInstallPresetId, Record<string, ImportedMcpInputResolutionV1>>>
    >({});
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => machines[0]?.id ?? null);

    React.useEffect(() => {
        if (existingServer) {
            setDraftServer(existingServer);
            setDraftBindings(existingBindings);
            setIsDirty(false);
        }
    }, [existingBindings, existingServer]);

    React.useEffect(() => {
        isDirtyRef.current = isDirty;
    }, [isDirty]);

    React.useEffect(() => {
        // Match profile edit behavior: disable iOS gesture navigation while the draft is dirty.
        const setOptions = nav.setOptions;
        if (typeof setOptions !== 'function') return;
        setOptions({ gestureEnabled: !isDirty });
    }, [isDirty, nav.setOptions]);

    React.useEffect(() => {
        const setOptions = nav.setOptions;
        if (typeof setOptions !== 'function') return;
        return () => {
            setOptions({ gestureEnabled: true });
        };
    }, [nav.setOptions]);

    React.useEffect(() => {
        if (selectedMachineId && machines.some((machine) => machine.id === selectedMachineId)) return;
        setSelectedMachineId(machines[0]?.id ?? null);
    }, [machines, selectedMachineId]);

    const importParseResult = React.useMemo(() => parseImportedMcpServerJson(importJsonText), [importJsonText]);
    const importMappingIssues = React.useMemo(
        () => collectInputMappingIssues(importParseResult.inputs, importInputMappings),
        [importInputMappings, importParseResult.inputs],
    );
    React.useEffect(() => {
        setImportInputMappings(createDefaultInputMappings(importParseResult.inputs));
    }, [importParseResult.inputs]);

    const selectedQuickInstallDrafts = React.useMemo(
        () => quickInstallPresetIds.map((id) => buildQuickInstallMcpDraft(id)),
        [quickInstallPresetIds],
    );
    const quickInstallMappingIssuesByPreset = React.useMemo(() => {
        return Object.fromEntries(selectedQuickInstallDrafts.map((draft) => [
            draft.preset.id,
            collectInputMappingIssues(draft.inputs, quickInstallInputMappingsByPreset[draft.preset.id] ?? {}),
        ])) as Partial<Record<McpQuickInstallPresetId, string[]>>;
    }, [quickInstallInputMappingsByPreset, selectedQuickInstallDrafts]);
    React.useEffect(() => {
        if (quickInstallPresetIds.length === 0) return;
        setQuickInstallInputMappingsByPreset((current) => {
            let changed = false;
            const next = { ...current };
            for (const draft of selectedQuickInstallDrafts) {
                if (next[draft.preset.id]) continue;
                next[draft.preset.id] = createDefaultInputMappings(draft.inputs);
                changed = true;
            }
            return changed ? next : current;
        });
    }, [quickInstallPresetIds, selectedQuickInstallDrafts]);

    const saveDisabled = React.useMemo(() => {
        const parsedServer = McpServerCatalogEntryV1Schema.safeParse(draftServer);
        if (!parsedServer.success) return true;
        return draftBindings.some((binding) => !McpServerBindingV1Schema.safeParse(binding).success);
    }, [draftBindings, draftServer]);

    const resolvedMachineItems = React.useMemo(() => {
        return machines.map((machine) => ({
            id: machine.id,
            title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            subtitle: machine.id,
            icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
        }));
    }, [machines, theme.colors.text.secondary]);

    const closeToMcpServersSettings = React.useCallback(() => {
        // `router.replace` expects the public route (group segments like `/(app)` are not valid here on web).
        router.replace('/settings/mcp');
    }, [router]);

    const commitDraft = React.useCallback((): boolean => {
        const parsedServer = McpServerCatalogEntryV1Schema.safeParse(draftServer);
        if (!parsedServer.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return false;
        }
        const parsedBindings: McpServerBindingV1[] = [];
        for (const binding of draftBindings) {
            const parsed = McpServerBindingV1Schema.safeParse(binding);
            if (!parsed.success) {
                Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
                return false;
            }
            parsedBindings.push(parsed.data);
        }

        try {
            const next = upsertMcpServerWithBindingsV1(normalizedSettings, parsedServer.data, parsedBindings);
            setMcpSettings(next);
            setIsDirty(false);
            return true;
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
            return false;
        }
    }, [draftBindings, draftServer, navigation, normalizedSettings, router, setMcpSettings]);

    const saveAndClose = React.useCallback(() => {
        const didSave = commitDraft();
        if (!didSave) return;
        ignoreBeforeRemoveRef.current = true;
        closeToMcpServersSettings();
    }, [closeToMcpServersSettings, commitDraft]);

    const discardDraft = React.useCallback(() => {
        setDraftServer(existingServer ?? createDraftServer(existingNames));
        setDraftBindings(existingBindings);
        setIsDirty(false);
    }, [existingBindings, existingNames, existingServer]);

    const handleDeleteOrCancel = React.useCallback(async () => {
        if (!serverId) {
            ignoreBeforeRemoveRef.current = true;
            closeToMcpServersSettings();
            return;
        }

        const confirmed = await Modal.confirm(
            t('settings.mcpServersDeleteTitle'),
            t('settings.mcpServersDeleteConfirm', { name: draftServer.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;

        const next = deleteMcpServerCatalogEntryV1(normalizedSettings, serverId);
        setMcpSettings(next);
        ignoreBeforeRemoveRef.current = true;
        closeToMcpServersSettings();
    }, [closeToMcpServersSettings, draftServer.name, normalizedSettings, serverId, setMcpSettings]);

    const handleImportJson = React.useCallback(() => {
        if (!selectedMachineId) {
            Modal.alert(t('common.error'), t('settings.mcpServersNoMachineSelected'));
            return;
        }
        const materialized = materializeImportedMcpServerDrafts({
            settings: normalizedSettings,
            secrets,
            drafts: importParseResult.servers,
            inputMappings: importInputMappings,
            defaultMachineId: selectedMachineId,
            nowMs: Date.now(),
            generateId: randomUUID,
        });
        if (materialized.warnings.length > 0) {
            Modal.alert(t('settings.mcpServersImportJsonWarningsTitle'), materialized.warnings.join('\n'));
        }
        setSecrets(materialized.nextSecrets);
        setMcpSettings(materialized.nextSettings);
        ignoreBeforeRemoveRef.current = true;
        closeToMcpServersSettings();
    }, [closeToMcpServersSettings, importInputMappings, importParseResult.servers, normalizedSettings, secrets, selectedMachineId, setMcpSettings, setSecrets]);

    const handleQuickInstall = React.useCallback(() => {
        if (!selectedMachineId) {
            Modal.alert(t('common.error'), t('settings.mcpServersNoMachineSelected'));
            return;
        }
        if (selectedQuickInstallDrafts.length === 0) {
            Modal.alert(t('common.error'), t('settings.mcpServersQuickInstallEmptyTitle'));
            return;
        }
        let nextSettings = normalizedSettings;
        let nextSecrets = secrets;
        const warnings: string[] = [];
        for (const draft of selectedQuickInstallDrafts) {
            const materialized = materializeImportedMcpServerDrafts({
                settings: nextSettings,
                secrets: nextSecrets,
                drafts: [draft.server],
                inputMappings: quickInstallInputMappingsByPreset[draft.preset.id] ?? {},
                defaultMachineId: selectedMachineId,
                nowMs: Date.now(),
                generateId: randomUUID,
            });
            nextSettings = materialized.nextSettings;
            nextSecrets = materialized.nextSecrets;
            warnings.push(...materialized.warnings);
        }
        if (warnings.length > 0) {
            Modal.alert(t('settings.mcpServersImportJsonWarningsTitle'), warnings.join('\n'));
        }
        setSecrets(nextSecrets);
        setMcpSettings(nextSettings);
        ignoreBeforeRemoveRef.current = true;
        closeToMcpServersSettings();
    }, [closeToMcpServersSettings, normalizedSettings, quickInstallInputMappingsByPreset, secrets, selectedMachineId, selectedQuickInstallDrafts, setMcpSettings, setSecrets]);

    const requestUnsavedChangesDecision = React.useCallback(async () => {
        return await promptUnsavedChangesAlert(
            (title, message, buttons) => Modal.alert(title, message, buttons),
            {
                title: t('common.discardChanges'),
                message: t('common.unsavedChangesWarning'),
                discardText: t('common.discard'),
                saveText: t('common.save'),
                keepEditingText: t('common.keepEditing'),
            },
        );
    }, []);

    const continueNavigation = React.useCallback((action: unknown) => {
        if (action && typeof nav.dispatch === 'function') {
            nav.dispatch(action);
            return;
        }
        closeToMcpServersSettings();
    }, [closeToMcpServersSettings, nav.dispatch]);

    useUnsavedChangesBeforeRemoveGuard({
        navigation,
        ignoreRef: ignoreBeforeRemoveRef,
        isDirtyRef,
        requestDecision: requestUnsavedChangesDecision,
        onSave: commitDraft,
        onContinue: continueNavigation,
        tag: 'McpServerEditorScreen.beforeRemove',
    });

    useActiveUnsavedChangesGuard({
        navigation,
        guard: React.useMemo(() => ({
            isDirtyRef,
            ignoreRef: ignoreBeforeRemoveRef,
            requestDecision: requestUnsavedChangesDecision,
            onDiscard: discardDraft,
            onSave: commitDraft,
            tag: 'McpServerEditorScreen.shellGuard',
        }), [commitDraft, discardDraft, requestUnsavedChangesDecision]),
    });

    const renderHeaderRight = React.useCallback(() => {
        if (activeTab !== 'configure') return null;
        return (
            <Pressable
                onPress={saveAndClose}
                disabled={!isDirty || saveDisabled}
                accessibilityRole="button"
                accessibilityLabel={t('common.save')}
                hitSlop={12}
                style={({ pressed }) => ({
                    opacity: !isDirty || saveDisabled ? 0.35 : pressed ? 0.7 : 1,
                    padding: 4,
                })}
            >
                <Ionicons name="checkmark" size={24} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }, [activeTab, isDirty, saveAndClose, saveDisabled, theme.colors.chrome.header.foreground]);

    React.useEffect(() => {
        const setOptions = nav.setOptions;
        if (typeof setOptions !== 'function') return;
        setOptions({ headerRight: renderHeaderRight });
    }, [nav.setOptions, renderHeaderRight]);

    if (serverId && !existingServer) {
        return (
            <ItemList>
                <ItemGroup>
                    <Item
                        title={t('common.error')}
                        subtitle={t('settings.mcpServersServerNotFound')}
                        icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.state.danger.foreground} />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const showAddFlowTabs = !serverId;

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            {showAddFlowTabs ? (
                <McpSegmentedHeader
                    title={t('settings.mcpServersAddServer')}
                    subtitle={t('settings.mcpServersAddServerFlowSubtitle')}
                    tabs={[
                        { id: 'configure', label: t('settings.mcpServersAddFlowConfigureTitle') },
                        { id: 'importJson', label: t('settings.mcpServersAddFlowImportJsonTitle') },
                        { id: 'quickInstall', label: t('settings.mcpServersAddFlowQuickInstallTitle') },
                    ]}
                    activeTabId={activeTab}
                    onSelectTab={setActiveTab}
                    testIDPrefix="mcp.server.addFlow.tab"
                />
            ) : null}

            {activeTab === 'configure' ? (
                <McpServerConfigureForm
                    draftServer={draftServer}
                    draftBindings={draftBindings}
                    machines={machines}
                    secrets={secrets}
                    onChangeSecrets={setSecrets}
                    onChangeServer={(updater) => {
                        setIsDirty(true);
                        setDraftServer((current) => updater(current));
                    }}
                    onChangeBindings={(updater) => {
                        setIsDirty(true);
                        setDraftBindings((current) => updater(current));
                    }}
                    onSave={saveAndClose}
                    onDelete={() => { void handleDeleteOrCancel(); }}
                    saveDisabled={saveDisabled}
                    isExistingServer={Boolean(serverId)}
                />
            ) : null}

            {showAddFlowTabs && activeTab === 'importJson' ? (
                <McpServerImportJsonTab
                    rawJson={importJsonText}
                    onChangeRawJson={setImportJsonText}
                    parseResult={importParseResult}
                    machineItems={resolvedMachineItems}
                    selectedMachineId={selectedMachineId}
                    onSelectMachine={setSelectedMachineId}
                    machineMenuOpen={machineMenuOpen}
                    onMachineMenuOpenChange={setMachineMenuOpen}
                    inputMappings={importInputMappings}
                    onChangeInputMapping={(inputId, next) => setImportInputMappings((current) => ({ ...current, [inputId]: next }))}
                    mappingIssues={importMappingIssues}
                    onCancel={() => closeToMcpServersSettings()}
                    onImport={handleImportJson}
                />
            ) : null}

            {showAddFlowTabs && activeTab === 'quickInstall' ? (
                <McpServerQuickInstallTab
                    machineItems={resolvedMachineItems}
                    selectedMachineId={selectedMachineId}
                    onSelectMachine={setSelectedMachineId}
                    machineMenuOpen={machineMenuOpen}
                    onMachineMenuOpenChange={setMachineMenuOpen}
                    selectedPresetIds={quickInstallPresetIds}
                    onTogglePresetId={(presetId) => {
                        setQuickInstallPresetIds((current) => (
                            current.includes(presetId)
                                ? current.filter((value) => value !== presetId)
                                : [...current, presetId]
                        ));
                    }}
                    inputMappingsByPreset={quickInstallInputMappingsByPreset}
                    onChangeInputMapping={(presetId, inputId, next) =>
                        setQuickInstallInputMappingsByPreset((current) => ({
                            ...current,
                            [presetId]: {
                                ...(current[presetId] ?? {}),
                                [inputId]: next,
                            },
                        }))}
                    mappingIssuesByPreset={quickInstallMappingIssuesByPreset}
                    onCancel={() => closeToMcpServersSettings()}
                    onInstall={handleQuickInstall}
                />
            ) : null}
        </ItemList>
    );
});
