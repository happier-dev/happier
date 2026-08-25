import React from 'react';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { Platform, Pressable } from 'react-native';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
    useCurrentSecretBindingsByProfileIdMutable,
    useSetting,
    useSettingMutable,
    useSettings,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { Modal } from '@/modal';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { machinePreviewEnv } from '@/sync/ops';
import { getRequiredSecretEnvVarNames } from '@/sync/domains/profiles/profileSecrets';
import { getTempData, storeTempData } from '@/utils/sessions/tempDataStore';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import {
    readUiAiLaunchProfilesForLegacyUi,
    removeAiLaunchProfile,
} from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { useMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { PopoverScope } from '@/components/ui/popover';
import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { buildSecretRequirementRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { buildProfileEditPickerRouteParams } from '@/components/sessions/new/navigation/buildProfileEditPickerRouteParams';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useNewSessionPickerRoutePresentation } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { Icon } from '@/components/ui/icons/Icon';

export default React.memo(function ProfilePickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        dataId?: string;
        draftId?: string;
        selectedId?: string;
        machineId?: string;
        profileId?: string | string[];
        secretRequirementResultId?: string;
        spawnServerId?: string;
    }>();
    const useProfiles = useSetting('useProfiles');
    const [secrets, setSecrets] = useSavedSecretsMutable();
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useCurrentSecretBindingsByProfileIdMutable();
    const [rawProfiles, setRawProfiles] = useSettingMutable('profiles');
    const profiles = React.useMemo(() => readUiAiLaunchProfilesForLegacyUi(rawProfiles), [rawProfiles]);
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const settings = useSettings() ?? settingsDefaults;

    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';
    const dataId = typeof params.dataId === 'string' ? params.dataId : undefined;
    const machineId = typeof params.machineId === 'string' ? params.machineId : undefined;
    const profileId = Array.isArray(params.profileId) ? params.profileId[0] : params.profileId;
    const secretRequirementResultId = typeof params.secretRequirementResultId === 'string' ? params.secretRequirementResultId : '';
    const hasUsableRouteState = Boolean(
        selectedId.trim()
        || dataId?.trim()
        || machineId?.trim()
        || (typeof profileId === 'string' && profileId.trim().length > 0)
        || secretRequirementResultId.trim(),
    );
    const spawnServerId = resolveSpawnServerRouteParam(params.spawnServerId);
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: machineId ?? null,
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
    const roundTripBackendParams = React.useMemo(() => {
        const roundTripFallbackTarget = resolveRouteCloseoutFallbackTarget({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            preferredBackendTarget,
        });
        return buildBackendTargetRouteParams({
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            agentType: params.agentType,
            fallbackTarget: roundTripFallbackTarget,
        });
    }, [
        params.agentType,
        params.backendTarget,
        params.backendTargetKey,
        preferredBackendTarget,
    ]);
    const setParamsOnPreviousAndClose = React.useCallback((next: { profileId: string; secretId?: string; secretSessionOnlyId?: string }) => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: next,
            currentParams: currentRouteParams,
            replaceParams: {
                ...roundTripBackendParams,
                ...(dataId ? { dataId } : {}),
                ...(machineId ? { machineId } : {}),
                ...(spawnServerId ? { spawnServerId } : {}),
                ...next,
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
    }, [currentRouteParams, dataId, machineId, navigation, roundTripBackendParams, router, spawnServerId]);

    React.useEffect(() => {
        if (hasUsableRouteState) return;
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [hasUsableRouteState, navigation, pickerFallbackHref, router]);

    // When the secret requirement screen is used (native), it returns a temp id via params.
    // We handle it here and then return to the previous route with the correct selection.
    React.useEffect(() => {
        if (typeof secretRequirementResultId !== 'string' || secretRequirementResultId.length === 0) {
            return;
        }

        const entry = getTempData<{
            profileId: string;
            revertOnCancel: boolean;
            result: SecretRequirementModalResult;
        }>(secretRequirementResultId);

        const clearParam = () => {
            const setParams = (navigation as any)?.setParams;
            if (typeof setParams === 'function') {
                setParams({ secretRequirementResultId: undefined });
            } else {
                navigation.dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { secretRequirementResultId: undefined } },
                } as never);
            }
        };

        if (!entry || !entry?.result) {
            clearParam();
            return;
        }

        const result = entry.result;
        if (result.action === 'cancel') {
            clearParam();
            return;
        }

        const resolvedProfileId = entry.profileId;
        if (result.action === 'useMachine') {
            setParamsOnPreviousAndClose({ profileId: resolvedProfileId, secretId: '' });
            return;
        }

        if (result.action === 'enterOnce') {
            const tempId = storeTempData({ secret: result.value });
            setParamsOnPreviousAndClose({ profileId: resolvedProfileId, secretSessionOnlyId: tempId });
            return;
        }

        if (result.action === 'selectSaved') {
            const envVarName = result.envVarName.trim().toUpperCase();
            if (result.setDefault && envVarName.length > 0) {
                setSecretBindingsByProfileId({
                    ...secretBindingsByProfileId,
                    [resolvedProfileId]: {
                        ...(secretBindingsByProfileId[resolvedProfileId] ?? {}),
                        [envVarName]: result.secretId,
                    },
                });
            }
            setParamsOnPreviousAndClose({ profileId: resolvedProfileId, secretId: result.secretId });
            return;
        }

        clearParam();
    }, [navigation, secretBindingsByProfileId, secretRequirementResultId, setParamsOnPreviousAndClose, setSecretBindingsByProfileId]);

    const openSecretModal = React.useCallback(async (profile: AIBackendProfile, envVarName: string) => {
        const requiredSecretName = envVarName.trim().toUpperCase();
        if (!requiredSecretName) return;

        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);

        if (Platform.OS !== 'web') {
            const selectedSecretIdByEnvVarName = secretBindingsByProfileId[profile.id] ?? null;
            router.push({
                pathname: '/new/pick/secret-requirement',
                params: {
                    ...roundTripBackendParams,
                    ...buildSecretRequirementRouteParams({
                        dataId: dataId ?? null,
                        draftId: params.draftId ?? null,
                        selectedMachineId: machineId ?? null,
                        targetServerId: spawnServerId ?? null,
                    }),
                    profileId: profile.id,
                    secretEnvVarName: requiredSecretName,
                    secretEnvVarNames: requiredSecretNames.join(','),
                    revertOnCancel: '0',
                    selectedSecretIdByEnvVarName: selectedSecretIdByEnvVarName
                        ? encodeURIComponent(JSON.stringify(selectedSecretIdByEnvVarName))
                        : undefined,
                },
            } as any);
            return;
        }

        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action === 'cancel') return;

            if (result.action === 'useMachine') {
                // Explicit choice: prefer machine key (do not auto-apply defaults in parent).
                setParamsOnPreviousAndClose({ profileId: profile.id, secretId: '' });
                return;
            }

            if (result.action === 'enterOnce') {
                const tempId = storeTempData({ secret: result.value });
                setParamsOnPreviousAndClose({ profileId: profile.id, secretSessionOnlyId: tempId });
                return;
            }

            if (result.action === 'selectSaved') {
                if (result.setDefault) {
                    setSecretBindingsByProfileId({
                        ...secretBindingsByProfileId,
                        [profile.id]: {
                            ...(secretBindingsByProfileId[profile.id] ?? {}),
                            [requiredSecretName]: result.secretId,
                        },
                    });
                }
                setParamsOnPreviousAndClose({ profileId: profile.id, secretId: result.secretId });
            }
        };

        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile,
                secretEnvVarName: requiredSecretName,
                secretEnvVarNames: requiredSecretNames,
                machineId: machineId ?? null,
                secrets,
                defaultSecretId: secretBindingsByProfileId[profile.id]?.[requiredSecretName] ?? null,
                defaultSecretIdByEnvVarName: secretBindingsByProfileId[profile.id] ?? null,
                onChangeSecrets: setSecrets,
                allowSessionOnly: true,
                onResolve: handleResolve,
            },
            onRequestClose: () => handleResolve({ action: 'cancel' }),
            closeOnBackdrop: true,
        });
    }, [dataId, machineId, roundTripBackendParams, router, secretBindingsByProfileId, secrets, setParamsOnPreviousAndClose, setSecretBindingsByProfileId, setSecrets, spawnServerId]);

    const handleProfilePress = React.useCallback(async (profile: AIBackendProfile) => {
        const profileId = profile.id;
        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);
        const machineEnvReadyByName: Record<string, boolean> = {};

        if (machineId && requiredSecretNames.length > 0) {
            // Best-effort: ask daemon for presence of all required secrets.
            const preview = await machinePreviewEnv(machineId, {
                keys: requiredSecretNames,
                extraEnv: getProfileEnvironmentVariables(profile),
                sensitiveKeys: requiredSecretNames,
            }, {
                serverId: spawnServerId,
            });
            if (preview.supported) {
                for (const name of requiredSecretNames) {
                    machineEnvReadyByName[name] = Boolean(preview.response.values[name]?.isSet);
                }
            } else {
                for (const name of requiredSecretNames) {
                    machineEnvReadyByName[name] = false;
                }
            }
        }

        const satisfaction = getSecretSatisfaction({
            profile,
            secrets,
            defaultBindings: secretBindingsByProfileId[profileId] ?? null,
            machineEnvReadyByName: machineId ? machineEnvReadyByName : null,
        });

        // If all required secrets are satisfied solely by a default saved secret AND this is the primary secret,
        // we can still support the single-secret return param for legacy callers.
        if (requiredSecretNames.length === 1) {
            const only = requiredSecretNames[0]!;
            const item = satisfaction.items.find((i) => i.envVarName === only) ?? null;
            if (item?.satisfiedBy === 'defaultSaved' && item.savedSecretId) {
                setParamsOnPreviousAndClose({ profileId, secretId: item.savedSecretId });
                return;
            }
        }

        if (!satisfaction.isSatisfied) {
            const missing = satisfaction.items.find((i) => i.required && !i.isSatisfied)?.envVarName ?? null;
            if (missing) {
                await openSecretModal(profile, missing);
                return;
            }
        }

        setParamsOnPreviousAndClose({ profileId });
    }, [machineId, openSecretModal, secretBindingsByProfileId, secrets, setParamsOnPreviousAndClose, spawnServerId]);

    const allRequiredSecretNames = React.useMemo(() => {
        const names = new Set<string>();
        for (const p of profiles) {
            for (const req of getRequiredSecretEnvVarNames(p)) {
                names.add(req);
            }
        }
        return Array.from(names);
    }, [profiles]);

    const activeServerId = getActiveServerId();
    const machineEnvPresenceServerId = spawnServerId ?? activeServerId;
    const machineEnvPresence = useMachineEnvPresence(machineId ?? null, allRequiredSecretNames, { ttlMs: 5 * 60_000, serverId: machineEnvPresenceServerId });

    const getSecretMachineEnvOverride = React.useCallback((profile: AIBackendProfile) => {
        const required = getRequiredSecretEnvVarNames(profile);
        if (required.length === 0) return null;
        if (!machineId) return null;
        if (!machineEnvPresence.isPreviewEnvSupported) return null;
        return {
            isReady: required.every((name) => Boolean(machineEnvPresence.meta[name]?.isSet)),
            isLoading: machineEnvPresence.isLoading,
        };
    }, [machineEnvPresence.isLoading, machineEnvPresence.isPreviewEnvSupported, machineEnvPresence.meta, machineId]);

    const handleDefaultEnvironmentPress = React.useCallback(() => {
        setParamsOnPreviousAndClose({ profileId: '' });
    }, [setParamsOnPreviousAndClose]);

    React.useEffect(() => {
        if (typeof profileId === 'string' && profileId.length > 0) {
            setParamsOnPreviousAndClose({ profileId });
        }
    }, [profileId, setParamsOnPreviousAndClose]);

    const pushProfileEdit = React.useCallback((nextParams: Readonly<Record<string, string>>) => {
        router.push({
            pathname: '/new/pick/profile-edit',
            params: buildProfileEditPickerRouteParams({
                backendTargetRouteParams: roundTripBackendParams,
                dataId,
                draftId: params.draftId,
                machineId,
                spawnServerId: spawnServerId ?? undefined,
                nextParams,
            }),
        });
    }, [dataId, machineId, params.draftId, roundTripBackendParams, router, spawnServerId]);

    const openProfileCreate = React.useCallback(() => {
        pushProfileEdit({});
    }, [pushProfileEdit]);

    const openProfileEdit = React.useCallback((profileId: string) => {
        pushProfileEdit({ profileId });
    }, [pushProfileEdit]);

    const openProfileDuplicate = React.useCallback((cloneFromProfileId: string) => {
        pushProfileEdit({ cloneFromProfileId });
    }, [pushProfileEdit]);

    const handleAddProfile = React.useCallback(() => {
        openProfileCreate();
    }, [openProfileCreate]);

    const handleDeleteProfile = React.useCallback((profile: AIBackendProfile) => {
        Modal.alert(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            [
                { text: t('profiles.delete.cancel'), style: 'cancel' },
                {
                    text: t('profiles.delete.confirm'),
                    style: 'destructive',
                    onPress: () => {
                        // Only custom profiles live in `profiles` setting.
                        setRawProfiles(removeAiLaunchProfile(rawProfiles, profile.id) as AIBackendProfile[]);
                        if (selectedId === profile.id) setParamsOnPreviousAndClose({ profileId: '' });
                    },
                },
            ],
        );
    }, [rawProfiles, selectedId, setParamsOnPreviousAndClose, setRawProfiles]);

    const handleBackPress = React.useCallback(() => {
        navigation.goBack();
    }, [navigation]);

    const headerLeft = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleBackPress}
                hitSlop={10}
                style={({ pressed }) => ({ marginLeft: 10, padding: 4, opacity: pressed ? 0.7 : 1 })}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
            >
                <Icon name="caret-left" size={20} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }, [handleBackPress, theme.colors.chrome.header.foreground]);
    const presentation = useNewSessionPickerRoutePresentation();

    const screenOptions = React.useCallback(() => {
        return {
            headerShown: true,
            title: t('profiles.title'),
            headerTitle: t('profiles.title'),
            headerBackTitle: t('common.back'),
            presentation,
            headerLeft,
        } as const;
    }, [headerLeft, presentation]);

    return (
        <PopoverScope>
            <>
                <Stack.Screen
                    options={screenOptions}
                />

                {!useProfiles ? (
                    <ItemGroup footer={t('settingsFeatures.profilesDisabled')}>
                        <Item
                            title={t('settingsFeatures.profiles')}
                            subtitle={t('settingsFeatures.profilesDisabled')}
                            icon={<Icon name="person" size={29} color={theme.colors.text.secondary} />}
                            showChevron={false}
                        />
                        <Item
                            title={t('settings.featuresTitle')}
                            subtitle={t('settings.featuresSubtitle')}
                            icon={<Icon name="flask" size={29} color={theme.colors.text.secondary} />}
                            onPress={() => router.push('/settings/features')}
                        />
                    </ItemGroup>
                ) : (
                    <ProfilesList
                        customProfiles={profiles}
                        favoriteProfileIds={favoriteProfileIds}
                        onFavoriteProfileIdsChange={setFavoriteProfileIds}
                        selectedProfileId={selectedId || null}
                        onPressProfile={handleProfilePress}
                        includeDefaultEnvironmentRow
                        onPressDefaultEnvironment={handleDefaultEnvironmentPress}
                        includeAddProfileRow
                        onAddProfilePress={handleAddProfile}
                        machineId={machineId ?? null}
                        getSecretOverrideReady={(profile) => {
                            const requiredSecretNames = getRequiredSecretEnvVarNames(profile);
                            if (requiredSecretNames.length === 0) return false;
                            const satisfaction = getSecretSatisfaction({
                                profile,
                                secrets,
                                defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
                                machineEnvReadyByName: null,
                            });
                            if (!satisfaction.isSatisfied) return false;
                            const required = satisfaction.items.filter((i) => i.required);
                            if (required.length == 0) return false;
                            return required.some((i) => i.satisfiedBy !== 'machineEnv');
                        }}
                        getSecretMachineEnvOverride={getSecretMachineEnvOverride}
                        onEditProfile={(p) => openProfileEdit(p.id)}
                        onDuplicateProfile={(p) => openProfileDuplicate(p.id)}
                        onDeleteProfile={handleDeleteProfile}
                        onSecretBadgePress={(profile) => {
                            const missing = getSecretSatisfaction({
                                profile,
                                secrets,
                                defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
                                machineEnvReadyByName: machineEnvPresence.meta
                                    ? Object.fromEntries(Object.entries(machineEnvPresence.meta).map(([k, v]) => [k, Boolean(v?.isSet)]))
                                    : null,
                            }).items.find((i) => i.required && !i.isSatisfied)?.envVarName ?? null;
                            openSecretModal(profile, missing ?? (getRequiredSecretEnvVarNames(profile)[0] ?? ''));
                        }}
                    />
                )}
            </>
        </PopoverScope>
    );
});

const stylesheet = StyleSheet.create(() => ({}));
