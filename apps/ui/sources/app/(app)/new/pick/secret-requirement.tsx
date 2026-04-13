import React from 'react';
import { Platform } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useSetting, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { SecretRequirementScreen, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import { PopoverScope } from '@/components/ui/popover';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTargetFromSettings } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromSettings';
import { pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { settingsDefaults } from '@/sync/domains/settings/settings';

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

    const profiles = useSetting('profiles');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const settings = useSettings() ?? settingsDefaults;

    const profile =
        profiles.find((p: AIBackendProfile) => p.id === profileId) ??
        (profileId ? getBuiltInProfile(profileId) : null);

    const secretEnvVarName = typeof params.secretEnvVarName === 'string'
        ? params.secretEnvVarName.trim().toUpperCase()
        : '';
    const secretEnvVarNames = parseUpperEnvVarList(params.secretEnvVarNames);

    const selectedSecretIdByEnvVarName = React.useMemo(() => {
        return parseJsonRecord(params.selectedSecretIdByEnvVarName);
    }, [params.selectedSecretIdByEnvVarName]);
    const preferredBackendTarget = React.useMemo(() => {
        return resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
        });
    }, [
        settings.lastUsedAgent,
        settings.lastUsedBackendTarget,
        settings.backendEnabledByTargetKey,
        settings.acpCatalogSettingsV1,
    ]);
    const roundTripFallbackTarget = React.useMemo(() => {
        return resolveRouteCloseoutFallbackTarget({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            preferredBackendTarget,
        });
    }, [params.agentType, params.backendTarget, params.backendTargetKey, preferredBackendTarget]);
    const roundTripBackendParams = React.useMemo(() => {
        return buildBackendTargetRouteParams({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            fallbackTarget: roundTripFallbackTarget,
        });
    }, [params.agentType, params.backendTarget, params.backendTargetKey, roundTripFallbackTarget]);
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: false,
            presentation: Platform.OS === 'ios' ? 'containedTransparentModal' : undefined,
        } as const;
    }, []);

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
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [currentRouteParams, navigation, params.dataId, params.machineId, params.profileId, params.spawnServerId, profileId, revertOnCancel, roundTripBackendParams, router]);

    const handleCancel = React.useCallback(() => {
        sendResultToNewSession({ action: 'cancel' });
    }, [sendResultToNewSession]);

    React.useEffect(() => {
        const sub = (navigation as any)?.addListener?.('beforeRemove', () => {
            if (didSendResultRef.current) return;
            sendResultToNewSession({ action: 'cancel' });
        });
        return () => sub?.();
    }, [navigation, sendResultToNewSession]);

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
