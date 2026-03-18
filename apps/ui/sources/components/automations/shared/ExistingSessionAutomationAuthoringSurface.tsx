import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AutomationSettingsForm } from '@/components/automations/editor/AutomationSettingsForm';
import type { ExistingSessionAutomationAvailability } from '@/components/sessions/authoring/context/sessionAuthoringContext';
import { buildExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/buildExistingSessionAutomationAuthoringContext';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { updateSessionAuthoringDraftAutomation } from '@/components/sessions/authoring/draft/updateSessionAuthoringDraftFields';
import type { Session } from '@/sync/domains/state/storageTypes';

import { ExistingSessionAutomationComposer } from './ExistingSessionAutomationComposer';
import { ExistingSessionAutomationContextSection } from './ExistingSessionAutomationContextSection';
import { ExistingSessionAutomationUnavailableNotice } from './ExistingSessionAutomationUnavailableNotice';

const styles = StyleSheet.create(() => ({
    loadingContainer: {
        paddingHorizontal: 16,
        paddingVertical: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export function ExistingSessionAutomationAuthoringSurface(props: Readonly<{
    formVariant: 'create' | 'edit';
    session: Session | null;
    draft: SessionAuthoringDraft | null;
    onChangeDraft: React.Dispatch<React.SetStateAction<SessionAuthoringDraft | null>>;
    availability: ExistingSessionAutomationAvailability;
    isWaiting: boolean;
    unavailableReason: string | null;
    onSubmit: () => void;
    submitAccessibilityLabel: string;
    isSubmitDisabled: boolean;
    editable?: boolean;
}>): React.JSX.Element {
    const { theme } = useUnistyles();

    if (props.isWaiting) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (props.unavailableReason) {
        return <ExistingSessionAutomationUnavailableNotice reason={props.unavailableReason} />;
    }

    if (!props.session || !props.draft || !props.draft.automation) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    const context = buildExistingSessionAutomationAuthoringContext({
        session: props.session,
        draft: props.draft,
        availability: props.availability,
    });

    return (
        <>
            <AutomationSettingsForm
                variant={props.formVariant}
                value={props.draft.automation}
                onChange={(next) => {
                    props.onChangeDraft((current) => current ? updateSessionAuthoringDraftAutomation(current, next) : current);
                }}
            />
            <ExistingSessionAutomationContextSection context={context} />
            <ExistingSessionAutomationComposer
                context={context}
                onChangeDraft={props.onChangeDraft}
                onSubmit={props.onSubmit}
                submitAccessibilityLabel={props.submitAccessibilityLabel}
                isSubmitDisabled={props.isSubmitDisabled}
                editable={props.editable}
            />
        </>
    );
}
