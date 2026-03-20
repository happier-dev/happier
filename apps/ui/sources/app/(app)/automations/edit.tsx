import React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { buildAutomationScheduleInputFromForm } from '@/components/automations/editor/buildAutomationScheduleInputFromForm';
import { ExistingSessionAutomationAuthoringSurface } from '@/components/automations/shared/ExistingSessionAutomationAuthoringSurface';
import { getExistingSessionAutomationUnavailableReason } from '@/components/automations/shared/existingSessionAutomationAvailabilityUi';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { Modal } from '@/modal';
import { useAutomation, useSession, useSettings } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { updateExistingSessionAutomationTemplateMessage } from '@/sync/domains/automations/automationExistingSessionTemplateUpdate';
import {
    tryReadAutomationTemplateEnvelopeExistingSessionId,
} from '@/sync/domains/automations/automationTemplateTransport';
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
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

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
    const automation = useAutomation(automationId);
    const settings = useSettings();
    const existingSessionId = React.useMemo(() => {
        if (automation?.targetType !== 'existing_session') return null;
        return tryReadAutomationTemplateEnvelopeExistingSessionId(automation.templateCiphertext);
    }, [automation?.targetType, automation?.templateCiphertext]);
    const existingSessionHydrated = useHydrateSessionForRoute(existingSessionId ?? '', 'AutomationEditScreen.hydrateExistingSession');
    const targetSession = useSession(existingSessionId ?? '');
    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(existingSessionId ?? '');
    const existingSessionMachineIdOverride = existingSessionId
        ? readMachineTargetForSession(existingSessionId)?.machineId ?? null
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
        if (!automation || automation.targetType !== 'new_session' || redirectInitializedRef.current) return;
        redirectInitializedRef.current = true;

        fireAndForget((async () => {
            try {
                setMessageLoading(true);
                const { hydratedDraft, seededAutomationDraft } = await buildAutomationEditTemplateSeed({
                    automation,
                    decryptAutomationTemplateRaw: (payloadCiphertext) =>
                        sync.encryption.decryptAutomationTemplateRaw(payloadCiphertext),
                });
                const assignments = Array.isArray((automation as any).assignments) ? (automation as any).assignments : [];
                const enabledAssignment = assignments.find((assignment: any) => assignment?.enabled !== false) ?? assignments[0] ?? null;
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
                await Modal.alert(
                    t('common.error'),
                    error instanceof Error ? error.message : t('automations.edit.loadTemplateFailed'),
                );
            } finally {
                setMessageLoading(false);
            }
        })(), { tag: 'AutomationEditScreen.redirectNewSessionAutomationToSharedComposer' });
    }, [automation, automationId, router]);

    React.useEffect(() => {
        if (!automation || automation.targetType !== 'existing_session') return;
        let alive = true;
        fireAndForget((async () => {
            try {
                setMessageLoading(true);
                const { hydratedDraft: hydratedTemplateDraft, seededAutomationDraft } = await buildAutomationEditTemplateSeed({
                    automation,
                    decryptAutomationTemplateRaw: (payloadCiphertext) =>
                        sync.encryption.decryptAutomationTemplateRaw(payloadCiphertext),
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
                await Modal.alert(
                    t('common.error'),
                    error instanceof Error ? error.message : t('automations.edit.loadTemplateFailed'),
                );
            } finally {
                if (!alive) return;
                setMessageLoading(false);
            }
        })(), { tag: 'AutomationEditScreen.loadExistingSessionTemplateMessage' });
        return () => {
            alive = false;
        };
    }, [automation, sessionDekBase64, targetSession]);

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
            const templateCiphertext = automation.targetType === 'existing_session'
                ? await updateExistingSessionAutomationTemplateMessage({
                    templateCiphertext: automation.templateCiphertext,
                    message: currentDraft?.prompt ?? '',
                    draft: currentDraft ?? undefined,
                    decryptRaw: (payloadCiphertext) => sync.encryption.decryptAutomationTemplateRaw(payloadCiphertext),
                    encryptRaw: (value) => sync.encryption.encryptAutomationTemplateRaw(value),
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
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.edit.updateFailed')
            );
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
            <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
        </Pressable>
    ), [automationId, router, theme.colors.header.tint]);

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
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            </View>
                        ) : null}
                        {automation?.targetType === 'new_session' && !isWaitingForExistingSessionHydration ? (
                            <View style={stylesMessage.loadingContainer}>
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
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
}));
