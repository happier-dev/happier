import React from 'react';
import { View, Platform, useWindowDimensions, Pressable } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { useHeaderHeight } from '@react-navigation/elements';
import Constants from 'expo-constants';
import { t } from '@/text';
import { LaunchProfileEditForm } from '@/components/profiles/edit';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { layout } from '@/components/ui/layout/layout';
import { useSetting, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { DEFAULT_PROFILES, getBuiltInProfile, getBuiltInProfileNameKey, resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/domains/profiles/profileMutations';
import { Modal } from '@/modal';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { PopoverScope } from '@/components/ui/popover';
import { KeyboardAwareScreen } from '@/components/ui/keyboardAvoidance';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import {
    type ActiveUnsavedChangesGuard,
    runUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';
import { useNewSessionPickerRoutePresentation } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { isLaunchProfileV2, readAiLaunchProfileCollection, type AiLaunchProfile } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';
import {
    appendAiLaunchProfile,
    readUiAiLaunchProfiles,
    replaceAiLaunchProfile,
} from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { useApplyProfileSave } from '@/sync/store/settingsWriters';

export default React.memo(function ProfileEditScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        dataId?: string | string[];
        profileId?: string | string[];
        cloneFromProfileId?: string | string[];
        profileData?: string | string[];
        machineId?: string | string[];
        spawnServerId?: string | string[];
    }>();
    const settings = useSettings() ?? settingsDefaults;
    const machineIdParam = Array.isArray(params.machineId) ? params.machineId[0] : params.machineId;
    const spawnServerIdParam = resolveSpawnServerRouteParam(Array.isArray(params.spawnServerId) ? params.spawnServerId[0] : params.spawnServerId);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: machineIdParam ?? null,
        serverId: spawnServerIdParam,
        enabled: Boolean(machineIdParam),
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
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const profileIdParam = Array.isArray(params.profileId) ? params.profileId[0] : params.profileId;
    const cloneFromProfileIdParam = Array.isArray(params.cloneFromProfileId) ? params.cloneFromProfileId[0] : params.cloneFromProfileId;
    const profileDataParam = Array.isArray(params.profileData) ? params.profileData[0] : params.profileData;
    const screenWidth = useWindowDimensions().width;
    const headerHeight = useHeaderHeight();
    const rawProfiles = useSetting('profiles');
    const launchProfiles = React.useMemo(() => readUiAiLaunchProfiles(rawProfiles), [rawProfiles]);
    const applyProfileSave = useApplyProfileSave();
    const [, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [isDirty, setIsDirty] = React.useState(false);
    const isDirtyRef = React.useRef(false);
    const saveRef = React.useRef<(() => boolean) | null>(null);

    React.useEffect(() => {
        isDirtyRef.current = isDirty;
    }, [isDirty]);

    React.useEffect(() => {
        // On iOS native-stack modals, swipe-down dismissal can bypass `beforeRemove` in practice.
        // The only reliable way to ensure unsaved edits aren't lost is to disable the gesture
        // while the form is dirty, and rely on the header back/cancel flow (which we guard).
        const setOptions = (navigation as any)?.setOptions;
        if (typeof setOptions !== 'function') return;
        setOptions({ gestureEnabled: !isDirty });
    }, [isDirty, navigation]);

    React.useEffect(() => {
        const setOptions = (navigation as any)?.setOptions;
        if (typeof setOptions !== 'function') return;
        return () => {
            // Always re-enable the gesture when leaving this screen.
            setOptions({ gestureEnabled: true });
        };
    }, [navigation]);

    // Deserialize profile from URL params
    const profile: AiLaunchProfile = React.useMemo(() => {
        if (profileDataParam) {
            try {
                // Params may arrive already decoded (native) or URL-encoded (web / manual encodeURIComponent).
                // Try raw JSON first, then fall back to decodeURIComponent.
                try {
                    const parsed = readAiLaunchProfileCollection([JSON.parse(profileDataParam)]).entries[0];
                    if (parsed && parsed.kind !== 'opaque') return parsed.profile;
                } catch {
                    const parsed = readAiLaunchProfileCollection([JSON.parse(decodeURIComponent(profileDataParam))]).entries[0];
                    if (parsed && parsed.kind !== 'opaque') return parsed.profile;
                }
            } catch (error) {
                console.error('Failed to parse profile data:', error);
            }
        }
        const resolveById = (id: string): AiLaunchProfile | null => (
            launchProfiles.find((entry) => entry.id === id) ?? getBuiltInProfile(id)
        );

        if (cloneFromProfileIdParam) {
            const base = resolveById(cloneFromProfileIdParam);
            if (base) {
                return duplicateProfileForEdit(base, { copySuffix: t('profiles.copySuffix') });
            }
        }

        if (profileIdParam) {
            const existing = resolveById(profileIdParam);
            if (existing) {
                return existing;
            }
        }

        // Return empty profile for new profile creation
        return createEmptyCustomProfile();
    }, [cloneFromProfileIdParam, launchProfiles, profileDataParam, profileIdParam]);

    const confirmDiscard = React.useCallback(async () => {
        const isBuiltIn = !isLaunchProfileV2(profile) && profile.isBuiltIn === true;
        const saveText = isBuiltIn ? t('common.saveAs') : t('common.save');
        const message = isBuiltIn
            ? `${t('common.unsavedChangesWarning')}\n\n${t('profiles.builtInSaveAsHint')}`
            : t('common.unsavedChangesWarning');
        return promptUnsavedChangesAlert(
            (title, message, buttons) => Modal.alert(title, message, buttons),
            {
                title: t('common.discardChanges'),
                message,
                discardText: t('common.discard'),
                saveText,
                keepEditingText: t('common.keepEditing'),
            },
        );
    }, [profile]);

    const unsavedChangesGuard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef,
        requestDecision: confirmDiscard,
        onSave: () => saveRef.current?.() ?? false,
        continueOnSave: false,
        tag: 'ProfileEditScreen.beforeRemove',
    }), [confirmDiscard]);

    useUnsavedChangesBeforeRemoveGuard({
        isDirty,
        isDirtyRef: unsavedChangesGuard.isDirtyRef,
        requestDecision: unsavedChangesGuard.requestDecision,
        onSave: unsavedChangesGuard.onSave,
        continueOnSave: unsavedChangesGuard.continueOnSave,
        onContinue: (action) => {
            if (!action) return;
            (navigation as any)?.dispatch?.(action);
        },
        tag: unsavedChangesGuard.tag,
    });

    const handleSave = (savedProfile: AiLaunchProfile, secretBindings?: Readonly<Record<string, string>>): boolean => {
        if (!savedProfile.name || savedProfile.name.trim() === '') {
            Modal.alert(t('common.error'), t('profiles.nameRequired'));
            return false;
        }

        const isBuiltIn =
            (!isLaunchProfileV2(savedProfile) && savedProfile.isBuiltIn === true) ||
            DEFAULT_PROFILES.some((bp) => bp.id === savedProfile.id) ||
            getBuiltInProfileNameKey(savedProfile.id) !== null;

        let profileToSave: AiLaunchProfile = savedProfile;
        if (isBuiltIn) {
            profileToSave = convertBuiltInProfileToCustom(savedProfile as AIBackendProfile);
        }

        const builtInNames = DEFAULT_PROFILES
            .map((bp) => {
                const key = getBuiltInProfileNameKey(bp.id);
                return key ? t(key).trim() : null;
            })
            .filter((name): name is string => Boolean(name));
        const hasBuiltInNameConflict = builtInNames.includes(profileToSave.name.trim());

        // Duplicate name guard (same behavior as settings/profiles)
        const isDuplicateName = launchProfiles.some((p) => {
            if (isBuiltIn) {
                return p.name.trim() === profileToSave.name.trim();
            }
            return p.id !== profileToSave.id && p.name.trim() === profileToSave.name.trim();
        });
        if (isDuplicateName || hasBuiltInNameConflict) {
            Modal.alert(t('common.error'), t('profiles.duplicateName'));
            return false;
        }

        const exists = launchProfiles.some((entry) => entry.id === profileToSave.id);
        const isNewProfile = !exists;
        const updatedProfile = { ...profileToSave, updatedAt: Date.now() } as AiLaunchProfile;
        const nextRawProfiles = exists
            ? replaceAiLaunchProfile(rawProfiles, profileToSave.id, updatedProfile)
            : appendAiLaunchProfile(rawProfiles, updatedProfile);
        applyProfileSave({
            profiles: nextRawProfiles as typeof rawProfiles,
            profileId: updatedProfile.id,
            ...(!isLaunchProfileV2(updatedProfile) && secretBindings !== undefined ? { secretBindings } : {}),
        });

        // Update last used profile for convenience in other screens.
        if (isNewProfile) {
            setLastUsedProfile(profileToSave.id);
            // For newly created profiles (including "Save As" from a built-in profile), prefer passing the id
            // back to the previous picker route (if present). The picker already knows how to forward the
            // selection to /new and close itself. This avoids stacking /new on top of /new (wizard case).
            isDirtyRef.current = false;
            setIsDirty(false);
            const returnMode = setNewSessionPickerReturnParams({
                navigation: navigation as any,
                router,
                routeParams: {
                    ...roundTripBackendParams,
                    profileId: profileToSave.id,
                },
                currentParams: currentRouteParams,
            });
            if (returnMode === 'dispatch') {
                safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
            }
            return true;
        }

        // Pass selection back to the /new screen via navigation params (unmount-safe).
        const returnMode = setNewSessionPickerReturnParams({
            navigation: navigation as any,
            router,
            routeParams: {
                ...roundTripBackendParams,
                profileId: profileToSave.id,
            },
            currentParams: currentRouteParams,
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
        // Prevent the unsaved-changes guard from triggering on successful save.
        isDirtyRef.current = false;
        setIsDirty(false);
        return true;
    };

    const handleCancel = React.useCallback(() => {
        void runUnsavedChangesGuard(
            unsavedChangesGuard,
            () => safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref }),
        );
    }, [navigation, pickerFallbackHref, router, unsavedChangesGuard]);

    const headerTitle = profile.name ? t('profiles.editProfile') : t('profiles.addProfile');
    const headerBackTitle = t('common.back');

    const headerLeft = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleCancel}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                hitSlop={12}
                style={({ pressed }) => ({
                    opacity: pressed ? 0.7 : 1,
                    padding: 4,
                })}
            >
                <Icon name="x" size={24} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }, [handleCancel, theme.colors.chrome.header.foreground]);

    const handleSavePress = React.useCallback(() => {
        saveRef.current?.();
    }, []);

    const headerRight = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleSavePress}
                disabled={!isDirty}
                accessibilityRole="button"
                accessibilityLabel={t('common.save')}
                hitSlop={12}
                style={({ pressed }) => ({
                    opacity: !isDirty ? 0.35 : pressed ? 0.7 : 1,
                    padding: 4,
                })}
            >
                <Icon name="check" size={24} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }, [handleSavePress, isDirty, theme.colors.chrome.header.foreground]);
    const presentation = useNewSessionPickerRoutePresentation();

    const screenOptions = React.useMemo(() => {
        return {
            headerTitle,
            headerBackTitle,
            headerLeft,
            headerRight,
            presentation,
        } as const;
    }, [headerBackTitle, headerLeft, headerRight, headerTitle, presentation]);

    return (
        <PopoverScope>
            <KeyboardAwareScreen
                mode="form"
                keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + headerHeight : 0}
                style={profileEditScreenStyles.container}
            >
                <Stack.Screen
                    options={screenOptions}
                />
                <View style={[
                    { flex: 1, paddingHorizontal: screenWidth > 700 ? 16 : 8 }
                ]}>
                    <View style={[
                        { maxWidth: layout.maxWidth, flex: 1, width: '100%', alignSelf: 'center' }
                    ]}>
                        <LaunchProfileEditForm
                            profile={profile}
                            machineId={machineIdParam || null}
                            onSave={handleSave}
                            onCancel={handleCancel}
                            onDirtyChange={setIsDirty}
                            saveRef={saveRef}
                        />
                    </View>
                </View>
            </KeyboardAwareScreen>
        </PopoverScope>
    );
});

const profileEditScreenStyles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
        paddingBottom: rt.insets.bottom,
    },
}));
