import * as React from 'react';
import type { AIBackendProfile, ProviderErrorV1, ProviderWireProtocol } from '@happier-dev/protocol';

import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { randomUUID } from '@/platform/randomUUID';
import {
    confirmLegacyProfileMigration,
    previewLegacyProfileMigration,
    providerErrorFromRpcFailure,
} from '@/providers/rpc/client';
import { providerRetryRecoveryForError } from '@/providers/connection/recovery';
import { t } from '@/text';

import {
    buildLegacyProfileMigrationDraft,
    buildLegacyProfileReviewedMapping,
    inferLegacyProfileCredentialStyle,
    type LegacyProfileMigrationDraft,
    type SupportedMigrationCredentialStyle,
} from './reviewedMapping';

type SupportedMigrationProtocol = Extract<ProviderWireProtocol, 'openai-responses' | 'openai-chat' | 'anthropic'>;

const PROTOCOLS: readonly SupportedMigrationProtocol[] = ['openai-responses', 'openai-chat', 'anthropic'];
const CREDENTIAL_STYLES: readonly SupportedMigrationCredentialStyle[] = ['bearer', 'x-api-key'];
const NO_CREDENTIAL_ID = '__none__';

export const LegacyProfileMigrationReview = React.memo(function LegacyProfileMigrationReview(props: Readonly<{
    profile: AIBackendProfile;
    secretBindings: Readonly<Record<string, string>>;
    machineId: string;
    serverId: string | null;
    connectionId?: string;
    onConfirmed: (settingsVersion: number) => Promise<void>;
    onClose: () => void;
}>) {
    const connectionId = React.useRef(props.connectionId ?? `pc_${randomUUID()}`).current;
    const connectionCreatedAt = React.useRef(Date.now()).current;
    const [draft, setDraft] = React.useState<LegacyProfileMigrationDraft>(() =>
        buildLegacyProfileMigrationDraft({ profile: props.profile, secretBindings: props.secretBindings }));
    const [sourceFingerprint, setSourceFingerprint] = React.useState<string | null>(null);
    const [pending, setPending] = React.useState<'preview' | 'confirm' | null>(null);
    const [operationError, setOperationError] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
    }> | null>(null);
    const [protocolOpen, setProtocolOpen] = React.useState(false);
    const [credentialOpen, setCredentialOpen] = React.useState(false);
    const [credentialStyleOpen, setCredentialStyleOpen] = React.useState(false);

    const updateDraft = React.useCallback((delta: Partial<LegacyProfileMigrationDraft>) => {
        setDraft((current) => ({ ...current, ...delta }));
        setSourceFingerprint(null);
        setOperationError(null);
    }, []);
    const buildMapping = React.useCallback(() => buildLegacyProfileReviewedMapping({
        draft,
        connectionId,
        now: connectionCreatedAt,
    }), [connectionCreatedAt, connectionId, draft]);
    const finishConfirmedMigration = React.useCallback(async (settingsVersion: number): Promise<void> => {
        try {
            await props.onConfirmed(settingsVersion);
        } catch (caught) {
            const error = providerErrorFromRpcFailure(caught, {
                machineId: props.machineId,
                sourceProfileId: props.profile.id,
            });
            setOperationError({
                error,
                retry: () => finishConfirmedMigration(settingsVersion),
            });
            return;
        }
        setOperationError(null);
        props.onClose();
    }, [props.machineId, props.onClose, props.onConfirmed, props.profile.id]);

    const preview = React.useCallback(async (): Promise<void> => {
        setPending('preview');
        setOperationError(null);
        try {
            const reviewedMapping = buildMapping();
            const result = await previewLegacyProfileMigration({
                serverId: props.serverId,
                request: {
                    machineId: props.machineId,
                    sourceProfileId: props.profile.id,
                    reviewedMapping,
                },
            });
            if (result.status === 'success') setSourceFingerprint(result.sourceFingerprint);
            else setOperationError({ error: result.error, retry: preview });
        } catch (caught) {
            setOperationError({
                error: providerErrorFromRpcFailure(caught, {
                    machineId: props.machineId,
                    sourceProfileId: props.profile.id,
                }),
                retry: preview,
            });
        } finally {
            setPending(null);
        }
    }, [buildMapping, props.machineId, props.profile.id, props.serverId]);

    const confirm = React.useCallback(async (): Promise<void> => {
        if (!sourceFingerprint) return;
        setPending('confirm');
        setOperationError(null);
        try {
            let result: Awaited<ReturnType<typeof confirmLegacyProfileMigration>>;
            try {
                result = await confirmLegacyProfileMigration({
                    serverId: props.serverId,
                    request: {
                        machineId: props.machineId,
                        sourceProfileId: props.profile.id,
                        reviewedMapping: buildMapping(),
                        expectedSourceFingerprint: sourceFingerprint,
                    },
                });
            } catch (caught) {
                const error = providerErrorFromRpcFailure(caught, {
                    machineId: props.machineId,
                    sourceProfileId: props.profile.id,
                });
                setOperationError({
                    error,
                    ...providerRetryRecoveryForError(error, confirm),
                });
                return;
            }
            if (result.status === 'error') {
                setOperationError({
                    error: result.error,
                    ...providerRetryRecoveryForError(result.error, confirm),
                });
                if (result.error.code === 'provider_profile_migration_source_changed') setSourceFingerprint(null);
                return;
            }
            await finishConfirmedMigration(result.settingsVersion);
        } finally {
            setPending(null);
        }
    }, [buildMapping, finishConfirmedMigration, props.machineId, props.profile.id, props.serverId, sourceFingerprint]);

    const protocols = React.useMemo<readonly DropdownMenuItem[]>(() => PROTOCOLS.map((protocol) => ({
        id: protocol,
        title: t(`settingsProviders.authoring.protocol.${protocol}.title`),
        subtitle: t(`settingsProviders.authoring.protocol.${protocol}.description`),
    })), []);
    const credentialItems = React.useMemo<readonly DropdownMenuItem[]>(() => (
        [
            { id: NO_CREDENTIAL_ID, title: t('settingsProviders.migration.noCredential') },
            ...draft.credentialCandidateEnvVarNames.map((name) => ({ id: name, title: name })),
        ]
    ), [draft.credentialCandidateEnvVarNames]);
    const credentialStyleItems = React.useMemo<readonly DropdownMenuItem[]>(() => CREDENTIAL_STYLES.map((style) => ({
        id: style,
        title: style === 'bearer'
            ? t('settingsProviders.authoring.credentialStyle.bearer')
            : t('settingsProviders.authoring.credentialStyle.xApiKey'),
    })), []);
    const credentialChoiceRequired = draft.credentialCandidateEnvVarNames.length > 0
        && !draft.credentialSelectionReviewed;
    const credentialStyleChoiceRequired = Boolean(draft.credentialEnvVarName && !draft.credentialStyle);
    const movedEnvironmentNames = React.useMemo(() => new Set([
        ...draft.routingEnvironmentVariableNames,
        ...(draft.credentialEnvVarName ? [draft.credentialEnvVarName] : []),
    ]), [draft.credentialEnvVarName, draft.routingEnvironmentVariableNames]);
    const keptEnvironmentNames = React.useMemo(() => [...new Set([
        ...props.profile.environmentVariables.map((entry) => entry.name),
        ...props.profile.envVarRequirements.map((entry) => entry.name),
    ])].filter((name) => !movedEnvironmentNames.has(name)), [
        movedEnvironmentNames,
        props.profile.environmentVariables,
        props.profile.envVarRequirements,
    ]);

    return (
        <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            <ItemGroup
                title={t('settingsProviders.migration.reviewTitle')}
                footer={t('settingsProviders.migration.reviewFooter')}
            >
                <Item mode="info" title={props.profile.name} subtitle={t('settingsProviders.migration.legacyProfileDescription')} />
            </ItemGroup>
            <ItemGroup title={t('settingsProviders.authoring.detailsTitle')}>
                <DropdownMenu
                    open={protocolOpen}
                    onOpenChange={setProtocolOpen}
                    variant="selectable"
                    selectedId={draft.protocol}
                    items={protocols}
                    rowKind="item"
                    showCategoryTitles={false}
                    itemTrigger={{
                        title: t('settingsProviders.authoring.protocolTitle'),
                        subtitle: protocols.find((item) => item.id === draft.protocol)?.title,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                    }}
                    onSelect={(id) => updateDraft({ protocol: id as SupportedMigrationProtocol })}
                />
                <MachineSetupTextField
                    testID="profile-migration-name"
                    label={t('settingsProviders.authoring.name')}
                    value={draft.name}
                    onChangeText={(name) => updateDraft({ name })}
                />
                <MachineSetupTextField
                    testID="profile-migration-base-url"
                    label={t('settingsProviders.authoring.baseUrl')}
                    value={draft.baseUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={(baseUrl) => updateDraft({ baseUrl })}
                />
                <MachineSetupTextField
                    testID="profile-migration-models"
                    label={t('settingsProviders.models.addFieldLabel')}
                    value={draft.manualModelsText}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={(manualModelsText) => updateDraft({ manualModelsText })}
                />
            </ItemGroup>
            <ItemGroup
                title={t('settingsProviders.migration.credentialTitle')}
                footer={t('settingsProviders.migration.credentialFooter')}
            >
                {draft.credentialCandidateEnvVarNames.length > 0 ? (
                    <DropdownMenu
                        open={credentialOpen}
                        onOpenChange={setCredentialOpen}
                        variant="selectable"
                        selectedId={draft.credentialSelectionReviewed
                            ? draft.credentialEnvVarName ?? NO_CREDENTIAL_ID
                            : undefined}
                        items={credentialItems}
                        rowKind="item"
                        showCategoryTitles={false}
                        itemTrigger={{
                            title: t('settingsProviders.migration.credentialTitle'),
                            subtitle: draft.credentialSelectionReviewed
                                ? draft.credentialEnvVarName ?? t('settingsProviders.migration.noCredential')
                                : t('settingsProviders.migration.credentialSelectionRequired'),
                            showSelectedDetail: false,
                            showSelectedSubtitle: false,
                        }}
                        onSelect={(id) => updateDraft(id === NO_CREDENTIAL_ID
                            ? {
                                credentialEnvVarName: null,
                                credentialStyle: null,
                                credentialSelectionReviewed: true,
                            }
                            : {
                                credentialEnvVarName: id,
                                credentialStyle: inferLegacyProfileCredentialStyle(id),
                                credentialSelectionReviewed: true,
                            })}
                    />
                ) : (
                    <Item
                        mode="info"
                        title={draft.credentialEnvVarName ?? t('settingsProviders.migration.noCredential')}
                        subtitle={draft.credentialEnvVarName
                            ? t('settingsProviders.migration.credentialMoveDescription')
                            : t('settingsProviders.migration.noCredentialDescription')}
                    />
                )}
                {draft.credentialEnvVarName ? (
                    <DropdownMenu
                        open={credentialStyleOpen}
                        onOpenChange={setCredentialStyleOpen}
                        variant="selectable"
                        selectedId={draft.credentialStyle ?? undefined}
                        items={credentialStyleItems}
                        rowKind="item"
                        showCategoryTitles={false}
                        itemTrigger={{
                            title: t('settingsProviders.authoring.credentialStyleTitle'),
                            subtitle: credentialStyleItems.find((item) => item.id === draft.credentialStyle)?.title
                                ?? t('settingsProviders.migration.credentialFormatSelectionRequired'),
                            showSelectedDetail: false,
                            showSelectedSubtitle: false,
                        }}
                        onSelect={(id) => updateDraft({ credentialStyle: id as SupportedMigrationCredentialStyle })}
                    />
                ) : null}
            </ItemGroup>
            <ItemGroup
                title={t('settingsProviders.migration.willMoveTitle')}
                footer={t('settingsProviders.migration.willMoveFooter')}
            >
                {[...movedEnvironmentNames].map((name) => (
                    <Item key={name} mode="info" title={name} showChevron={false} />
                ))}
            </ItemGroup>
            <ItemGroup
                title={t('settingsProviders.migration.willKeepTitle')}
                footer={t('settingsProviders.migration.willKeepFooter')}
            >
                {keptEnvironmentNames.map((name) => (
                    <Item key={name} mode="info" title={name} showChevron={false} />
                ))}
                {Object.keys(props.profile.defaultPermissionModeByTargetKey).length > 0 ? (
                    <Item mode="info" title={t('settingsProviders.migration.permissionDefaults')} showChevron={false} />
                ) : null}
                {Object.keys(props.profile.defaultPersistenceModeByTargetKey).length > 0 ? (
                    <Item mode="info" title={t('settingsProviders.migration.persistenceDefaults')} showChevron={false} />
                ) : null}
            </ItemGroup>
            {operationError ? <ItemGroup>
                <ProviderErrorItems error={operationError.error} retry={operationError.retry} />
            </ItemGroup> : null}
            <ItemGroup title={t('settingsProviders.migration.actionsTitle')}>
                {sourceFingerprint ? (
                    <Item
                        title={t('settingsProviders.migration.confirm')}
                        subtitle={t('settingsProviders.migration.confirmDescription')}
                        loading={pending === 'confirm'}
                        disabled={pending !== null}
                        onPress={() => void confirm()}
                    />
                ) : (
                    <Item
                        title={t('settingsProviders.migration.preview')}
                        subtitle={t('settingsProviders.migration.previewDescription')}
                        loading={pending === 'preview'}
                        disabled={pending !== null || credentialChoiceRequired || credentialStyleChoiceRequired}
                        onPress={() => void preview()}
                    />
                )}
                <Item title={t('common.cancel')} onPress={props.onClose} />
            </ItemGroup>
        </ItemList>
    );
});
