import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ModelVisibilityRefV1, ProviderErrorV1 } from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { TextInput } from '@/components/ui/text/Text';
import {
    ProviderModelManager,
    type ProviderModelManagerGroup,
} from '@/providers/models/ProviderModelManager';
import { t } from '@/text';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { ProviderManualModelsField } from '../ProviderManualModelsField';
import { ProviderFeatureAvailabilityNotice, type ProviderAvailabilityPresentation } from '../ProviderFeatureAvailability';

const styles = StyleSheet.create(() => ({ root: { flex: 1 } }));

export type ProviderConnectionModelsViewProps = Readonly<{
    availabilityPresentation: ProviderAvailabilityPresentation | null;
    machineAvailable: boolean;
    connectionId: string;
    groups: readonly ProviderModelManagerGroup[];
    initialLoading: boolean;
    modelCount: number;
    error: ProviderErrorV1 | null;
    errorRetry?: () => Promise<void>;
    errorLoadModel?: () => Promise<void>;
    errorReviewCurrentState?: () => Promise<void>;
    manualModelPolicy: 'allowed' | 'catalog-only' | null;
    editorOpen: boolean;
    editorError: string | null;
    manualModelText: string;
    savingManualModels: boolean;
    manualModelsRef: React.RefObject<React.ElementRef<typeof TextInput> | null>;
    showHidden: boolean;
    canRefreshCatalog: boolean;
    refreshingCatalog: boolean;
    loadingModelKey: string | null;
    loadCancelledProviderMayContinue: boolean;
    onEditorOpenChange: (open: boolean) => void;
    onManualModelTextChange: (text: string) => void;
    onAddManualModels: () => void;
    onToggleShowHidden: () => void;
    onRefreshCatalog: () => void;
    onSetVisibility: (ref: ModelVisibilityRefV1, hidden: boolean) => void;
    onShowAll: () => void;
    onHideAll: () => void;
    onResetVisibility: () => void;
    onShowOnly: (ref: ModelVisibilityRefV1) => void;
    onLoadModel: (connectionId: string, modelId: string) => void;
    onCancelModelLoad: () => void;
    onRemoveManualModel: (connectionId: string, modelId: string) => void;
    onRequestClose: () => void;
}>;

export function ProviderConnectionModelsView(props: ProviderConnectionModelsViewProps): React.ReactElement {
    if (props.availabilityPresentation) {
        return <View style={styles.root}><ItemGroup><ProviderFeatureAvailabilityNotice presentation={props.availabilityPresentation} /></ItemGroup></View>;
    }
    if (!props.machineAvailable) {
        return <View style={styles.root}><ItemGroup><Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} /></ItemGroup></View>;
    }
    if (props.initialLoading && props.modelCount === 0) {
        return <View style={styles.root}><ItemGroup><Item mode="info" loading title={t('common.loading')} /></ItemGroup></View>;
    }
    if (props.error && props.modelCount === 0) {
        return <View style={styles.root}><ItemGroup><ProviderErrorItems error={props.error} retry={props.errorRetry} loadModel={props.errorLoadModel} reviewCurrentState={props.errorReviewCurrentState} /></ItemGroup></View>;
    }

    const headerActions = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {props.canRefreshCatalog ? <IconButton
                testID="provider-model-catalog-refresh"
                iconName="refresh-outline"
                accessibilityLabel={t('common.refresh')}
                tooltip={t('common.refresh')}
                size={44}
                variant="plain"
                disabled={props.refreshingCatalog}
                onPress={props.onRefreshCatalog}
            /> : null}
            <IconButton
                testID="provider-model-show-hidden"
                iconName={props.showHidden ? 'eye-off-outline' : 'eye-outline'}
                accessibilityLabel={props.showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                tooltip={props.showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                size={44}
                variant="plain"
                onPress={props.onToggleShowHidden}
            />
        </View>
    );

    return (
        <View style={styles.root}>
            {props.error ? <ItemGroup><ProviderErrorItems error={props.error} retry={props.errorRetry} loadModel={props.errorLoadModel} reviewCurrentState={props.errorReviewCurrentState} /></ItemGroup> : null}
            {props.loadCancelledProviderMayContinue ? (
                <ItemGroup>
                    <Item
                        mode="info"
                        title={t('settingsProviders.models.loadCancelled')}
                        subtitle={t('settingsProviders.models.loadCancelledProviderMayContinue')}
                    />
                </ItemGroup>
            ) : null}
            {props.manualModelPolicy === 'allowed' ? (
                <ItemGroup>
                    <InlineAddExpander
                        triggerTestID="provider-model-add"
                        isOpen={props.editorOpen}
                        onOpenChange={props.onEditorOpenChange}
                        title={t('settingsProviders.models.add')}
                        subtitle={t('settingsProviders.models.addDescription')}
                        helpText={props.editorError ?? t('settingsProviders.models.addHelp')}
                        onCancel={() => props.onEditorOpenChange(false)}
                        onSave={props.onAddManualModels}
                        saveDisabled={props.savingManualModels || !props.manualModelText.trim()}
                        cancelLabel={t('common.cancel')}
                        saveLabel={t('settingsProviders.models.add')}
                        autoFocusRef={props.manualModelsRef}
                    >
                        <ProviderManualModelsField
                            ref={props.manualModelsRef}
                            value={props.manualModelText}
                            editable={!props.savingManualModels}
                            errorText={props.editorError}
                            onChangeText={props.onManualModelTextChange}
                        />
                    </InlineAddExpander>
                </ItemGroup>
            ) : props.manualModelPolicy === 'catalog-only' ? (
                <ItemGroup><Item mode="info" title={t('settingsProviders.models.providerManagedTitle')} subtitle={t('settingsProviders.models.providerManagedDescription')} /></ItemGroup>
            ) : null}
            <ProviderModelManager
                scope={{ kind: 'connection', connectionId: props.connectionId }}
                nativeModels={[]}
                groups={props.groups}
                showHidden={props.showHidden}
                onSetVisibility={props.onSetVisibility}
                onShowAll={props.onShowAll}
                onHideAll={props.onHideAll}
                onResetVisibility={props.onResetVisibility}
                onShowOnly={props.onShowOnly}
                onLoadModel={props.onLoadModel}
                onCancelModelLoad={props.onCancelModelLoad}
                loadingModelKey={props.loadingModelKey}
                onRemoveManualModel={props.onRemoveManualModel}
                onRequestClose={props.onRequestClose}
                headerActions={headerActions}
                testID="provider-connection-models"
            />
        </View>
    );
}
