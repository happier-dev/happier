import { useLastUsedBackendSelection } from '@/hooks/session/useLastUsedBackendSelection';
import { useAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { NewSessionPickerRouteScreen } from '@/components/sessions/new/navigation/NewSessionPickerRouteScreen';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { LaunchProfileEditForm } from '@/components/profiles/edit';
import { layout } from '@/components/ui/layout/layout';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { PopoverScope } from '@/components/ui/popover';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import {
    type ActiveUnsavedChangesGuard,
    runUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { useNewSessionPickerReturnHost } from '@/components/sessions/new/navigation/newSessionEntry';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';
import { readAiLaunchProfileCollection, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useProfileCatalog } from '@/sync/store/useProfileCatalog';
import { useLaunchProfileEditorDraft } from '@/components/profiles/edit/useLaunchProfileEditorDraft';
import { LaunchProfileEditorMigration } from '@/components/profiles/migration/LaunchProfileEditorMigration';
import { Icon } from '@/components/ui/icons/Icon';
import { promptLaunchProfileUnsavedChanges, useSaveLaunchProfile } from '@/components/profiles/edit/useSaveLaunchProfile';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

export default React.memo(function ProfileEditScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const returnToHost = useNewSessionPickerReturnHost();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        agentType?: string;
        newSessionHostDraftId?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        dataId?: string | string[];
        profileId?: string | string[];
        cloneFromProfileId?: string | string[];
        profileData?: string | string[];
        machineId?: string | string[];
        spawnServerId?: string | string[];
    }>();
    const remembered = useLastUsedBackendSelection();
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }), ["backendEnabledByTargetKey"]);
    const machineIdParam = Array.isArray(params.machineId) ? params.machineId[0] : params.machineId;
    const spawnServerIdParam = resolveSpawnServerRouteParam(Array.isArray(params.spawnServerId) ? params.spawnServerId[0] : params.spawnServerId);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        // The backend preference reads Agent declarations only.
        sections: DAEMON_AGENT_CATALOG_SECTIONS,
        machineId: machineIdParam ?? null,
        serverId: spawnServerIdParam,
        enabled: Boolean(machineIdParam),
    });
    const { snapshot: acpCatalog } = useAcpCatalogForServer(spawnServerIdParam);
    const preferredBackendTarget = React.useMemo(() => {
        return resolvePreferredBackendTarget({
            lastUsedAgent: remembered.lastUsedAgent,
            lastUsedBackendTarget: remembered.lastUsedBackendTarget,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
            acpCatalogSnapshot: acpCatalog && !acpCatalog.stale ? acpCatalog.catalog : undefined,
            daemonMergedProjectionInputs: daemonMergedProjection.inputs,
        });
    }, [
        daemonMergedProjection.inputs,
        remembered.lastUsedAgent,
        remembered.lastUsedBackendTarget,
        settings.backendEnabledByTargetKey,
        acpCatalog,
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
    const launchProfiles = useAiLaunchProfiles();
    const profileScope = useAccountSettingsScope();
    const [isDirty, setIsDirty] = React.useState(false);
    const isDirtyRef = React.useRef(false);
    const saveRef = React.useRef<(() => boolean | Promise<boolean>) | null>(null);
    const mountedRef = useMountedRef();

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

    const catalog = useProfileCatalog(profileScope);
    const providedProfile = React.useMemo(() => {
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
        return null;
    }, [profileDataParam]);
    const { draft } = useLaunchProfileEditorDraft({
        enabled: !providedProfile,
        cloneFrom: cloneFromProfileIdParam ?? profileIdParam ?? null,
        saveAsBuiltin: !cloneFromProfileIdParam && Boolean(profileIdParam),
    });
    const saved = profileIdParam ? launchProfiles.find(entry => entry.id === profileIdParam)
        ?? getBuiltInProfile(profileIdParam) : null;
    const profile = providedProfile ?? (draft.status === 'ready' ? draft.profile
        : draft.status === 'idle' ? saved : null);
    const draftSecretBindings = draft.status === 'ready' ? draft.secretBindings : undefined;
    const loading = !profile && (draft.status === 'loading' || (!catalog || catalog.catalog.status === 'loading'));

    const confirmDiscard = React.useCallback(() => promptLaunchProfileUnsavedChanges(profile), [profile]);

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

    const saveLaunchProfile = useSaveLaunchProfile();
    const handleSave = async (savedProfile: AiLaunchProfile, secretBindings?: ProfileRecordV1['secretBindings']): Promise<boolean> => {
        if (!profile) return false;
        const lifetime = captureActiveServerAccountScopeLifetime();
        const saved = await saveLaunchProfile(savedProfile, secretBindings ?? draftSecretBindings,
            draft.status === 'ready' ? draft.legacyCloneSource : undefined);
        if (!saved || !mountedRef.current || !lifetime?.isCurrent()
            || !areServerAccountScopesEqual(lifetime.scope, profileScope)) return false;
        // Prevent the unsaved-changes guard from triggering on a successful save.
        isDirtyRef.current = false;
        setIsDirty(false);
        // Pass the saved profile back to the previous picker route (unmount-safe). A new profile
        // (including "Save as" from a built-in) is selected the same way, so /new never stacks on /new.
        const returnMode = setNewSessionPickerReturnParams({
            navigation: navigation as any,
            router,
            routeParams: {
                ...roundTripBackendParams,
                profileId: saved.profile.id,
            },
            currentParams: currentRouteParams,
            returnToHost,
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
        return true;
    };

    const handleCancel = useEventCallback(() => {
        void runUnsavedChangesGuard(
            unsavedChangesGuard,
            () => safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref }),
        );
    });

    const headerTitle = profile?.name ? t('profiles.editProfile') : t('profiles.addProfile');
    const headerBackTitle = t('common.back');

    const headerLeft = React.useCallback(() => {
        return (
            <HappierPressable
                onPress={handleCancel}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                style={({ pressed }) => ({
                    opacity: pressed ? motionTokens.press.opacity : 1,
                    padding: theme.space.s4,
                })}
            >
                <Icon name="x" size={24} color={theme.colors.chrome.header.foreground} />
            </HappierPressable>
        );
    }, [handleCancel, theme.colors.chrome.header.foreground]);

    const handleSavePress = React.useCallback(() => {
        saveRef.current?.();
    }, []);

    const headerRight = React.useCallback(() => {
        return (
            <HappierPressable
                onPress={handleSavePress}
                disabled={!isDirty}
                accessibilityRole="button"
                accessibilityLabel={t('common.save')}
                style={({ pressed }) => ({
                    opacity: !isDirty ? 0.35 : pressed ? motionTokens.press.opacity : 1,
                    padding: theme.space.s4,
                })}
            >
                <Icon name="check" size={24} color={theme.colors.chrome.header.foreground} />
            </HappierPressable>
        );
    }, [handleSavePress, isDirty, theme.colors.chrome.header.foreground]);

    const screenOptions = React.useMemo(() => {
        return {
            headerTitle,
            headerBackTitle,
            headerLeft,
            headerRight,
        } as const;
    }, [headerBackTitle, headerLeft, headerRight, headerTitle]);

    return (
        <PopoverScope>
            <NewSessionPickerRouteScreen options={screenOptions}>
                {/* The profile editor's keyboard-aware list owns keyboard avoidance for this screen. */}
                <View style={profileEditScreenStyles.container}>
                    <View style={[
                        { flex: 1, paddingHorizontal: screenWidth > 700 ? 16 : 8 }
                    ]}>
                        <View style={[
                            { maxWidth: layout.maxWidth, flex: 1, width: '100%', alignSelf: 'center' }
                        ]}>
                            {draft.status === 'migration' ? <LaunchProfileEditorMigration
                                key={JSON.stringify([profileScope, draft.profile.id])}
                                profile={draft.profile} onCancel={handleCancel}
                            /> : !profile ? <SurfaceStateCard
                                testID="profiles.edit.unavailable"
                                kind={loading ? 'loading' : 'unavailable'}
                                title={loading ? t('common.loading') : t('profilesPage.notFoundTitle')}
                                reason={loading ? undefined : t('profilesPage.notFoundDescription')}
                                diagnosticCode={draft.status === 'unavailable' ? draft.reason : undefined}
                                action={loading ? undefined : { label: t('common.back'), onPress: handleCancel }}
                            /> : <LaunchProfileEditForm
                                profile={profile}
                                draftSecretBindings={draftSecretBindings}
                                legacyCloneSource={draft.status === 'ready' ? draft.legacyCloneSource : undefined}
                                sourcePreservingClone={draft.status === 'ready' && draft.legacyCloneSource !== undefined}
                                machineId={machineIdParam || null}
                                onSave={handleSave}
                                onCancel={handleCancel}
                                onDirtyChange={setIsDirty}
                                saveRef={saveRef}
                            />}
                        </View>
                    </View>
                </View>
            </NewSessionPickerRouteScreen>
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
