import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    AcpBackendDefinitionV1Schema,
    type AcpBackendDefinitionV1,
    type AcpCatalogAuthParserV1,
    type AcpCatalogAuthSupportV1,
    type AcpCatalogSupportHintV1,
} from '@happier-dev/protocol';

import { McpValueRefMapEditor } from '@/components/settings/mcpServers/McpValueRefMapEditor';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { normalizeAcpCatalogSettingsV1 } from '@/sync/domains/acpCatalog/normalizeAcpCatalogSettingsV1';
import { upsertAcpBackendDefinitionV1 } from '@/sync/domains/acpCatalog/acpCatalogCrud';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { createDraftAcpBackend } from './createDraftAcpBackend';
import { parseMultilineField, stringifyMultilineField } from './multilineFields';
import { resolveAcpBackendTransportProfile } from './resolveAcpBackendTransportProfile';

const authSupportOptions: DropdownMenuItem[] = [
    { id: 'login_terminal', title: 'Login in terminal' },
    { id: 'status_only', title: 'Status only' },
    { id: 'manual_only', title: 'Manual only' },
    { id: 'unsupported', title: 'Unsupported' },
];

const authParserOptions: DropdownMenuItem[] = [
    { id: 'unknown', title: 'Unknown' },
    { id: 'exitCodeOnly', title: 'Exit code only' },
    { id: 'stdoutNonEmpty', title: 'Stdout non-empty' },
    { id: 'kiroWhoamiJson', title: 'Kiro whoami JSON' },
];

const supportHintOptions: DropdownMenuItem[] = [
    { id: 'unknown', title: 'Unknown' },
    { id: 'yes', title: 'Yes' },
    { id: 'no', title: 'No' },
];

const styles = StyleSheet.create((theme) => ({
    sectionContent: {
        padding: 16,
        gap: 12,
    },
    fieldLabel: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        fontWeight: '600',
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
        color: theme.colors.input.text,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...SETTINGS_TEXT_INPUT_METRICS,
    },
}));

function withUpdatedAt<T extends Record<string, unknown>>(draft: T): T & Readonly<{ updatedAt: number }> {
    return { ...draft, updatedAt: Date.now() };
}

export const AcpBackendEditorScreen = React.memo(function AcpBackendEditorScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { backendId } = useLocalSearchParams<{ backendId?: string }>();
    const [settingsRaw, setSettings] = useSettingMutable('acpCatalogSettingsV1');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const settings = React.useMemo(() => normalizeAcpCatalogSettingsV1(settingsRaw), [settingsRaw]);
    const existing = React.useMemo(() => settings.backends.find((entry) => entry.id === backendId) ?? null, [backendId, settings.backends]);
    const [draft, setDraft] = React.useState<AcpBackendDefinitionV1>(() => existing ?? createDraftAcpBackend());

    React.useEffect(() => {
        setDraft(existing ?? createDraftAcpBackend());
    }, [existing]);

    const [authSupportMenuOpen, setAuthSupportMenuOpen] = React.useState(false);
    const [authParserMenuOpen, setAuthParserMenuOpen] = React.useState(false);
    const [supportsModesMenuOpen, setSupportsModesMenuOpen] = React.useState(false);
    const [supportsModelsMenuOpen, setSupportsModelsMenuOpen] = React.useState(false);
    const [supportsConfigOptionsMenuOpen, setSupportsConfigOptionsMenuOpen] = React.useState(false);
    const [promptImageSupportMenuOpen, setPromptImageSupportMenuOpen] = React.useState(false);

    const updateDraft = React.useCallback((updater: (current: AcpBackendDefinitionV1) => AcpBackendDefinitionV1) => {
        setDraft((current) => updater(current));
    }, []);

    const handleSave = React.useCallback(() => {
        const parsed = AcpBackendDefinitionV1Schema.safeParse({
            ...draft,
            id: draft.id.trim(),
            name: draft.name.trim(),
            title: draft.title.trim(),
            description: draft.description?.trim() ? draft.description.trim() : undefined,
            command: draft.command.trim(),
            transportProfile: resolveAcpBackendTransportProfile({
                command: draft.command,
                auth: draft.auth,
            }),
            auth: draft.auth
                ? {
                    ...draft.auth,
                    machineLoginKey: draft.auth.machineLoginKey?.trim() ? draft.auth.machineLoginKey.trim() : undefined,
                    docsUrl: draft.auth.docsUrl?.trim() ? draft.auth.docsUrl.trim() : undefined,
                    loginCommand: draft.auth.loginCommand?.command?.trim()
                        ? {
                            command: draft.auth.loginCommand.command.trim(),
                            args: draft.auth.loginCommand.args,
                        }
                        : undefined,
                    statusCommand: draft.auth.statusCommand?.length ? draft.auth.statusCommand : undefined,
                    parser: draft.auth.parser,
                }
                : undefined,
        });
        if (!parsed.success) {
            Modal.alert(t('common.error'), t('settings.acpCatalogValidationFailed'));
            return;
        }
        try {
            setSettings(upsertAcpBackendDefinitionV1(settings, parsed.data));
            router.back();
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        }
    }, [draft, router, setSettings, settings]);

    const handleDelete = React.useCallback(async () => {
        if (!existing) {
            router.back();
            return;
        }
        const confirmed = await Modal.confirm(
            t('settings.acpCatalogDeleteBackendTitle'),
            t('settings.acpCatalogDeleteBackendConfirm', { name: existing.title || existing.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;
        setSettings({
            ...settings,
            backends: settings.backends.filter((entry) => entry.id !== existing.id),
        });
        router.back();
    }, [existing, router, setSettings, settings]);

    return (
        <>
            <ItemList keyboardShouldPersistTaps="handled">
                <ItemGroup title={t('settings.acpCatalogBasics')}>
                    <View style={styles.sectionContent}>
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogFieldId')}</Text>
                        <TextInput testID="settings.acpCatalog.backendEditor.id" style={styles.textInput} value={draft.id} autoCapitalize="none" autoCorrect={false} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, id: text }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogFieldName')}</Text>
                        <TextInput testID="settings.acpCatalog.backendEditor.name" style={styles.textInput} value={draft.name} autoCapitalize="none" autoCorrect={false} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, name: text }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogFieldTitle')}</Text>
                        <TextInput testID="settings.acpCatalog.backendEditor.title" style={styles.textInput} value={draft.title} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, title: text }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogFieldDescription')}</Text>
                        <TextInput testID="settings.acpCatalog.backendEditor.description" style={styles.textInput} value={draft.description ?? ''} multiline onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, description: text || undefined }))} />
                    </View>
                </ItemGroup>

                <ItemGroup title={t('settings.acpCatalogLauncher')}>
                    <View style={styles.sectionContent}>
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogFieldCommand')}</Text>
                        <TextInput testID="settings.acpCatalog.backendEditor.command" style={styles.textInput} value={draft.command} autoCapitalize="none" autoCorrect={false} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, command: text }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogFieldArgs')}</Text>
                        <TextInput testID="settings.acpCatalog.backendEditor.args" style={styles.textInput} value={stringifyMultilineField(draft.args)} multiline onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, args: parseMultilineField(text) }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogDefaultMode')}</Text>
                        <TextInput testID="settings.acpCatalog.backendEditor.defaultMode" style={styles.textInput} value={draft.defaultMode ?? ''} autoCapitalize="none" autoCorrect={false} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, defaultMode: text || undefined }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogDefaultModel')}</Text>
                        <TextInput testID="settings.acpCatalog.backendEditor.defaultModel" style={styles.textInput} value={draft.defaultModel ?? ''} autoCapitalize="none" autoCorrect={false} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, defaultModel: text || undefined }))} />
                    </View>
                </ItemGroup>

                <McpValueRefMapEditor
                    kind="env"
                    title={t('settings.acpCatalogEnv')}
                    iconName="flask-outline"
                    entries={draft.env}
                    secrets={Array.isArray(secrets) ? secrets : []}
                    onChangeSecrets={setSecrets as (next: any[]) => void}
                    onChangeEntries={(next) => updateDraft((current) => withUpdatedAt({ ...current, env: next }))}
                    addRowTitle={t('settings.acpCatalogAddEnv')}
                    addRowSubtitle={t('settings.acpCatalogAddEnvSubtitle')}
                    emptyTitle={t('settings.acpCatalogEnvEmptyTitle')}
                    emptySubtitle={t('settings.acpCatalogEnvEmptySubtitle')}
                    testIdPrefix="settings.acpCatalog.backend.env"
                />

                <ItemGroup title={t('settings.acpCatalogAuth')}>
                    <DropdownMenu
                        open={authSupportMenuOpen}
                        onOpenChange={setAuthSupportMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={draft.auth?.support ?? 'unsupported'}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{ title: t('settings.acpCatalogAuthSupport'), subtitle: draft.auth?.support ?? 'unsupported', icon: <Ionicons name="key-outline" size={29} color={theme.colors.accent.indigo} /> }}
                        items={authSupportOptions}
                        onSelect={(id) => updateDraft((current) => withUpdatedAt({ ...current, auth: { ...(current.auth ?? { support: 'unsupported' }), support: id as AcpCatalogAuthSupportV1 } }))}
                    />
                    <View style={styles.sectionContent}>
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogMachineLoginKey')}</Text>
                        <TextInput style={styles.textInput} value={draft.auth?.machineLoginKey ?? ''} autoCapitalize="none" autoCorrect={false} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, auth: { ...(current.auth ?? { support: 'unsupported' }), machineLoginKey: text || undefined } }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogDocsUrl')}</Text>
                        <TextInput style={styles.textInput} value={draft.auth?.docsUrl ?? ''} autoCapitalize="none" autoCorrect={false} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, auth: { ...(current.auth ?? { support: 'unsupported' }), docsUrl: text || undefined } }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogLoginCommand')}</Text>
                        <TextInput style={styles.textInput} value={draft.auth?.loginCommand?.command ?? ''} autoCapitalize="none" autoCorrect={false} onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, auth: { ...(current.auth ?? { support: 'unsupported' }), loginCommand: { command: text, args: current.auth?.loginCommand?.args ?? [] } } }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogLoginArgs')}</Text>
                        <TextInput style={styles.textInput} value={stringifyMultilineField(draft.auth?.loginCommand?.args)} multiline onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, auth: { ...(current.auth ?? { support: 'unsupported' }), loginCommand: { command: current.auth?.loginCommand?.command ?? '', args: parseMultilineField(text) } } }))} />
                        <Text style={styles.fieldLabel}>{t('settings.acpCatalogStatusCommand')}</Text>
                        <TextInput style={styles.textInput} value={stringifyMultilineField(draft.auth?.statusCommand)} multiline onChangeText={(text) => updateDraft((current) => withUpdatedAt({ ...current, auth: { ...(current.auth ?? { support: 'unsupported' }), statusCommand: parseMultilineField(text) } }))} />
                    </View>
                    <DropdownMenu
                        open={authParserMenuOpen}
                        onOpenChange={setAuthParserMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={draft.auth?.parser ?? 'unknown'}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{ title: t('settings.acpCatalogAuthParser'), subtitle: draft.auth?.parser ?? 'unknown', icon: <Ionicons name="analytics-outline" size={29} color={theme.colors.accent.orange} /> }}
                        items={authParserOptions}
                        onSelect={(id) => updateDraft((current) => withUpdatedAt({ ...current, auth: { ...(current.auth ?? { support: 'unsupported' }), parser: id as AcpCatalogAuthParserV1 } }))}
                    />
                </ItemGroup>

                <ItemGroup title={t('settings.acpCatalogCapabilities')}>
                    <DropdownMenu
                        open={supportsModesMenuOpen}
                        onOpenChange={setSupportsModesMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={draft.capabilities.supportsModes}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{ title: t('settings.acpCatalogSupportsModes'), subtitle: draft.capabilities.supportsModes, icon: <Ionicons name="list-outline" size={29} color={theme.colors.accent.blue} /> }}
                        items={supportHintOptions}
                        onSelect={(id) => updateDraft((current) => withUpdatedAt({ ...current, capabilities: { ...current.capabilities, supportsModes: id as AcpCatalogSupportHintV1 } }))}
                    />
                    <DropdownMenu
                        open={supportsModelsMenuOpen}
                        onOpenChange={setSupportsModelsMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={draft.capabilities.supportsModels}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{ title: t('settings.acpCatalogSupportsModels'), subtitle: draft.capabilities.supportsModels, icon: <Ionicons name="layers-outline" size={29} color={theme.colors.accent.blue} /> }}
                        items={supportHintOptions}
                        onSelect={(id) => updateDraft((current) => withUpdatedAt({ ...current, capabilities: { ...current.capabilities, supportsModels: id as AcpCatalogSupportHintV1 } }))}
                    />
                    <DropdownMenu
                        open={supportsConfigOptionsMenuOpen}
                        onOpenChange={setSupportsConfigOptionsMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={draft.capabilities.supportsConfigOptions}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{ title: t('settings.acpCatalogSupportsConfigOptions'), subtitle: draft.capabilities.supportsConfigOptions, icon: <Ionicons name="options-outline" size={29} color={theme.colors.accent.blue} /> }}
                        items={supportHintOptions}
                        onSelect={(id) => updateDraft((current) => withUpdatedAt({ ...current, capabilities: { ...current.capabilities, supportsConfigOptions: id as AcpCatalogSupportHintV1 } }))}
                    />
                    <DropdownMenu
                        open={promptImageSupportMenuOpen}
                        onOpenChange={setPromptImageSupportMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={draft.capabilities.promptImageSupport}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{ title: t('settings.acpCatalogPromptImageSupport'), subtitle: draft.capabilities.promptImageSupport, icon: <Ionicons name="image-outline" size={29} color={theme.colors.accent.blue} /> }}
                        items={supportHintOptions}
                        onSelect={(id) => updateDraft((current) => withUpdatedAt({ ...current, capabilities: { ...current.capabilities, promptImageSupport: id as AcpCatalogSupportHintV1 } }))}
                    />
                </ItemGroup>
            </ItemList>
            <SettingsActionFooter
                primaryLabel={t('common.save')}
                onPrimaryPress={handleSave}
                primaryTestID="settings.acpCatalog.backendEditor.save"
                secondaryLabel={existing ? t('common.delete') : t('common.cancel')}
                onSecondaryPress={() => { void handleDelete(); }}
                secondaryTestID="settings.acpCatalog.backendEditor.secondary"
                secondaryTone={existing ? 'destructive' : 'default'}
            />
        </>
    );
});
