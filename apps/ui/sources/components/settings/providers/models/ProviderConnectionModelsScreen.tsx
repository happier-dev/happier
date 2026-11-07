import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useIsFocused, useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { presentProviderConnection } from '@/providers/connection/presentation';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { resolveProviderConnectionIcon } from '@/components/settings/providers/collection/providerCollectionModel';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { t } from '@/text';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { ProviderFeatureAvailabilityNotice, useProviderFeatureAvailability } from '../ProviderFeatureAvailability';
import { ProviderConnectionModelsPage } from './ProviderConnectionModelsSection';
import { useProviderConnectionModelsSection } from './useProviderConnectionModelsSection';

/**
 * A provider connection's Models page, opened from the "Models" row of its detail (lab PD1): the
 * filterable model list with a switch per model, manual additions and catalog refresh. The detail
 * keeps only the row with its count, so the page is not two lists of the same models.
 */
export const ProviderConnectionModelsScreen = React.memo(function ProviderConnectionModelsScreen(props: Readonly<{
    connectionId: string;
    /** Open with the manual-model editor open. */
    startAdding?: boolean;
    /** Open with this model's generation settings editor open (the editor's AI suggestions link here). */
    startEditingGenerationOf?: string;
}>) {
    const router = useRouter();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    const focused = useIsFocused();
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const { machineId, resolveCurrentTarget, serverId } = useProviderSettingsTarget();
    const query = useProviderConnections({ enabled, active: focused, machineId, serverId, connectionId: props.connectionId });
    const connection = query.data?.connections.find((item) => item.connectionId === props.connectionId) ?? null;
    const models = useProviderConnectionModelsSection({
        declarationContext: query.declarationContext,
        connectionId: props.connectionId,
        connection,
        enabled,
        active: focused && connection !== null,
        machineId,
        serverId,
        resolveCurrentTarget,
        startAdding: props.startAdding,
        startEditingGenerationOf: props.startEditingGenerationOf,
    });

    // A typed manual-model draft is unsaved work: leaving asks first, as on every other editor.
    const { dirtyRef, discard, save, accountStillCurrent } = models.manualDraft;
    const requestDecision = React.useCallback(async () => {
        const decision = await promptUnsavedChangesAlert(
            (title, message, buttons) => {
                if (accountStillCurrent()) Modal.alert(title, message, buttons);
            },
            {
                title: t('common.discardChanges'),
                message: t('common.unsavedChangesWarning'),
                discardText: t('common.discard'),
                saveText: t('common.save'),
                keepEditingText: t('common.keepEditing'),
            },
        );
        return accountStillCurrent() ? decision : 'keepEditing' as const;
    }, [accountStillCurrent]);
    const continueNavigation = React.useCallback((action: unknown) => {
        if (action) (navigation as { dispatch?: (value: unknown) => void } | null)?.dispatch?.(action);
    }, [navigation]);
    useUnsavedChangesBeforeRemoveGuard({
        isDirty: dirtyRef.current,
        isDirtyRef: dirtyRef,
        requestDecision,
        onDiscard: discard,
        onSave: save,
        continueOnSave: true,
        onContinue: continueNavigation,
        tag: 'ProviderConnectionModelsScreen.beforeRemove',
    });

    if (availabilityPresentation) {
        return (
            <ItemList>
                <ItemGroup><ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} /></ItemGroup>
            </ItemList>
        );
    }
    if (!connection) {
        return (
            <ItemList testID="provider-connection-models-loading">
                <ItemGroup>
                    <Item mode="info" loading={!query.data && !query.error}
                        title={!query.data && !query.error ? t('common.loading') : t('settingsProviders.detail.notFoundTitle')} />
                </ItemGroup>
            </ItemList>
        );
    }

    const header = (
        <PageHeader
            testID="provider-connection-models-header"
            alwaysShowTitle
            title={t('settingsProviders.detail.modelsTitle')}
            description={t('settingsProvidersCollection.modelsDescription')}
            leading={(
                <PageHeaderMarkSlot>
                    <ProviderIcon contributionKey={connection.contributionKey} icon={resolveProviderConnectionIcon(connection, query.declarationContext)} size={24} color={theme.colors.text.secondary} />
                </PageHeaderMarkSlot>
            )}
            meta={[{ key: 'provider', text: presentProviderConnection(connection).title }]}
        />
    );
    return (
        <ProviderConnectionModelsPage
            connectionId={props.connectionId}
            models={models}
            header={header}
            footer={<></>}
            onRequestClose={() => router.back()}
        />
    );
});
