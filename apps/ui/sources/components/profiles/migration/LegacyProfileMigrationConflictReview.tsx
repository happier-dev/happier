import * as React from 'react';
import type {
    LegacyProfileMigrationConflictResolutionV1,
    ProviderErrorV1,
    ProviderSettingsMigrationPendingConflictV1,
} from '@happier-dev/protocol';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { randomUUID } from '@/platform/randomUUID';
import { confirmLegacyProfileMigrationConflict, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import { providerRetryRecoveryForError } from '@/providers/connection/recovery';
import { t } from '@/text';

const conflictTitleKey = (kind: ProviderSettingsMigrationPendingConflictV1['kinds'][number]) => {
    switch (kind) {
        case 'credential_binding': return 'settingsProviders.migration.conflictCredential' as const;
        case 'manual_model': return 'settingsProviders.migration.conflictModels' as const;
        case 'edited_default_connection': return 'settingsProviders.migration.conflictEditedConnection' as const;
    }
};

export const LegacyProfileMigrationConflictReview = React.memo(function LegacyProfileMigrationConflictReview(props: Readonly<{
    profileName: string;
    conflict: ProviderSettingsMigrationPendingConflictV1;
    machineId: string;
    serverId: string | null;
    onConfirmed: (settingsVersion: number) => Promise<void>;
    onClose: () => void;
}>) {
    const newConnectionId = React.useRef(ProviderConnectionIdSchema.parse(`pc_${randomUUID()}`)).current;
    const [displayName, setDisplayName] = React.useState(props.profileName);
    const [pendingDecision, setPendingDecision] = React.useState<'keep_existing' | 'create_named' | null>(null);
    const [modelSelection, setModelSelection] = React.useState<
        ProviderSettingsMigrationPendingConflictV1['modelChoices'][number]['selection'] | null | undefined
    >(undefined);
    const [operationError, setOperationError] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
    }> | null>(null);

    const finishConfirmedMigration = React.useCallback(async (settingsVersion: number): Promise<void> => {
        try {
            await props.onConfirmed(settingsVersion);
        } catch (caught) {
            const error = providerErrorFromRpcFailure(caught, {
                machineId: props.machineId,
                sourceProfileId: props.conflict.sourceProfileId,
            });
            setOperationError({
                error,
                retry: () => finishConfirmedMigration(settingsVersion),
            });
            return;
        }
        setOperationError(null);
        props.onClose();
    }, [props.conflict.sourceProfileId, props.machineId, props.onClose, props.onConfirmed]);

    const submit = React.useCallback(async (
        decision: LegacyProfileMigrationConflictResolutionV1['decision'],
    ): Promise<void> => {
        setPendingDecision(decision.kind);
        setOperationError(null);
        try {
            let result: Awaited<ReturnType<typeof confirmLegacyProfileMigrationConflict>>;
            try {
                result = await confirmLegacyProfileMigrationConflict({
                    serverId: props.serverId,
                    request: {
                        machineId: props.machineId,
                        sourceProfileId: props.conflict.sourceProfileId,
                        expectedCandidateFingerprint: props.conflict.candidateFingerprint,
                        decision,
                    },
                });
            } catch (caught) {
                const error = providerErrorFromRpcFailure(caught, {
                    machineId: props.machineId,
                    sourceProfileId: props.conflict.sourceProfileId,
                });
                setOperationError({
                    error,
                    ...providerRetryRecoveryForError(error, () => submit(decision)),
                });
                return;
            }
            if (result.status === 'error') {
                setOperationError({
                    error: result.error,
                    ...providerRetryRecoveryForError(result.error, () => submit(decision)),
                });
                return;
            }
            await finishConfirmedMigration(result.settingsVersion);
        } finally {
            setPendingDecision(null);
        }
    }, [finishConfirmedMigration, props.conflict.candidateFingerprint, props.conflict.sourceProfileId, props.machineId, props.serverId]);

    const trimmedDisplayName = displayName.trim();
    const hasModelConflict = props.conflict.kinds.includes('manual_model');

    return <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
        <ItemGroup
            title={t('settingsProviders.migration.conflictReviewTitle')}
            footer={t('settingsProviders.migration.conflictReviewFooter')}
        >
            <Item mode="info" title={props.profileName} showChevron={false} />
            {props.conflict.kinds.map((kind) => (
                <Item key={kind} mode="info" title={t(conflictTitleKey(kind))} showChevron={false} />
            ))}
        </ItemGroup>

        {hasModelConflict ? <ItemGroup
            title={t('settingsProviders.migration.modelOutcomeTitle')}
            footer={t('settingsProviders.migration.modelOutcomeFooter')}
        >
            {props.conflict.modelChoices.map((choice) => {
                const selected = modelSelection?.agentTargetKey === choice.selection.agentTargetKey
                    && modelSelection.modelId === choice.selection.modelId;
                return <Item
                    key={`${choice.kind}:${choice.selection.agentTargetKey}:${choice.selection.modelId}`}
                    title={choice.kind === 'existing'
                        ? t('settingsProviders.migration.useExistingModel')
                        : t('settingsProviders.migration.preserveLegacyModel')}
                    subtitle={choice.kind === 'existing'
                        ? t('settingsProviders.migration.useExistingModelDescription')
                        : t('settingsProviders.migration.preserveLegacyModelDescription')}
                    detail={choice.label ?? choice.selection.modelId}
                    selected={selected}
                    onPress={() => setModelSelection(choice.selection)}
                    showChevron={false}
                />;
            })}
            <Item
                title={t('settingsProviders.migration.discardLegacyModel')}
                subtitle={t('settingsProviders.migration.discardLegacyModelDescription')}
                selected={modelSelection === null}
                onPress={() => setModelSelection(null)}
                showChevron={false}
            />
        </ItemGroup> : null}

        {props.conflict.existingConnectionId ? <ItemGroup>
            <Item
                title={t('settingsProviders.migration.keepExisting')}
                subtitle={t('settingsProviders.migration.keepExistingDescription')}
                loading={pendingDecision === 'keep_existing'}
                disabled={pendingDecision !== null || (hasModelConflict && modelSelection === undefined)}
                onPress={() => void submit({
                    kind: 'keep_existing',
                    existingConnectionId: props.conflict.existingConnectionId!,
                    ...(hasModelConflict ? { modelSelection } : {}),
                })}
            />
        </ItemGroup> : null}

        <ItemGroup
            title={t('settingsProviders.migration.createNamed')}
            footer={t('settingsProviders.migration.createNamedDescription')}
        >
            <MachineSetupTextField
                testID="profile-migration-conflict-name"
                label={t('settingsProviders.migration.separateConnectionName')}
                value={displayName}
                onChangeText={setDisplayName}
            />
            <Item
                title={t('settingsProviders.migration.createNamed')}
                loading={pendingDecision === 'create_named'}
                disabled={pendingDecision !== null || trimmedDisplayName.length === 0}
                onPress={() => void submit({
                    kind: 'create_named',
                    connectionId: newConnectionId,
                    displayName: trimmedDisplayName,
                })}
            />
        </ItemGroup>

        {operationError ? <ItemGroup>
            <ProviderErrorItems error={operationError.error} retry={operationError.retry} />
        </ItemGroup> : null}

        <ItemGroup>
            <Item title={t('common.cancel')} disabled={pendingDecision !== null} onPress={props.onClose} />
        </ItemGroup>
    </ItemList>;
});
