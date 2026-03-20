import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { buildAutomationScheduleInputFromForm } from '@/components/automations/editor/buildAutomationScheduleInputFromForm';
import { ExistingSessionAutomationAuthoringSurface } from '@/components/automations/shared/ExistingSessionAutomationAuthoringSurface';
import { getExistingSessionAutomationUnavailableReason } from '@/components/automations/shared/existingSessionAutomationAvailabilityUi';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    refreshExistingSessionAuthoringDraftFromSessionSnapshot,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { useSessionAuthoringDraftState } from '@/components/sessions/authoring/draft/useSessionAuthoringDraftState';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { Modal } from '@/modal';
import { useSession, useSettings } from '@/sync/domains/state/storage';
import { resolveExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import { normalizeAutomationDescription, normalizeAutomationName, validateAutomationTemplateTarget } from '@/sync/domains/automations/automationValidation';
import { isAutomationSettingsDraftValid } from '@/sync/domains/automations/isAutomationSettingsDraftValid';
import { sanitizeNewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { encodeAutomationTemplateCiphertextForAccount } from '@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
}));

function isExistingSessionAutomationCreateDraftValid(
    draft: SessionAuthoringDraft | null,
    availabilityKind: ReturnType<typeof resolveExistingSessionAutomationAvailability>['kind'],
): boolean {
    const automationDraft = draft?.automation;
    const messageOk = (draft?.prompt ?? '').trim().length > 0;
    return isAutomationSettingsDraftValid(automationDraft) && messageOk && availabilityKind === 'ready';
}

export function SessionAutomationCreateScreen(props: { sessionId: string }) {
    useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const sessionHydrated = useHydrateSessionForRoute(props.sessionId, 'SessionAutomationCreateScreen.hydrateTargetSession');
    const session = useSession(props.sessionId);
    const settings = useSettings();

    const { draft, setDraft, latestDraftRef } = useSessionAuthoringDraftState();

    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(props.sessionId);
    const machineIdOverride = readMachineTargetForSession(props.sessionId)?.machineId ?? null;
    const availability = React.useMemo(() => resolveExistingSessionAutomationAvailability({
        sessionHydrated,
        session,
        machineIdOverride,
        sessionDekBase64,
        accountSettings: settings,
    }), [machineIdOverride, session, sessionDekBase64, sessionHydrated, settings]);
    const machineId = availability.kind === 'ready' ? availability.machineId : null;

    React.useEffect(() => {
        if (!session) return;
        setDraft((current) => {
            const defaultAutomationDraft = sanitizeNewSessionAutomationDraft({
                enabled: true,
                name: t('automations.create.defaultName'),
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            });
            return refreshExistingSessionAuthoringDraftFromSessionSnapshot({
                session,
                currentDraft: current,
                sessionDekBase64,
                fallbackAutomationDraft: defaultAutomationDraft,
            });
        });
    }, [session, sessionDekBase64]);

    const isValid = React.useMemo(
        () => isExistingSessionAutomationCreateDraftValid(draft, availability.kind),
        [availability.kind, draft],
    );

    const handleCreate = React.useCallback(async () => {
        const currentDraft = latestDraftRef.current;
        if (!session || !machineId || !currentDraft) return;
        if (!isExistingSessionAutomationCreateDraftValid(currentDraft, availability.kind)) return;
        const currentAutomationDraft = currentDraft.automation;
        if (!currentAutomationDraft) return;
        try {
            const credentials = sync.getCredentials();
            const template = buildAutomationTemplateFromSessionAuthoringDraft(currentDraft);
            validateAutomationTemplateTarget({
                targetType: 'existing_session',
                template,
            });
            const templateCiphertext = await encodeAutomationTemplateCiphertextForAccount({
                credentials,
                template,
                encryptRaw: (value) => sync.encryption.encryptAutomationTemplateRaw(value),
            });

            await sync.createAutomation({
                name: normalizeAutomationName(currentAutomationDraft.name),
                description: normalizeAutomationDescription(currentAutomationDraft.description),
                enabled: currentAutomationDraft.enabled,
                schedule: buildAutomationScheduleInputFromForm(currentAutomationDraft),
                targetType: 'existing_session',
                templateCiphertext,
                assignments: [{ machineId, enabled: true, priority: 100 }],
            });
            navigateWithBlurOnWeb(() => router.replace(`/session/${props.sessionId}/automations` as any));
        } catch (error) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.create.createFailed')
            );
        }
    }, [availability.kind, machineId, props.sessionId, router, session]);

    const missingReason = React.useMemo(() => getExistingSessionAutomationUnavailableReason(availability), [availability]);
    const isWaitingForSessionHydration = availability.kind === 'hydrating';

    return (
        <View style={styles.container}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <ExistingSessionAutomationAuthoringSurface
                        formVariant="create"
                        session={session}
                        draft={draft}
                        onChangeDraft={setDraft}
                        availability={availability}
                        isWaiting={isWaitingForSessionHydration}
                        unavailableReason={missingReason}
                        onSubmit={() => { void handleCreate(); }}
                        submitAccessibilityLabel={t('automations.create.createButtonTitle')}
                        isSubmitDisabled={!isValid}
                    />
                </View>
            </ItemList>
        </View>
    );
}
