import * as React from 'react';
import { View, type TextInput } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ProviderErrorV1 } from '@happier-dev/protocol';

import { CustomProviderAdvancedFields } from '@/components/settings/providers/CustomProviderAdvancedFields';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ProviderManualModelsField } from '@/components/settings/providers/ProviderManualModelsField';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { Switch } from '@/components/ui/forms/Switch';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { CustomProviderDraft } from '@/providers/authoring/state';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { Icon } from '@/components/ui/icons/Icon';

const styles = StyleSheet.create(() => ({
    fields: { gap: 16, paddingHorizontal: 16, paddingVertical: 14 },
}));

export type CustomProviderAuthoringViewModel = Readonly<{
    targetSelection: MachineAdministrationTargetSelectionV1;
    machineId: string;
    currentMachineName: string;
    draft: CustomProviderDraft;
    presets: readonly DropdownMenuItem[];
    presetOpen: boolean;
    credentialStyles: readonly DropdownMenuItem[];
    credentialOpen: boolean;
    invalidField: 'name' | 'baseUrl' | null;
    localEndpoint: string | null;
    enableAfterSaving: boolean;
    draftRequiresApiKey: boolean;
    secretSelected: boolean;
    savedSecretSelectionEnabled: boolean;
    manualModelsError: string | null;
    draftHasProbe: boolean;
    probeState: 'idle' | 'probing' | 'success' | 'notSupported';
    savePending: boolean;
    error: ProviderErrorV1 | string | null;
    errorRetry?: () => void | Promise<void>;
    probeError: ProviderErrorV1 | null;
    secondaryTextColor: string;
    nameFieldRef: React.RefObject<TextInput | null>;
    baseUrlFieldRef: React.RefObject<TextInput | null>;
    manualModelsFieldRef: React.RefObject<TextInput | null>;
}>;

export type CustomProviderAuthoringViewActions = Readonly<{
    onPresetOpenChange: (open: boolean) => void;
    onCredentialOpenChange: (open: boolean) => void;
    onPresetSelect: (preset: string) => void;
    onCredentialStyleSelect: (style: string) => void;
    onDraftChange: React.Dispatch<React.SetStateAction<CustomProviderDraft>>;
    onNameChange: (name: string) => void;
    onBaseUrlChange: (baseUrl: string) => void;
    onManualModelsChange: (text: string) => void;
    onEnableAfterSavingChange: (enabled: boolean) => void;
    onPickSecret: () => void;
    onReviewConnection: () => void;
    onTest: () => void;
    onSave: () => void;
}>;

export function CustomProviderAuthoringView(props: Readonly<{
    model: CustomProviderAuthoringViewModel;
    actions: CustomProviderAuthoringViewActions;
}>): React.ReactElement {
    const { model, actions } = props;
    const { draft } = model;
    return (
        <ItemList testID="settings-provider-authoring" style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            <MachineAdministrationTargetSelector
                selection={model.targetSelection}
                testIDPrefix="settings.providers.administration.target"
            />
            <ItemGroup title={t('settingsProviders.authoring.compatibilityTitle')} footer={t('settingsProviders.authoring.compatibilityFooter')}>
                <Item
                    title={t('settingsProviders.authoring.advancedSetup')}
                    subtitle={draft.advanced ? t('settingsProviders.authoring.advancedSetupEnabled') : t('settingsProviders.authoring.advancedSetupDisabled')}
                    rightElement={<Switch accessibilityLabel={t('settingsProviders.authoring.advancedSetup')} value={draft.advanced} onValueChange={(advanced) => actions.onDraftChange((current) => ({ ...current, advanced }))} />}
                    rightElementOutsidePressable
                />
                {!draft.advanced ? <DropdownMenu
                    open={model.presetOpen}
                    onOpenChange={actions.onPresetOpenChange}
                    variant="selectable"
                    search={false}
                    selectedId={draft.protocol}
                    showCategoryTitles={false}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsProviders.authoring.protocolTitle'),
                        subtitle: model.presets.find((item) => item.id === draft.protocol)?.title,
                        icon: <Icon name="graph" size={29} color={model.secondaryTextColor} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                    }}
                    items={model.presets}
                    onSelect={actions.onPresetSelect}
                /> : null}
            </ItemGroup>

            <ItemGroup title={t('settingsProviders.authoring.detailsTitle')}>
                <View style={styles.fields}>
                    <MachineSetupTextField
                        ref={model.nameFieldRef}
                        testID="settings-provider-authoring-name"
                        label={t('settingsProviders.authoring.name')}
                        value={draft.name}
                        placeholder={t('settingsProviders.authoring.namePlaceholder')}
                        autoCapitalize="words"
                        errorText={model.invalidField === 'name' ? t('settingsProviders.errors.connectionInvalidDescription') : undefined}
                        onChangeText={actions.onNameChange}
                    />
                    {!draft.advanced ? <MachineSetupTextField
                        ref={model.baseUrlFieldRef}
                        testID="settings-provider-authoring-base-url"
                        label={t('settingsProviders.authoring.baseUrl')}
                        value={draft.baseUrl}
                        placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        errorText={model.invalidField === 'baseUrl' ? t('settingsProviders.errors.connectionInvalidDescription') : undefined}
                        onChangeText={actions.onBaseUrlChange}
                    /> : null}
                    {!draft.advanced && draft.catalog === 'probe' ? <MachineSetupTextField
                        label={t('settingsProviders.authoring.modelsPath')}
                        value={draft.modelsPath}
                        placeholder={t('settingsProviders.authoring.modelsPathPlaceholder')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onChangeText={(modelsPath) => actions.onDraftChange((current) => ({ ...current, modelsPath }))}
                    /> : null}
                </View>
            </ItemGroup>
            {draft.advanced ? <CustomProviderAdvancedFields draft={draft} baseUrlFieldRef={model.baseUrlFieldRef} onChange={actions.onDraftChange} /> : null}

            <ItemGroup title={t('settingsProviders.authoring.enableAfterSaving')}>
                {model.localEndpoint ? <Item
                    mode="info"
                    title={t('settingsProviders.authoring.localAddressTitle')}
                    subtitle={t('settingsProviders.authoring.localAddressDescription', { machine: model.currentMachineName, endpoint: model.localEndpoint })}
                    icon={<Icon name="desktop" size={29} color={model.secondaryTextColor} />}
                /> : null}
                <Item
                    title={t('settingsProviders.authoring.enableAfterSaving')}
                    subtitle={model.localEndpoint ? t('settingsProviders.authoring.enableOnCurrentMachine') : t('settingsProviders.authoring.enableAccountWide')}
                    rightElement={<Switch testID="settings-provider-authoring-enable-after-save" accessibilityLabel={t('settingsProviders.authoring.enableAfterSaving')} value={model.enableAfterSaving} onValueChange={actions.onEnableAfterSavingChange} />}
                    rightElementOutsidePressable
                />
            </ItemGroup>

            {!draft.advanced ? <ItemGroup title={t('settingsProviders.authoring.credentialsTitle')} footer={t('settingsProviders.authoring.credentialsFooter')}>
                <Item
                    title={t('settingsProviders.authoring.requiresApiKey')}
                    subtitle={draft.requiresApiKey ? t('settingsProviders.authoring.requiresApiKeyYes') : t('settingsProviders.authoring.requiresApiKeyNo')}
                    rightElement={<Switch testID="settings-provider-authoring-requires-api-key" accessibilityLabel={t('settingsProviders.authoring.requiresApiKey')} value={draft.requiresApiKey} onValueChange={(requiresApiKey) => actions.onDraftChange((current) => ({ ...current, requiresApiKey }))} />}
                    rightElementOutsidePressable
                />
                {draft.requiresApiKey ? <>
                    <DropdownMenu
                        open={model.credentialOpen}
                        onOpenChange={actions.onCredentialOpenChange}
                        variant="selectable"
                        search={false}
                        selectedId={draft.credentialStyle}
                        showCategoryTitles={false}
                        rowKind="item"
                        itemTrigger={{
                            title: t('settingsProviders.authoring.credentialStyleTitle'),
                            subtitle: model.credentialStyles.find((item) => item.id === draft.credentialStyle)?.title,
                            showSelectedDetail: false,
                            showSelectedSubtitle: false,
                        }}
                        items={model.credentialStyles}
                        onSelect={actions.onCredentialStyleSelect}
                    />
                    {draft.credentialStyle === 'custom-header' || draft.credentialStyle === 'custom-header-bearer' ? <View style={styles.fields}>
                        <MachineSetupTextField
                            label={t('settingsProviders.authoring.credentialHeader')}
                            value={draft.credentialHeader}
                            placeholder={t('settingsProviders.authoring.credentialHeaderPlaceholder')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={(credentialHeader) => actions.onDraftChange((current) => ({ ...current, credentialHeader }))}
                        />
                    </View> : null}
                    <Item
                        title={t('settingsProviders.authoring.apiKey')}
                        subtitle={model.secretSelected
                            ? t('settingsProviders.detail.apiKeySelected')
                            : model.savedSecretSelectionEnabled
                                ? t('settingsProviders.authoring.apiKeyDescription')
                                : t('settingsProviders.local.accountScopeMismatchDescription')}
                        icon={<Icon name="key" size={29} color={model.secondaryTextColor} />}
                        disabled={!model.savedSecretSelectionEnabled}
                        onPress={model.savedSecretSelectionEnabled ? actions.onPickSecret : undefined}
                    />
                </> : null}
            </ItemGroup> : model.draftRequiresApiKey ? <ItemGroup title={t('settingsProviders.authoring.credentialsTitle')} footer={t('settingsProviders.authoring.credentialsFooter')}>
                <Item
                    title={t('settingsProviders.authoring.apiKey')}
                    subtitle={model.secretSelected
                        ? t('settingsProviders.detail.apiKeySelected')
                        : model.savedSecretSelectionEnabled
                            ? t('settingsProviders.authoring.apiKeyDescription')
                            : t('settingsProviders.local.accountScopeMismatchDescription')}
                    icon={<Icon name="key" size={29} color={model.secondaryTextColor} />}
                    disabled={!model.savedSecretSelectionEnabled}
                    onPress={model.savedSecretSelectionEnabled ? actions.onPickSecret : undefined}
                />
            </ItemGroup> : null}

            {!draft.advanced && draft.protocol !== 'anthropic' ? <ItemGroup title={t('settingsProviders.authoring.catalogTitle')} footer={t('settingsProviders.authoring.catalogFooter')}>
                <Item
                    title={t('settingsProviders.authoring.fetchModels')}
                    subtitle={draft.catalog === 'probe' ? t('settingsProviders.authoring.fetchModelsYes') : t('settingsProviders.authoring.fetchModelsNo')}
                    rightElement={<Switch accessibilityLabel={t('settingsProviders.authoring.fetchModels')} value={draft.catalog === 'probe'} onValueChange={(enabled) => actions.onDraftChange((current) => ({
                        ...current,
                        catalog: enabled ? 'probe' : 'manual',
                        modelsPath: enabled && !current.modelsPath ? '/v1/models' : current.modelsPath,
                    }))} />}
                    rightElementOutsidePressable
                />
            </ItemGroup> : null}

            <ItemGroup title={t('settingsProviders.models.add')} footer={t('settingsProviders.models.addHelp')}>
                <View style={styles.fields}>
                    <ProviderManualModelsField
                        ref={model.manualModelsFieldRef}
                        value={draft.manualModelsText}
                        errorText={model.manualModelsError}
                        onChangeText={actions.onManualModelsChange}
                    />
                </View>
            </ItemGroup>

            <ItemGroup title={t('settingsProviders.authoring.verifyTitle')} footer={t('settingsProviders.authoring.verifyFooter')}>
                {model.draftHasProbe ? <Item
                    title={t('settingsProviders.detail.testConnection')}
                    subtitle={model.probeState === 'success'
                        ? t('settingsProviders.detail.testSucceeded')
                        : model.probeState === 'notSupported'
                            ? t('settingsProviders.detail.testNotSupported')
                            : t('settingsProviders.detail.testDescription')}
                    loading={model.probeState === 'probing'}
                    disabled={model.draftRequiresApiKey && !model.savedSecretSelectionEnabled}
                    onPress={model.draftRequiresApiKey && !model.savedSecretSelectionEnabled
                        ? undefined
                        : actions.onTest}
                /> : <Item mode="info" title={t('settingsProviders.detail.testNotSupported')} subtitle={t('settingsProviders.detail.testOnFirstSession')} />}
                <Item
                    testID="settings-provider-authoring-save"
                    title={t('settingsProviders.authoring.save')}
                    loading={model.savePending}
                    disabled={model.draftRequiresApiKey && !model.savedSecretSelectionEnabled}
                    onPress={model.draftRequiresApiKey && !model.savedSecretSelectionEnabled
                        ? undefined
                        : actions.onSave}
                />
            </ItemGroup>

            {model.error ? <ItemGroup><ProviderErrorItems error={model.error} retry={model.errorRetry} reviewConnection={actions.onReviewConnection} configureSecret={model.savedSecretSelectionEnabled ? actions.onPickSecret : undefined} /></ItemGroup> : null}
            {model.probeError ? <ItemGroup><ProviderErrorItems error={model.probeError} retry={async () => { actions.onTest(); }} reviewConnection={actions.onReviewConnection} configureSecret={model.savedSecretSelectionEnabled ? actions.onPickSecret : undefined} /></ItemGroup> : null}
        </ItemList>
    );
}
