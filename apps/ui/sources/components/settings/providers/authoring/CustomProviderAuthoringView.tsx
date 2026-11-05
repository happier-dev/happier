import * as React from 'react';
import type { TextInput } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ProviderErrorV1 } from '@happier-dev/protocol';

import { CustomProviderAdvancedFields } from '@/components/settings/providers/CustomProviderAdvancedFields';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { updateCustomProviderDraftAdvanced, type CustomProviderDraft } from '@/providers/authoring/state';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { t } from '@/text';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { ProviderFieldRow } from './ProviderFieldRow';
import { ProviderKeyEntryItem } from './ProviderKeyEntryItem';
import { ProviderProbeResult } from '../ProviderPageParts';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';

export type CustomProviderAuthoringViewModel = Readonly<{
    machineId: string | null;
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
    selectedSecretName?: string | null;
    savedSecretSelectionEnabled: boolean;
    manualModelsError: string | null;
    draftHasProbe: boolean;
    /**
     * Editing a saved custom connection (F08) rather than adding one: the same fields, while its key,
     * models, on/off switch and test stay on the provider's own page.
     */
    editing?: boolean;
    probeState: 'idle' | 'probing' | 'success' | 'notSupported';
    savePending: boolean;
    /** Save is waiting for its approval: say so and offer the approval, instead of a spinner. */
    pendingApproval?: Readonly<{ onOpen: () => void }> | null;
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
    onPickSecret: (event?: unknown) => void;
    onReviewConnection: () => void;
    onTest: () => void;
    onSave: () => void;
    onDiscard: () => void;
}>;

/**
 * A custom provider being added in the Providers collection: your own OpenAI- or Anthropic-compatible
 * endpoint. The page is the draft's editor; saving turns it into a connection.
 */
export function CustomProviderAuthoringView(props: Readonly<{
    /** The managed machine the provider is added on (its chip). */
    contextBar?: React.ReactNode;
    model: CustomProviderAuthoringViewModel;
    actions: CustomProviderAuthoringViewActions;
}>): React.ReactElement {
    const { model, actions } = props;
    const { draft } = model;
    const { theme } = useUnistyles();
    const saveBlocked = model.draftRequiresApiKey && !model.savedSecretSelectionEnabled;
    // A failed test shows once, with its recovery, in the problem section below the header.
    const probeResult = model.probeError || model.editing
        ? null
        : model.probeState === 'success'
            ? t('settingsProviders.detail.testSucceeded')
            : model.probeState === 'notSupported'
                ? t('settingsProviders.detail.testNotSupported')
                : !model.draftHasProbe
                    ? t('settingsProviders.detail.testOnFirstSession')
                    : null;
    return (
        <ItemList testID="settings-provider-authoring" keyboardShouldPersistTaps="handled">
            {props.contextBar}
            <PageHeader
                testID="settings-provider-authoring-header"
                alwaysShowTitle
                title={draft.name.trim() || t('settingsProvidersCollection.newTitle')}
                description={model.editing ? t('settingsProvidersCollection.editDescription') : t('settingsProviders.customFooter')}
                leading={(
                    <PageHeaderMarkSlot>
                        <ProviderIcon icon={null} size={24} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
                details={probeResult ? (
                    <ProviderProbeResult testID="settings-provider-authoring-probe-result" text={probeResult} failed={false} />
                ) : undefined}
                primaryAction={{
                    testID: 'settings-provider-authoring-save',
                    title: t('common.save'),
                    loading: model.savePending && !model.pendingApproval,
                    disabled: saveBlocked || Boolean(model.pendingApproval),
                    onPress: actions.onSave,
                }}
                cancelAction={{
                    testID: 'settings-provider-authoring-cancel',
                    title: t('common.cancel'),
                    disabled: model.savePending,
                    onPress: actions.onDiscard,
                }}
                actions={model.draftHasProbe && !model.editing ? (
                    <RoundButton
                        testID="settings-provider-authoring-test"
                        display="secondary"
                        title={t('settingsProvidersCollection.test')}
                        accessibilityLabel={t('settingsProviders.detail.testConnection')}
                        loading={model.probeState === 'probing'}
                        disabled={saveBlocked || model.machineId === null}
                        onPress={actions.onTest}
                    />
                ) : undefined}
            />

            {model.pendingApproval ? (
                <ActionApprovalPendingNotice presentation="banner" testID="settings-provider-authoring-approval"
                    message={t('settingsProvidersCollection.approvalPendingTitle')}
                    description={t('settingsProvidersCollection.approvalPendingDescription', { provider: draft.name.trim() || t('settingsProvidersCollection.newTitle') })}
                    openLabel={t('settingsProvidersCollection.openApproval')}
                    onOpenApproval={model.pendingApproval.onOpen}
                />
            ) : null}

            {model.error ? (
                <ItemGroup>
                    <ProviderErrorItems
                        error={model.error}
                        retry={model.errorRetry}
                        reviewConnection={actions.onReviewConnection}
                        configureSecret={model.savedSecretSelectionEnabled ? actions.onPickSecret : undefined}
                    />
                </ItemGroup>
            ) : null}
            {model.probeError ? (
                <ItemGroup>
                    <ProviderErrorItems
                        error={model.probeError}
                        retry={async () => { actions.onTest(); }}
                        reviewConnection={actions.onReviewConnection}
                        configureSecret={model.savedSecretSelectionEnabled ? actions.onPickSecret : undefined}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup
                title={t('settingsProviders.authoring.detailsTitle')}
                description={t('settingsProviders.authoring.compatibilityFooter')}
            >
                <ProviderFieldRow
                    ref={model.nameFieldRef}
                    testID="settings-provider-authoring-name"
                    title={t('settingsProviders.authoring.name')}
                    value={draft.name}
                    placeholder={t('settingsProviders.authoring.namePlaceholder')}
                    autoCapitalize="words"
                    error={model.invalidField === 'name' ? t('settingsProviders.errors.connectionInvalidDescription') : undefined}
                    onChangeText={actions.onNameChange}
                />
                {!draft.advanced ? (
                    <DropdownMenu
                        testID="settings-provider-authoring-protocol"
                        open={model.presetOpen}
                        onOpenChange={actions.onPresetOpenChange}
                        variant="selectable"
                        search={false}
                        selectedId={draft.protocol}
                        showCategoryTitles={false}
                        rowKind="item"
                        itemTrigger={{
                            title: t('settingsProviders.authoring.protocolTitle'),
                            showSelectedDetail: true,
                            showSelectedSubtitle: false,
                        }}
                        items={model.presets}
                        onSelect={actions.onPresetSelect}
                    />
                ) : null}
                {!draft.advanced ? (
                    <ProviderFieldRow
                        ref={model.baseUrlFieldRef}
                        testID="settings-provider-authoring-base-url"
                        title={t('settingsProviders.authoring.baseUrl')}
                        value={draft.baseUrl}
                        placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                        keyboardType="url"
                        monospace
                        error={model.invalidField === 'baseUrl' ? t('settingsProviders.errors.connectionInvalidDescription') : undefined}
                        onChangeText={actions.onBaseUrlChange}
                    />
                ) : null}
                <Item
                    title={t('settingsProviders.authoring.advancedSetup')}
                    subtitle={draft.advanced ? t('settingsProviders.authoring.advancedSetupEnabled') : t('settingsProviders.authoring.advancedSetupDisabled')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch testID="settings-provider-authoring-advanced" accessibilityLabel={t('settingsProviders.authoring.advancedSetup')} value={draft.advanced} onValueChange={(advanced) => actions.onDraftChange((current) => updateCustomProviderDraftAdvanced(current, advanced))} />}
                    rightElementOutsidePressable
                />
            </ItemGroup>
            {draft.advanced ? <CustomProviderAdvancedFields draft={draft} baseUrlFieldRef={model.baseUrlFieldRef} onChange={actions.onDraftChange} /> : null}

            {!draft.advanced ? (
                <ItemGroup title={t('settingsProviders.authoring.credentialsTitle')} description={t('settingsProviders.authoring.credentialsFooter')}>
                    <Item
                        title={t('settingsProviders.authoring.requiresApiKey')}
                        subtitle={draft.requiresApiKey ? t('settingsProviders.authoring.requiresApiKeyYes') : t('settingsProviders.authoring.requiresApiKeyNo')}
                        showChevron={false}
                        rightElement={<Switch testID="settings-provider-authoring-requires-api-key" accessibilityLabel={t('settingsProviders.authoring.requiresApiKey')} value={draft.requiresApiKey} onValueChange={(requiresApiKey) => actions.onDraftChange((current) => ({ ...current, requiresApiKey }))} />}
                        rightElementOutsidePressable
                    />
                    {draft.requiresApiKey ? <>
                        {!model.editing ? <CustomProviderKeyEntry model={model} actions={actions} /> : null}
                        <DropdownMenu
                            testID="settings-provider-authoring-credential-style"
                            open={model.credentialOpen}
                            onOpenChange={actions.onCredentialOpenChange}
                            variant="selectable"
                            search={false}
                            selectedId={draft.credentialStyle}
                            showCategoryTitles={false}
                            rowKind="item"
                            itemTrigger={{
                                title: t('settingsProviders.authoring.credentialStyleTitle'),
                                showSelectedDetail: true,
                                showSelectedSubtitle: false,
                            }}
                            items={model.credentialStyles}
                            onSelect={actions.onCredentialStyleSelect}
                        />
                        {draft.credentialStyle === 'custom-header' || draft.credentialStyle === 'custom-header-bearer' ? (
                            <ProviderFieldRow
                                testID="settings-provider-authoring-credential-header"
                                title={t('settingsProviders.authoring.credentialHeader')}
                                value={draft.credentialHeader}
                                placeholder={t('settingsProviders.authoring.credentialHeaderPlaceholder')}
                                monospace
                                onChangeText={(credentialHeader) => actions.onDraftChange((current) => ({ ...current, credentialHeader }))}
                            />
                        ) : null}
                    </> : null}
                </ItemGroup>
            ) : model.draftRequiresApiKey && !model.editing ? (
                <ItemGroup title={t('settingsProviders.authoring.credentialsTitle')} description={t('settingsProviders.authoring.credentialsFooter')}>
                    <CustomProviderKeyEntry model={model} actions={actions} />
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('settingsProviders.authoring.catalogTitle')} description={t('settingsProviders.authoring.catalogFooter')}>
                {!draft.advanced && draft.protocol !== 'anthropic' ? (
                    <Item
                        title={t('settingsProviders.authoring.fetchModels')}
                        subtitle={draft.catalog === 'probe' ? t('settingsProviders.authoring.fetchModelsYes') : t('settingsProviders.authoring.fetchModelsNo')}
                        showChevron={false}
                        rightElement={<Switch testID="settings-provider-authoring-fetch-models" accessibilityLabel={t('settingsProviders.authoring.fetchModels')} value={draft.catalog === 'probe'} onValueChange={(enabled) => actions.onDraftChange((current) => ({
                            ...current,
                            catalog: enabled ? 'probe' : 'manual',
                            modelsPath: enabled && !current.modelsPath ? '/v1/models' : current.modelsPath,
                        }))} />}
                        rightElementOutsidePressable
                    />
                ) : null}
                {!draft.advanced && draft.catalog === 'probe' ? (
                    <ProviderFieldRow
                        testID="settings-provider-authoring-models-path"
                        title={t('settingsProviders.authoring.modelsPath')}
                        value={draft.modelsPath}
                        placeholder={t('settingsProviders.authoring.modelsPathPlaceholder')}
                        monospace
                        onChangeText={(modelsPath) => actions.onDraftChange((current) => ({ ...current, modelsPath }))}
                    />
                ) : null}
                {!model.editing ? (
                    <ProviderFieldRow
                        ref={model.manualModelsFieldRef}
                        testID="provider-manual-model-ids"
                        title={t('settingsProviders.models.addFieldLabel')}
                        description={t('settingsProviders.models.addHelp')}
                        value={draft.manualModelsText}
                        placeholder={t('settingsProviders.models.addPlaceholder')}
                        multiline
                        monospace
                        error={model.manualModelsError}
                        onChangeText={actions.onManualModelsChange}
                    />
                ) : null}
            </ItemGroup>

            {!model.editing ? (
                <ItemGroup title={t('settingsProvidersCollection.afterSavingTitle')}>
                    {model.localEndpoint ? (
                        <Item
                            mode="info"
                            title={t('settingsProviders.authoring.localAddressTitle')}
                            subtitle={model.machineId
                                ? t('settingsProviders.authoring.localAddressDescription', { machine: model.currentMachineName, endpoint: model.localEndpoint })
                                : t('settingsProvidersCollection.localNoComputer')}
                            subtitleLines={0}
                        />
                    ) : null}
                    <Item
                        title={t('settingsProviders.authoring.enableAfterSaving')}
                        subtitle={t('settingsProviders.authoring.enableAccountWide')}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={<Switch testID="settings-provider-authoring-enable-after-save" accessibilityLabel={t('settingsProviders.authoring.enableAfterSaving')} value={model.enableAfterSaving} onValueChange={actions.onEnableAfterSavingChange} />}
                        rightElementOutsidePressable
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}

/** The custom endpoint's key, typed where it is asked for, as on a catalog provider (PA1). */
function CustomProviderKeyEntry(props: Readonly<{
    model: CustomProviderAuthoringViewModel;
    actions: CustomProviderAuthoringViewActions;
}>) {
    const { model, actions } = props;
    return (
        <ProviderKeyEntryItem
            description={t('settingsProviders.detail.apiKeyFooter')}
            secretSelected={model.secretSelected}
            selectedSecretName={model.selectedSecretName}
            savedSecretSelectionEnabled={model.savedSecretSelectionEnabled}
            onPickSecret={actions.onPickSecret}
        />
    );
}
