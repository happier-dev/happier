import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
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
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

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
        }
    }, [existingBindings, existingServer]);

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
            icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.textSecondary} />,
        }));
    }, [machines, theme.colors.textSecondary]);

    const handleSave = React.useCallback(() => {
        const parsedServer = McpServerCatalogEntryV1Schema.safeParse(draftServer);
        if (!parsedServer.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        const parsedBindings: McpServerBindingV1[] = [];
        for (const binding of draftBindings) {
            const parsed = McpServerBindingV1Schema.safeParse(binding);
            if (!parsed.success) {
                Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
                return;
            }
            parsedBindings.push(parsed.data);
        }

        try {
            const next = upsertMcpServerWithBindingsV1(normalizedSettings, parsedServer.data, parsedBindings);
            setMcpSettings(next as any);
            safeRouterBack({ router, navigation, fallbackHref: '/settings/mcp' });
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        }
    }, [draftBindings, draftServer, navigation, normalizedSettings, router, setMcpSettings]);

    const handleDeleteOrCancel = React.useCallback(async () => {
        if (!serverId) {
            safeRouterBack({ router, navigation, fallbackHref: '/settings/mcp' });
            return;
        }

        const confirmed = await Modal.confirm(
            t('settings.mcpServersDeleteTitle'),
            t('settings.mcpServersDeleteConfirm', { name: draftServer.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;

        const next = deleteMcpServerCatalogEntryV1(normalizedSettings, serverId);
        setMcpSettings(next as any);
        safeRouterBack({ router, navigation, fallbackHref: '/settings/mcp' });
    }, [draftServer.name, navigation, normalizedSettings, router, serverId, setMcpSettings]);

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
        setMcpSettings(materialized.nextSettings as any);
        safeRouterBack({ router, navigation, fallbackHref: '/settings/mcp' });
    }, [importInputMappings, importParseResult.servers, navigation, normalizedSettings, router, secrets, selectedMachineId, setMcpSettings, setSecrets]);

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
        setMcpSettings(nextSettings as any);
        safeRouterBack({ router, navigation, fallbackHref: '/settings/mcp' });
    }, [navigation, normalizedSettings, quickInstallInputMappingsByPreset, router, secrets, selectedMachineId, selectedQuickInstallDrafts, setMcpSettings, setSecrets]);

    if (serverId && !existingServer) {
        return (
            <ItemList>
                <ItemGroup>
                    <Item
                        title={t('common.error')}
                        subtitle={t('settings.mcpServersServerNotFound')}
                        icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.textDestructive} />}
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
                    onChangeServer={(updater) => setDraftServer((current) => updater(current))}
                    onChangeBindings={(updater) => setDraftBindings((current) => updater(current))}
                    onSave={handleSave}
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
                    onCancel={() => safeRouterBack({ router, navigation, fallbackHref: '/settings/mcp' })}
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
                    onCancel={() => safeRouterBack({ router, navigation, fallbackHref: '/settings/mcp' })}
                    onInstall={handleQuickInstall}
                />
            ) : null}
        </ItemList>
    );
});
