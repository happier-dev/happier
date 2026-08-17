import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { buildAutomationScheduleInputFromForm } from '@/components/automations/editor/buildAutomationScheduleInputFromForm';
import { ExistingSessionAutomationAuthoringSurface } from '@/components/automations/shared/ExistingSessionAutomationAuthoringSurface';
import { getExistingSessionAutomationUnavailableReason } from '@/components/automations/shared/existingSessionAutomationAvailabilityUi';
import { Text } from '@/components/ui/text/Text';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { isSessionRouteHydrationAvailable } from '@/sync/domains/session/sessionRouteHydrationState';
import { Modal } from '@/modal';
import { useAutomation, useSession, useSettings } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { updateExistingSessionAutomationTemplateMessage } from '@/sync/domains/automations/automationExistingSessionTemplateUpdate';
import { readLegacyScheduleAutomationDefinition } from '@/sync/domains/automations/automationLegacyScheduleDefinition';
import { tryGetAutomationLinkedExistingSessionId } from '@/sync/domains/automations/automationSessionLink';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import {
    buildAutomationEditTemplateSeed,
    buildExistingSessionAutomationFallbackDraft,
    buildNewSessionTempDataFromAuthoringDraft,
    mergeExistingSessionAutomationTemplateDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { useSessionAuthoringDraftState } from '@/components/sessions/authoring/draft/useSessionAuthoringDraftState';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import { resolveExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import { isAutomationSettingsDraftValid } from '@/sync/domains/automations/isAutomationSettingsDraftValid';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { readProviderSettingsFromAccountSettingsV1 } from '@happier-dev/protocol';
import { readUiAiLaunchProfiles } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { isAutomationTemplateEncryptionMaterialUnavailableError } from '@/sync/domains/automations/automationTemplateAvailability';
import { Icon } from '@/components/ui/icons/Icon';
import { readPluginEventAutomationEditSeed } from '@/components/automations/editor/pluginEventAutomationEditSeed';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';

async function showAutomationTemplateError(
    error: unknown,
    fallbackKey: 'automations.edit.loadTemplateFailed' | 'automations.edit.updateFailed',
): Promise<void> {
    if (isAutomationTemplateEncryptionMaterialUnavailableError(error)) {
        await Modal.alert(
            t('settingsAccount.restoreRequiredTitle'),
            t('settingsAccount.secretKeyMissing'),
        );
        return;
    }
    await Modal.alert(
        t('common.error'),
        error instanceof Error ? error.message : t(fallbackKey),
    );
}

function isExistingSessionAutomationEditDraftValid(params: Readonly<{
    draft: SessionAuthoringDraft | null;
    targetType: 'new_session' | 'existing_session' | null;
    availabilityKind: ReturnType<typeof resolveExistingSessionAutomationAvailability>['kind'] | null;
    messageLoading: boolean;
}>): boolean {
    const automationDraft = params.draft?.automation;
    const messageOk = params.targetType !== 'existing_session' || (params.draft?.prompt ?? '').trim().length > 0;
    const existingSessionOk = params.targetType !== 'existing_session'
        || params.availabilityKind === 'ready';
    return isAutomationSettingsDraftValid(automationDraft)
        && messageOk
        && existingSessionOk
        && !params.messageLoading
        && params.availabilityKind !== 'hydrating';
}

export default React.memo(function AutomationEditScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ id?: string }>();
    const automationId = typeof params.id === 'string' ? params.id : '';
    const definition = useAutomation(automationId);
    const automation = React.useMemo(
        () => readLegacyScheduleAutomationDefinition(definition),
        [definition],
    );
    const eventAutomationEditSeed = React.useMemo(
        () => readPluginEventAutomationEditSeed(definition),
        [definition],
    );
    const isLoadingAutomationDefinition = !definition || definition.detail.kind === 'unloaded';
    const [detailLoadError, setDetailLoadError] = React.useState(false);
    const settings = useSettings();
    const launchProfileContext = React.useMemo(() => ({
        profiles: readUiAiLaunchProfiles(settings.profiles),
        migration: readProviderSettingsFromAccountSettingsV1({
            providerSettingsV1: settings.providerSettingsV1,
        }).settings.migration,
    }), [settings.profiles, settings.providerSettingsV1]);
    const existingSessionId = React.useMemo(() => {
        return automation ? tryGetAutomationLinkedExistingSessionId(automation) : null;
    }, [automation?.targetType, automation?.linkedExistingSessionId]);
    const existingSessionHydrationState = useHydrateSessionForRoute(existingSessionId ?? '', 'AutomationEditScreen.hydrateExistingSession');
    const existingSessionHydrated = isSessionRouteHydrationAvailable(existingSessionHydrationState);
    const targetSession = useSession(existingSessionId ?? '');
    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(existingSessionId ?? '');
    const existingSessionMachineIdOverride = existingSessionId
        ? readMachineControlTargetForSession(existingSessionId)?.machineId ?? null
        : null;
    const existingSessionAvailability = React.useMemo(() => {
        if (automation?.targetType !== 'existing_session') return null;
        return resolveExistingSessionAutomationAvailability({
            sessionHydrated: existingSessionHydrated,
            session: targetSession,
            machineIdOverride: existingSessionMachineIdOverride,
            sessionDekBase64,
            accountSettings: settings,
        });
    }, [automation?.targetType, existingSessionHydrated, existingSessionMachineIdOverride, sessionDekBase64, settings, targetSession]);

    const { draft, setDraft, latestDraftRef } = useSessionAuthoringDraftState();
    const [messageLoading, setMessageLoading] = React.useState(false);
    const redirectInitializedRef = React.useRef(false);
    const isWaitingForExistingSessionHydration = existingSessionAvailability?.kind === 'hydrating';

    React.useEffect(() => {
        if (!automationId || !isLoadingAutomationDefinition) return;
        let alive = true;
        setDetailLoadError(false);
        fireAndForget((async () => {
            try {
                await sync.refreshAutomationDefinitionDetail(automationId);
            } catch {
                if (alive) setDetailLoadError(true);
            }
        })(), { tag: 'AutomationEditScreen.loadDefinitionDetail' });
        return () => {
            alive = false;
        };
    }, [automationId, isLoadingAutomationDefinition]);

    React.useEffect(() => {
        if (!eventAutomationEditSeed || redirectInitializedRef.current) return;
        redirectInitializedRef.current = true;

        const target = eventAutomationEditSeed.target;
        const dataId = storeTempData({
            prompt: eventAutomationEditSeed.prompt,
            ...(target.kind === 'newSession'
                ? {
                    machineId: target.spawn.executionTarget.machineId,
                    directory: target.spawn.directory,
                }
                : {}),
            ...(target.kind === 'existingSession'
                ? {
                    eventAutomationExistingSessionServerId:
                        resolveServerIdForSessionIdFromLocalCache(target.sessionId),
                }
                : {}),
            automationDraft: {
                enabled: eventAutomationEditSeed.enabled,
                name: eventAutomationEditSeed.name,
                description: eventAutomationEditSeed.description ?? '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            },
            eventAutomationEditSeed,
        });
        navigateWithBlurOnWeb(() => {
            router.replace(`/new?automation=1&automationEditId=${automationId}&dataId=${dataId}` as any);
        });
    }, [automationId, eventAutomationEditSeed, router]);

    React.useEffect(() => {
        if (!automation || automation.targetType !== 'new_session' || redirectInitializedRef.current) return;
        redirectInitializedRef.current = true;

        fireAndForget((async () => {
            try {
                setMessageLoading(true);
                const { hydratedDraft, seededAutomationDraft } = await buildAutomationEditTemplateSeed({
                    automation,
                    ...(sync.encryption
                        ? {
                            decryptAutomationTemplateRaw: (payloadCiphertext: string) =>
                                sync.encryption!.decryptAutomationTemplateRaw(payloadCiphertext),
                        }
                        : {}),
                    launchProfileContext,
                });
                const assignments = automation.assignments;
                const enabledAssignment = assignments.find((assignment) => assignment.enabled) ?? assignments[0] ?? null;
                const dataId = storeTempData(buildNewSessionTempDataFromAuthoringDraft({
                    draft: {
                        ...hydratedDraft,
                        automation: seededAutomationDraft,
                    },
                    machineId: typeof enabledAssignment?.machineId === 'string' ? enabledAssignment.machineId : null,
                }));

                navigateWithBlurOnWeb(() => {
                    router.replace(`/new?automation=1&automationEditId=${automationId}&dataId=${dataId}` as any);
                });
            } catch (error) {
                await showAutomationTemplateError(error, 'automations.edit.loadTemplateFailed');
            } finally {
                setMessageLoading(false);
            }
        })(), { tag: 'AutomationEditScreen.redirectNewSessionAutomationToSharedComposer' });
    }, [automation, automationId, launchProfileContext, router]);

    React.useEffect(() => {
        if (!automation || automation.targetType !== 'existing_session') return;
        let alive = true;
        fireAndForget((async () => {
            try {
                setMessageLoading(true);
                const { hydratedDraft: hydratedTemplateDraft, seededAutomationDraft } = await buildAutomationEditTemplateSeed({
                    automation,
                    ...(sync.encryption
                        ? {
                            decryptAutomationTemplateRaw: (payloadCiphertext: string) =>
                                sync.encryption!.decryptAutomationTemplateRaw(payloadCiphertext),
                        }
                        : {}),
                    launchProfileContext,
                });
                if (!alive) return;
                setDraft((current) => {
                    return mergeExistingSessionAutomationTemplateDraft({
                        hydratedTemplateDraft,
                        targetSession,
                        currentDraft: current,
                        sessionDekBase64,
                        seededAutomationDraft,
                    });
                });
            } catch (error) {
                if (!alive) return;
                await showAutomationTemplateError(error, 'automations.edit.loadTemplateFailed');
            } finally {
                if (!alive) return;
                setMessageLoading(false);
            }
        })(), { tag: 'AutomationEditScreen.loadExistingSessionTemplateMessage' });
        return () => {
            alive = false;
        };
    }, [automation, launchProfileContext, sessionDekBase64, targetSession]);

    const isValid = React.useMemo(() => isExistingSessionAutomationEditDraftValid({
        draft,
        targetType: automation?.targetType ?? null,
        availabilityKind: existingSessionAvailability?.kind ?? null,
        messageLoading,
    }), [automation?.targetType, draft, existingSessionAvailability?.kind, messageLoading]);

    const unavailableReason = React.useMemo(() => {
        if (automation?.targetType !== 'existing_session') return null;
        if (!existingSessionAvailability) return null;
        return getExistingSessionAutomationUnavailableReason(existingSessionAvailability);
    }, [automation?.targetType, existingSessionAvailability]);

    const handleSave = React.useCallback(async () => {
        const currentDraft = latestDraftRef.current;
        if (!automationId || !automation) return;
        if (!isExistingSessionAutomationEditDraftValid({
            draft: currentDraft,
            targetType: automation.targetType,
            availabilityKind: existingSessionAvailability?.kind ?? null,
            messageLoading,
        })) {
            return;
        }
        const currentAutomationDraft = currentDraft?.automation;
        if (!currentAutomationDraft) return;
        try {
            const encryption = sync.encryption;
            const templateCiphertext = automation.targetType === 'existing_session'
                ? await updateExistingSessionAutomationTemplateMessage({
                    templateCiphertext: automation.templateCiphertext,
                    message: currentDraft?.prompt ?? '',
                    draft: currentDraft ?? undefined,
                    ...(encryption
                        ? {
                            decryptRaw: (payloadCiphertext) => encryption.decryptAutomationTemplateRaw(payloadCiphertext),
                            encryptRaw: (value) => encryption.encryptAutomationTemplateRaw(value),
                        }
                        : {}),
                    fallbackDraft: buildExistingSessionAutomationFallbackDraft({
                        targetSession,
                        message: currentDraft?.prompt ?? '',
                        sessionDekBase64,
                    }) ?? undefined,
                })
                : undefined;
            await sync.updateAutomation(automationId, {
                enabled: currentAutomationDraft.enabled,
                name: currentAutomationDraft.name.trim() || automation.name,
                description: currentAutomationDraft.description.trim().length > 0 ? currentAutomationDraft.description.trim() : null,
                schedule: buildAutomationScheduleInputFromForm(currentAutomationDraft),
                ...(templateCiphertext ? { templateCiphertext } : {}),
            });
            await sync.refreshAutomations();
            navigateWithBlurOnWeb(() => router.replace(`/automations/${automationId}` as any));
        } catch (error) {
            await showAutomationTemplateError(error, 'automations.edit.updateFailed');
        }
    }, [automation, automationId, existingSessionAvailability?.kind, messageLoading, router, sessionDekBase64, targetSession]);

    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={() => {
                navigateWithBlurOnWeb(() => router.replace(`/automations/${automationId}` as any));
            }}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Icon name="caret-left" size={20} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    ), [automationId, router, theme.colors.chrome.header.foreground]);

    const headerRight = React.useCallback(() => null, []);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        title: t('automations.edit.title'),
        headerBackTitle: t('common.back'),
        presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
        headerLeft,
        headerRight,
    }), [headerLeft, headerRight]);

    return (
        <AutomationsGate>
            <>
                <Stack.Screen options={screenOptions} />
                <ItemList>
                    <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                        {isWaitingForExistingSessionHydration ? (
                            <View style={stylesMessage.loadingContainer}>
                                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                            </View>
                        ) : null}
                        {isLoadingAutomationDefinition ? (
                            <View style={stylesMessage.loadingContainer}>
                                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                            </View>
                        ) : null}
                        {!isLoadingAutomationDefinition && !automation ? (
                            <View style={stylesMessage.loadingContainer}>
                                <Text style={stylesMessage.unavailable}>
                                    {detailLoadError ? t('automations.edit.loadTemplateFailed') : t('common.unavailable')}
                                </Text>
                            </View>
                        ) : null}
                        {automation?.targetType === 'new_session' && !isLoadingAutomationDefinition && !isWaitingForExistingSessionHydration ? (
                            <View style={stylesMessage.loadingContainer}>
                                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                            </View>
                        ) : null}
                        {automation?.targetType === 'existing_session' && existingSessionAvailability ? (
                    <ExistingSessionAutomationAuthoringSurface
                        formVariant="edit"
                        session={targetSession}
                        draft={draft}
                        onChangeDraft={setDraft}
                                availability={existingSessionAvailability}
                                isWaiting={isWaitingForExistingSessionHydration}
                                unavailableReason={unavailableReason}
                                onSubmit={() => { void handleSave(); }}
                                submitAccessibilityLabel={t('automations.edit.saveAutomationLabel')}
                                isSubmitDisabled={!isValid}
                                editable={!messageLoading}
                            />
                        ) : null}
                    </View>
                </ItemList>
            </>
        </AutomationsGate>
    );
});

const stylesMessage = StyleSheet.create(() => ({
    loadingContainer: {
        paddingHorizontal: 16,
        paddingVertical: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unavailable: {
        textAlign: 'center',
    },
}));
