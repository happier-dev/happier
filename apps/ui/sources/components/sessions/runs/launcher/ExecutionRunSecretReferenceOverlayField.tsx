import type { AIBackendProfile, AiLaunchProfile, AiLaunchProfileSourceV1, SecretReferenceOverlayV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { Modal } from '@/modal';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { projectAiLaunchProfileForLegacyUi } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { t } from '@/text';
import { resolveStrictV2ProfileSecretReadiness, type StrictV2ProfileSecretReadiness } from '@/components/sessions/new/modules/resolveStrictV2ProfileSecretReadiness';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type ExecutionRunSecretReferenceOverlayState = Readonly<{
    readiness: StrictV2ProfileSecretReadiness;
    overlay?: SecretReferenceOverlayV1;
}>;

export function resolveExecutionRunSessionLaunchProfile(
    sessionMetadata: unknown,
    profiles: readonly AiLaunchProfile[],
): (AIBackendProfile & AiLaunchProfileSourceV1) | null {
    const rawProfileId = sessionMetadata && typeof sessionMetadata === 'object' && !Array.isArray(sessionMetadata)
        ? Reflect.get(sessionMetadata, 'profileId')
        : null;
    const profileId = typeof rawProfileId === 'string' ? rawProfileId.trim() : '';
    if (!profileId) return null;
    return profiles.map(projectAiLaunchProfileForLegacyUi).find((profile) => profile.id === profileId)
        ?? getBuiltInProfile(profileId);
}

function normalizeSecretReference(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function savedSecretStatusLabel(status: SavedSecretReferenceResolution['status']): string {
    switch (status) {
        case 'ready': return t('secrets.catalog.status.ready');
        case 'preparing_encrypted_access': return t('secrets.catalog.status.preparing_encrypted_access');
        case 'recipient_mode_unsupported': return t('secrets.catalog.status.recipient_mode_unsupported');
        case 'temporarily_unavailable': return t('secrets.catalog.status.temporarily_unavailable');
        case 'access_removed': return t('secrets.catalog.status.access_removed');
        case 'deleted': return t('secrets.catalog.status.deleted');
        case 'update_required': return t('secrets.catalog.status.update_required');
    }
}

export const ExecutionRunSecretReferenceOverlayField = React.memo((props: Readonly<{
    profile: AIBackendProfile | null;
    machineId: string | null;
    serverId: string | null;
    accountScope: AccountSettingsScope | null;
    defaultBindings: Readonly<Record<string, string>> | null;
    personalSecrets: readonly SavedSecret[];
    sharedEnabled: boolean;
    editable: boolean;
    onChange: (state: ExecutionRunSecretReferenceOverlayState) => void;
}>) => {
    const { theme } = useUnistyles();
    const interactiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const catalog = useSavedSecretCatalog({
        sharedEnabled: props.sharedEnabled,
        scope: props.accountScope,
        personalSecrets: props.personalSecrets,
    });
    const requirements = React.useMemo(() => (props.profile?.envVarRequirements ?? []).filter((requirement) => (
        (requirement.kind ?? 'secret') === 'secret'
    )), [props.profile]);
    const requirementNames = React.useMemo(() => requirements.map((requirement) => requirement.name), [requirements]);
    const machineEnvPresence = useMachineEnvPresence(props.machineId, requirementNames, {
        ttlMs: 2 * 60_000,
        serverId: props.serverId,
    });
    const [selectedSecretIds, setSelectedSecretIds] = React.useState<Readonly<Record<string, string | null>>>({});

    React.useEffect(() => {
        setSelectedSecretIds({});
    }, [props.profile?.id]);

    const readiness = React.useMemo<StrictV2ProfileSecretReadiness>(() => {
        if (!props.profile) return { ok: true };
        return resolveStrictV2ProfileSecretReadiness({
            profile: props.profile,
            defaultBindings: props.defaultBindings,
            selectedSecretIds,
            machineEnvReadyByName: Object.fromEntries(
                Object.entries(machineEnvPresence.meta ?? {}).map(([name, value]) => [name, value?.isSet === true]),
            ),
            resolveSavedSecretReference: catalog.resolveReference,
        });
    }, [catalog.resolveReference, machineEnvPresence.meta, props.defaultBindings, props.profile, selectedSecretIds]);
    const requirementPresentations = React.useMemo(() => requirements.map((requirement) => {
        const selectedRef = normalizeSecretReference(selectedSecretIds[requirement.name]);
        const defaultRef = normalizeSecretReference(props.defaultBindings?.[requirement.name]);
        const reference = selectedRef ?? defaultRef;
        if (reference) {
            const resolution = catalog.resolveReference(reference);
            return {
                name: requirement.name,
                sourceName: resolution.entry?.name
                    ?? resolution.secret?.name
                    ?? (resolution.kind === 'shared_resource'
                        ? t('secrets.catalog.unavailableName')
                        : t('secrets.savedTitle')),
                status: savedSecretStatusLabel(resolution.status),
            };
        }
        const machineStatus = machineEnvPresence.meta?.[requirement.name];
        return {
            name: requirement.name,
            sourceName: null,
            status: machineStatus?.isSet === true
                ? t('profiles.requirements.configured')
                : machineStatus === undefined
                    ? t('profiles.requirements.checking')
                    : t('profiles.requirements.notConfigured'),
        };
    }), [catalog.resolveReference, machineEnvPresence.meta, props.defaultBindings, requirements, selectedSecretIds]);

    React.useEffect(() => {
        props.onChange({
            readiness,
            ...(readiness.ok && readiness.secretReferenceOverlay
                ? { overlay: readiness.secretReferenceOverlay }
                : {}),
        });
    }, [props.onChange, readiness]);

    const openRequirement = React.useCallback(() => {
        const profile = props.profile;
        const target = requirements.find((requirement) => requirement.required)?.name ?? requirementNames[0];
        if (!profile || !target) return;
        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action === 'useMachine') {
                setSelectedSecretIds((previous) => ({ ...previous, [result.envVarName]: '' }));
            } else if (result.action === 'selectSaved') {
                setSelectedSecretIds((previous) => ({ ...previous, [result.envVarName]: result.secretId }));
            }
        };
        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile,
                secretEnvVarName: target,
                secretEnvVarNames: requirementNames,
                machineId: props.machineId,
                secrets: [...props.personalSecrets],
                defaultSecretId: props.defaultBindings?.[target] ?? null,
                selectedSavedSecretId: selectedSecretIds[target] || null,
                selectedSecretIdByEnvVarName: selectedSecretIds,
                defaultSecretIdByEnvVarName: props.defaultBindings,
                allowSessionOnly: false,
                sharedSavedSecretsEnabled: catalog.sharedEnabled,
                accountScope: props.accountScope,
                onResolve: handleResolve,
            },
            onRequestClose: () => handleResolve({ action: 'cancel' }),
            closeOnBackdrop: true,
        });
    }, [catalog.sharedEnabled, props.accountScope, props.defaultBindings, props.machineId, props.personalSecrets, props.profile, requirementNames, requirements, selectedSecretIds]);

    if (!props.profile || requirements.length === 0) return null;

    return (
        <View style={{ gap: 8 }}>
            <Pressable
                testID="execution-run-secret-overlay-edit"
                accessibilityRole="button"
                accessibilityLabel={t('profiles.requirements.modalTitle')}
                disabled={!props.editable}
                onPress={openRequirement}
                style={({ pressed }) => ({
                    minWidth: interactiveTargetSize,
                    minHeight: interactiveTargetSize,
                    justifyContent: 'center',
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: theme.colors.border.default,
                    backgroundColor: theme.colors.surface.inset,
                    opacity: !props.editable ? 0.5 : pressed ? motionTokens.press.opacity : 1,
                })}
            >
                <Text style={{ color: theme.colors.text.primary, fontWeight: '600' }}>
                    {t('profiles.requirements.modalTitle')}
                </Text>
            </Pressable>
            <View testID="execution-run-secret-overlay-review" style={{ gap: 4 }}>
                {requirementPresentations.map((presentation) => (
                    <View key={presentation.name}>
                        <Text style={{ color: theme.colors.text.primary, fontWeight: '600' }}>
                            {presentation.name}
                        </Text>
                        <Text style={{ color: theme.colors.text.secondary }}>
                            {[presentation.sourceName, presentation.status]
                                .filter((value): value is string => Boolean(value))
                                .join(' · ')}
                        </Text>
                    </View>
                ))}
            </View>
            {!readiness.ok ? (
                <Text testID="execution-run-secret-overlay-unavailable" style={{ color: theme.colors.status?.error ?? theme.colors.text.primary }}>
                    {readiness.reason === 'secret_requirement_unsatisfied'
                        ? t('secrets.missingForProfile', { env: requirementNames.join(', ') })
                        : t('secrets.catalog.operationFailed')}
                </Text>
            ) : null}
        </View>
    );
});
