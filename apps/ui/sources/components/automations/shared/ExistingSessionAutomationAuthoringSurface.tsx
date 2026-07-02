import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { ExistingSessionAutomationComposer } from '@/components/automations/shared/ExistingSessionAutomationComposer';
import { ExistingSessionAutomationContextSection } from '@/components/automations/shared/ExistingSessionAutomationContextSection';
import { ExistingSessionAutomationUnavailableNotice } from '@/components/automations/shared/ExistingSessionAutomationUnavailableNotice';
import { createAutomationToggleActionChip } from '@/components/sessions/agentInput/definitions/createAutomationToggleActionChip';
import { buildExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/buildExistingSessionAutomationAuthoringContext';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { updateSessionAuthoringDraftAutomation } from '@/components/sessions/authoring/draft/updateSessionAuthoringDraftFields';
import { getAutomationChipLabel } from '@/components/sessions/new/modules/automationChipModel';
import type { ExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import type { Session } from '@/sync/domains/state/storageTypes';

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
    const automationDraft = props.draft?.automation ?? null;
    const automationActionChip = React.useMemo(() => {
        if (!automationDraft) return null;
        return createAutomationToggleActionChip({
            enabled: automationDraft.enabled,
            label: getAutomationChipLabel(automationDraft),
            value: automationDraft,
            onChange: (next) => {
                props.onChangeDraft((current) => current ? updateSessionAuthoringDraftAutomation(current, next) : current);
            },
        });
    }, [automationDraft, props.onChangeDraft]);

    if (props.isWaiting) {
        return (
            <View style={styles.loadingContainer}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            </View>
        );
    }

    if (props.unavailableReason) {
        return <ExistingSessionAutomationUnavailableNotice reason={props.unavailableReason} />;
    }

    const authoringContext = props.session && props.draft
        ? buildExistingSessionAutomationAuthoringContext({
            session: props.session,
            draft: props.draft,
            availability: props.availability,
            sessionDekBase64: props.draft.sessionEncryptionKeyBase64,
        })
        : null;

    return (
        <>
            {authoringContext ? (
                <ExistingSessionAutomationContextSection
                    context={authoringContext}
                />
            ) : null}
            {authoringContext ? (
                <ExistingSessionAutomationComposer
                    context={authoringContext}
                    onChangeDraft={props.onChangeDraft}
                    onSubmit={props.onSubmit}
                    submitAccessibilityLabel={props.submitAccessibilityLabel}
                    isSubmitDisabled={props.isSubmitDisabled}
                    editable={props.editable}
                    extraActionChips={automationActionChip ? [automationActionChip] : undefined}
                />
            ) : null}
        </>
    );
}
