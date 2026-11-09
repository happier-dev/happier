import type { AIBackendProfile} from '@happier-dev/protocol/profiles/backendProfileSchema';
import type { AiLaunchProfile, AiLaunchProfileSourceV1} from '@happier-dev/protocol/profiles/read';
import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ConnectSheetContent } from '@/components/settings/connectedServices/setup/ConnectSheetContent';
import { presentConnectSheet, type ConnectSheetKeyRequest, type ConnectSheetResult } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { Text } from '@/components/ui/text/Text';
import { useMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { projectAiLaunchProfileForLegacyUi } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { t } from '@/text';
import { resolveStrictV2ProfileSecretReadiness, type StrictV2ProfileSecretReadiness } from '@/components/sessions/new/modules/resolveStrictV2ProfileSecretReadiness';

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
    const phone = isMobileLayoutWidth(useWindowDimensions().width);
    const triggerRef = React.useRef<View>(null);
    const catalog = useSavedSecretCatalog({
        sharedEnabled: props.sharedEnabled,
        scope: props.accountScope,
        personalSecrets: props.personalSecrets,
        includeMaterial: false,
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
    const [inlineConnect, setInlineConnect] = React.useState<Readonly<{ name: string; request: ConnectSheetKeyRequest }> | null>(null);

    React.useEffect(() => {
        setSelectedSecretIds({});
        setInlineConnect(null);
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

    const applyConnectResult = React.useCallback((name: string, result: ConnectSheetResult) => {
        setInlineConnect(null);
        if (result.kind !== 'dismissed' && 'secretRef' in result) {
            setSelectedSecretIds((previous) => ({ ...previous, [name]: result.secretRef }));
        }
    }, []);
    const openRequirement = (name: string, anchor: PopoverAnchor) => {
        const current = normalizeSecretReference(selectedSecretIds[name]) ?? normalizeSecretReference(props.defaultBindings?.[name]);
        const request: ConnectSheetKeyRequest = {
            service: { kind: 'key', suggestedName: name },
            scope: props.accountScope,
            ...(current ? { current } : {}),
            anchor,
        };
        if (phone) setInlineConnect({ name, request });
        else void presentConnectSheet(request).then((result) => applyConnectResult(name, result));
    };

    if (!props.profile || requirements.length === 0) return null;

    return (
        <View style={{ gap: theme.space.s8 }}>
            <View ref={triggerRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <RoundButton
                    testID="execution-run-secret-overlay-edit"
                    title={t('profiles.requirements.modalTitle')}
                    display="secondary"
                    size="small"
                    disabled={!props.editable}
                    onPress={() => {
                        const target = requirements.find((requirement) => requirement.required)?.name ?? requirementNames[0];
                        if (target) openRequirement(target, { kind: 'view', ref: triggerRef });
                    }}
                />
            </View>
            <View testID="execution-run-secret-overlay-review" style={{ gap: theme.space.s4 }}>
                {requirementPresentations.map((presentation) => (
                    <View key={presentation.name} style={{ gap: theme.space.s4 }}>
                        <Text style={{ color: theme.colors.text.primary, fontWeight: '600' }}>
                            {presentation.name}
                        </Text>
                        <Text style={{ color: theme.colors.text.secondary }}>
                            {[presentation.sourceName, presentation.status]
                                .filter((value): value is string => Boolean(value))
                                .join(' · ')}
                        </Text>
                        <ExecutionRunSecretRequirementActions
                            name={presentation.name}
                            editable={props.editable}
                            machineAvailable={Boolean(props.machineId) && !normalizeSecretReference(props.defaultBindings?.[presentation.name])}
                            machineReady={machineEnvPresence.meta?.[presentation.name]?.isSet === true}
                            onConnect={openRequirement}
                            onUseMachine={() => {
                                setInlineConnect(null);
                                setSelectedSecretIds((previous) => ({ ...previous, [presentation.name]: '' }));
                            }}
                        />
                    </View>
                ))}
            </View>
            {inlineConnect ? (
                <ConnectSheetContent
                    key={inlineConnect.name}
                    request={inlineConnect.request}
                    onClose={() => setInlineConnect(null)}
                    onResult={(result) => applyConnectResult(inlineConnect.name, result)}
                />
            ) : null}
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

function ExecutionRunSecretRequirementActions(props: Readonly<{
    name: string;
    editable: boolean;
    machineAvailable: boolean;
    machineReady: boolean;
    onConnect: (name: string, anchor: PopoverAnchor) => void;
    onUseMachine: () => void;
}>) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 }}>
            <View ref={anchorRef} collapsable={false}>
                <RoundButton
                    testID={`execution-run-secret-saved:${props.name}`}
                    title={t('profiles.requirements.options.useSavedSecret.title')}
                    display="secondary"
                    size="small"
                    disabled={!props.editable}
                    onPress={() => props.onConnect(props.name, { kind: 'view', ref: anchorRef })}
                />
            </View>
            {props.machineAvailable ? (
                <RoundButton
                    testID={`execution-run-secret-machine:${props.name}`}
                    title={t('profiles.requirements.options.useMachineEnvironment.title')}
                    display="secondary"
                    size="small"
                    disabled={!props.editable || !props.machineReady}
                    onPress={props.onUseMachine}
                />
            ) : null}
        </View>
    );
}
