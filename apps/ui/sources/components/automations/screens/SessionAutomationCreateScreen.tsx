import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { buildAutomationScheduleInputFromForm } from '@/components/automations/editor/buildAutomationScheduleInputFromForm';
import { ExistingSessionAutomationAuthoringSurface } from '@/components/automations/shared/ExistingSessionAutomationAuthoringSurface';
import { getExistingSessionAutomationUnavailableReason } from '@/components/automations/shared/existingSessionAutomationAvailabilityUi';
import { resolveExistingSessionAutomationAvailability } from '@/components/automations/shared/resolveExistingSessionAutomationAvailability';
import { buildExistingSessionAuthoringDraftFromSession } from '@/components/sessions/authoring/draft/buildExistingSessionAuthoringDraftFromSession';
import { buildAutomationTemplateFromSessionAuthoringDraft } from '@/components/sessions/authoring/draft/buildAutomationTemplateFromSessionAuthoringDraft';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { useSessionAuthoringDraftState } from '@/components/sessions/authoring/draft/useSessionAuthoringDraftState';
import { Modal } from '@/modal';
import { DEFAULT_NEW_SESSION_AUTOMATION_DRAFT, sanitizeNewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { encodeAutomationTemplateCiphertextForAccount } from '@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount';
import { normalizeAutomationDescription, normalizeAutomationName, validateAutomationTemplateTarget } from '@/sync/domains/automations/automationValidation';
import { useSession, useSettings } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
}));

export function SessionAutomationCreateScreen(props: { sessionId: string }) {
    const styles = stylesheet;
    const router = useRouter();
    const session = useSession(props.sessionId);
    const settings = useSettings();
    const { draft, setDraft, latestDraftRef } = useSessionAuthoringDraftState();
    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(props.sessionId);
    const machineIdOverride = readMachineTargetForSession(props.sessionId)?.machineId ?? null;

    const availability = React.useMemo(() => resolveExistingSessionAutomationAvailability({
        session,
        machineIdOverride,
        sessionDekBase64,
        accountSettings: settings,
    }), [machineIdOverride, session, sessionDekBase64, settings]);

    React.useEffect(() => {
        if (!session) return;
        setDraft((current) => {
            if (current) {
                if (current.automation) return current;
                return {
                    ...current,
                    automation: sanitizeNewSessionAutomationDraft(DEFAULT_NEW_SESSION_AUTOMATION_DRAFT),
                };
            }

            return {
                ...buildExistingSessionAuthoringDraftFromSession({
                    session,
                    message: '',
                    sessionDekBase64,
                }),
                automation: sanitizeNewSessionAutomationDraft(DEFAULT_NEW_SESSION_AUTOMATION_DRAFT),
            } satisfies SessionAuthoringDraft;
        });
    }, [session, sessionDekBase64, setDraft]);

    const currentDraft = latestDraftRef.current ?? draft;
    const missingReason = React.useMemo(
        () => getExistingSessionAutomationUnavailableReason(availability),
        [availability],
    );
    const isValid = Boolean(currentDraft?.automation)
        && availability.kind === 'ready'
        && (currentDraft?.prompt.trim().length ?? 0) > 0;

    const handleCreate = React.useCallback(async () => {
        const current = latestDraftRef.current;
        if (!session || !current || availability.kind !== 'ready') return;
        if (!current.automation || current.prompt.trim().length === 0) return;

        try {
            const credentials = sync.getCredentials();
            const template = buildAutomationTemplateFromSessionAuthoringDraft(current);
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
                name: normalizeAutomationName(current.automation.name),
                description: normalizeAutomationDescription(current.automation.description),
                enabled: current.automation.enabled,
                schedule: buildAutomationScheduleInputFromForm(current.automation),
                targetType: 'existing_session',
                templateCiphertext,
                assignments: [{ machineId: availability.machineId, enabled: true, priority: 100 }],
            });
            await sync.refreshAutomations();
            deferOnWeb(() => router.replace(`/session/${props.sessionId}/automations` as any));
        } catch (error) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.create.createFailed')
            );
        }
    }, [availability, latestDraftRef, props.sessionId, router, session]);

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
                        isWaiting={false}
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
