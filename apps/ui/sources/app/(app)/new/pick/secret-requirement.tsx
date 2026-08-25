import React from 'react';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import {
    useCurrentSecretBindingsByProfileIdMutable,
    useSetting,
    useSettingMutable,
    useSettings,
} from '@/sync/domains/state/storage';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { readUiAiLaunchProfilesForLegacyUi } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { SecretRequirementScreen, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import { PopoverScope } from '@/components/ui/popover';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';
import { useNewSessionSecretRequirementRoutePresentation } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';

type SecretRequirementRoutePayload = Readonly<{
    profileId: string;
    revertOnCancel: boolean;
    result: SecretRequirementModalResult;
}>;

function parseUpperEnvVarList(raw: unknown): string[] {
    if (typeof raw !== 'string') return [];
    return raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
}

function parseJsonRecord(raw: unknown): Record<string, string | null | undefined> {
    if (typeof raw !== 'string' || raw.length === 0) return {};
    try {
        const decoded = decodeURIComponent(raw);
        const parsed = JSON.parse(decoded);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed as Record<string, string | null | undefined>;
    } catch {
        return {};
    }
}

export default React.memo(function SecretRequirementPickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        dataId?: string;
        profileId?: string;
        secretEnvVarName?: string;
        secretEnvVarNames?: string;
        machineId?: string;
        revertOnCancel?: string;
        spawnServerId?: string;
        selectedSecretIdByEnvVarName?: string;
    }>();

    const profileId = typeof params.profileId === 'string' ? params.profileId : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId : null;
    const revertOnCancel = params.revertOnCancel === '1';

    const rawProfiles = useSetting('profiles');
    const profiles = React.useMemo(
        () => readUiAiLaunchProfilesForLegacyUi(rawProfiles),
        [rawProfiles],
    );
    const [secrets, setSecrets] = useSavedSecretsMutable();
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useCurrentSecretBindingsByProfileIdMutable();
    const settings = useSettings() ?? settingsDefaults;

    const profile = profileId ? resolveProfileById(profileId, profiles) : null;

    const secretEnvVarName = typeof params.secretEnvVarName === 'string'
        ? params.secretEnvVarName.trim().toUpperCase()
        : '';
    const secretEnvVarNames = parseUpperEnvVarList(params.secretEnvVarNames);

    const selectedSecretIdByEnvVarName = React.useMemo(() => {
        return parseJsonRecord(params.selectedSecretIdByEnvVarName);
    }, [params.selectedSecretIdByEnvVarName]);
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const spawnServerId = resolveSpawnServerRouteParam(params.spawnServerId);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: spawnServerId,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });
    const preferredBackendTarget = React.useMemo(() => {
        return resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
            daemonMergedProjectionInputs: daemonMergedProjection.inputs,
        });
    }, [
        daemonMergedProjection.inputs,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
        settings.lastUsedAgent,
        settings.lastUsedBackendTarget,
    ]);
    const presentation = useNewSessionSecretRequirementRoutePresentation();

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: false,
            presentation,
        } as const;
    }, [presentation]);

    const didSendResultRef = React.useRef(false);

    const sendResultToNewSession = React.useCallback((result: SecretRequirementModalResult) => {
        if (!profileId) return;
        if (didSendResultRef.current) return;
        didSendResultRef.current = true;

        const payload: SecretRequirementRoutePayload = {
            profileId,
            revertOnCancel,
            result,
        };
        const id = storeTempData(payload);
        const roundTripFallbackTarget = resolveRouteCloseoutFallbackTarget({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            preferredBackendTarget,
        });
        const roundTripBackendParams = buildBackendTargetRouteParams({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            fallbackTarget: roundTripFallbackTarget,
        });

        const returnMode = setNewSessionPickerReturnParams({
            navigation: navigation as any,
            router,
            routeParams: {
                ...roundTripBackendParams,
                secretRequirementResultId: id,
            },
            currentParams: currentRouteParams,
            replaceParams: {
                ...roundTripBackendParams,
                ...(typeof params.dataId === 'string' && params.dataId.trim().length > 0 ? { dataId: params.dataId } : {}),
                ...(typeof params.machineId === 'string' && params.machineId.trim().length > 0 ? { machineId: params.machineId } : {}),
                ...(typeof params.profileId === 'string' && params.profileId.trim().length > 0 ? { profileId: params.profileId } : {}),
                ...(typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0 ? { spawnServerId: params.spawnServerId } : {}),
                secretRequirementResultId: id,
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
    }, [
        currentRouteParams,
        machineId,
        navigation,
        params.agentType,
        params.backendTarget,
        params.backendTargetKey,
        params.dataId,
        params.machineId,
        params.profileId,
        params.spawnServerId,
        profileId,
        revertOnCancel,
        router,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
        settings.lastUsedAgent,
        settings.lastUsedBackendTarget,
        preferredBackendTarget,
        spawnServerId,
    ]);

    const handleCancel = React.useCallback(() => {
        sendResultToNewSession({ action: 'cancel' });
    }, [sendResultToNewSession]);

    React.useEffect(() => {
        const sub = (navigation as any)?.addListener?.('beforeRemove', () => {
            if (didSendResultRef.current) return;
            void sendResultToNewSession({ action: 'cancel' });
        });
        return () => sub?.();
    }, [navigation, sendResultToNewSession]);

    const hasUsableRouteState = Boolean(profile && secretEnvVarName);
    React.useEffect(() => {
        if (hasUsableRouteState) return;
        if (profileId) {
            void sendResultToNewSession({ action: 'cancel' });
            return;
        }
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [hasUsableRouteState, navigation, pickerFallbackHref, profileId, router, sendResultToNewSession]);

    if (!profile || !secretEnvVarName) {
        return (
            <>
                <Stack.Screen
                    options={screenOptions}
                />
            </>
        );
    }

    const defaultBindingsForProfile = secretBindingsByProfileId?.[profile.id] ?? null;

    return (
        <PopoverScope>
            <>
                <Stack.Screen
                    options={screenOptions}
                />

                <SecretRequirementScreen
                    profile={profile}
                    secretEnvVarName={secretEnvVarName}
                    secretEnvVarNames={secretEnvVarNames.length > 0 ? secretEnvVarNames : undefined}
                    machineId={machineId}
                    secrets={secrets}
                    defaultSecretId={defaultBindingsForProfile?.[secretEnvVarName] ?? null}
                    selectedSavedSecretId={
                        typeof selectedSecretIdByEnvVarName?.[secretEnvVarName] === 'string' &&
                            String(selectedSecretIdByEnvVarName?.[secretEnvVarName]).trim().length > 0
                            ? (selectedSecretIdByEnvVarName?.[secretEnvVarName] as string)
                            : null
                    }
                    selectedSecretIdByEnvVarName={selectedSecretIdByEnvVarName}
                    defaultSecretIdByEnvVarName={defaultBindingsForProfile}
                    onSetDefaultSecretId={(id) => {
                        if (!id) return;
                        setSecretBindingsByProfileId({
                            ...secretBindingsByProfileId,
                            [profile.id]: {
                                ...(secretBindingsByProfileId?.[profile.id] ?? {}),
                                [secretEnvVarName]: id,
                            },
                        });
                    }}
                    onChangeSecrets={setSecrets}
                    allowSessionOnly={true}
                    onResolve={sendResultToNewSession}
                    onClose={handleCancel}
                />
            </>
        </PopoverScope>
    );
});
