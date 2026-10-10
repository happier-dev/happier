import * as React from 'react';
import { Platform, View } from 'react-native';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Item } from '@/components/ui/lists/Item';
import { ProviderModelManager } from '@/providers/models/ProviderModelManager';
import { t } from '@/text';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { ProviderManualModelsField } from '../ProviderManualModelsField';
import type { ProviderConnectionModelsSectionState } from './useProviderConnectionModelsSection';

/**
 * A provider connection's detail page with its Models section: the page's own sections above and
 * below, and between them the filterable model list with a switch per model. The page scrolls as
 * one; only the model rows near the viewport mount.
 */
export function ProviderConnectionModelsPage(props: Readonly<{
    connectionId: string;
    models: ProviderConnectionModelsSectionState;
    header: React.ReactElement;
    footer: React.ReactElement;
    revealOnMount: boolean;
    /** Each new value scrolls the page to the Models section (the Connection section's Models row). */
    revealRequest?: number;
    onRequestClose: () => void;
}>): React.ReactElement {
    const { models } = props;
    const listed = models.modelCount > 0;
    const contentState = !listed && models.initialLoading ? (
        <Item testID="provider-connection-models-loading" mode="info" loading title={t('common.loading')} />
    ) : !listed && models.error ? (
        <ProviderErrorItems
            error={models.error}
            retry={models.errorRetry}
            loadModel={models.errorLoadModel}
            reviewCurrentState={models.errorReviewCurrentState}
        />
    ) : null;
    const leadingRows = (
        <>
            {listed && models.error ? (
                <ProviderErrorItems
                    error={models.error}
                    retry={models.errorRetry}
                    loadModel={models.errorLoadModel}
                    reviewCurrentState={models.errorReviewCurrentState}
                />
            ) : null}
            {models.loadCancelledProviderMayContinue ? (
                <Item
                    mode="info"
                    title={t('settingsProviders.models.loadCancelled')}
                    subtitle={t('settingsProviders.models.loadCancelledProviderMayContinue')}
                />
            ) : null}
            {models.manualModelPolicy === 'allowed' ? (
                <InlineAddExpander
                    triggerTestID="provider-model-add"
                    isOpen={models.editorOpen}
                    onOpenChange={models.onEditorOpenChange}
                    title={t('settingsProviders.models.add')}
                    subtitle={t('settingsProviders.models.addDescription')}
                    helpText={models.editorError ?? t('settingsProviders.models.addHelp')}
                    onCancel={() => models.onEditorOpenChange(false)}
                    onSave={models.onAddManualModels}
                    saveDisabled={models.savingManualModels || !models.manualModelText.trim()}
                    cancelLabel={t('common.cancel')}
                    saveLabel={t('settingsProviders.models.add')}
                    autoFocusRef={models.manualModelsRef}
                >
                    <ProviderManualModelsField
                        ref={models.manualModelsRef}
                        value={models.manualModelText}
                        editable={!models.savingManualModels}
                        errorText={models.editorError}
                        onChangeText={models.onManualModelTextChange}
                    />
                </InlineAddExpander>
            ) : models.manualModelPolicy === 'catalog-only' ? (
                <Item
                    mode="info"
                    title={t('settingsProviders.models.providerManagedTitle')}
                    subtitle={t('settingsProviders.models.providerManagedDescription')}
                />
            ) : null}
        </>
    );
    const listActions = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {models.canRefreshCatalog ? (
                <IconButton
                    testID="provider-model-catalog-refresh"
                    iconName="arrow-clockwise"
                    accessibilityLabel={t('common.refresh')}
                    tooltip={t('common.refresh')}
                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                    interactiveTargetGapPx={4}
                    variant="plain"
                    disabled={models.refreshingCatalog}
                    onPress={models.onRefreshCatalog}
                />
            ) : null}
            <IconButton
                testID="provider-model-show-hidden"
                iconName={models.showHidden ? 'eye-slash' : 'eye'}
                accessibilityLabel={models.showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                tooltip={models.showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                interactiveTargetGapPx={4}
                variant="plain"
                onPress={models.onToggleShowHidden}
            />
        </View>
    );

    return (
        <ProviderModelManager
            scope={{ kind: 'connection', connectionId: props.connectionId }}
            nativeModels={[]}
            groups={models.groups}
            showHidden={models.showHidden}
            onSetVisibility={models.onSetVisibility}
            onShowAll={models.onShowAll}
            onHideAll={models.onHideAll}
            onResetVisibility={models.onResetVisibility}
            onShowOnly={models.onShowOnly}
            onLoadModel={models.onLoadModel}
            onCancelModelLoad={models.onCancelModelLoad}
            loadingModelKey={models.loadingModelKey}
            onRemoveManualModel={models.onRemoveManualModel}
            onRequestClose={props.onRequestClose}
            headerActions={listActions}
            testID="provider-connection-models"
            page={{
                header: props.header,
                footer: props.footer,
                title: t('settingsProviders.detail.modelsTitle'),
                description: t('settingsProvidersCollection.modelsDescription'),
                leadingRows,
                contentState,
                summary: listed
                    ? t('settingsProvidersCollection.modelsShown', { shown: models.shownModelCount, total: models.modelCount })
                    : null,
                revealOnMount: props.revealOnMount,
                revealRequest: props.revealRequest,
                testID: 'provider-connection-detail',
            }}
        />
    );
}
