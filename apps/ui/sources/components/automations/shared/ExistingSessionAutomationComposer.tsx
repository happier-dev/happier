import React from 'react';

import { getAgentCore } from '@/agents/catalog/catalog';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
    updateSessionAuthoringDraftModelMode,
    updateSessionAuthoringDraftPermissionMode,
    updateSessionAuthoringDraftPrompt,
} from '@/components/sessions/authoring/draft/updateSessionAuthoringDraftFields';
import type { ExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/sessionAuthoringContext';
import { Modal } from '@/modal';
import { nowServerMs } from '@/sync/runtime/time';
import { t, tLoose } from '@/text';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export function ExistingSessionAutomationComposer(props: Readonly<{
    context: ExistingSessionAutomationAuthoringContext;
    onChangeDraft: React.Dispatch<React.SetStateAction<SessionAuthoringDraft | null>>;
    onSubmit: () => void;
    submitAccessibilityLabel: string;
    isSubmitDisabled: boolean;
    editable?: boolean;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
}>): React.JSX.Element {
    const composerState = resolveSessionComposerStateFromAuthoringContext(props.context);
    const profileId = composerState.profileId;
    const ownerMetadata = readSessionOwnerMetadataView(props.context.session);

    return (
        <AgentInput
            value={props.context.draft.prompt}
            onChangeText={(value) => {
                props.onChangeDraft((current) => current ? updateSessionAuthoringDraftPrompt(current, value) : current);
            }}
            onSend={props.onSubmit}
            isSendDisabled={props.isSubmitDisabled}
            submitAccessibilityLabel={props.submitAccessibilityLabel}
            placeholder={t('automations.edit.messagePlaceholder')}
            autocompletePrefixes={['@', '/']}
            autocompleteSuggestions={(query) => getSuggestions(props.context.session.id, query)}
            sessionId={props.context.session.id}
            metadata={ownerMetadata}
            agentType={composerState.agentId ?? undefined}
            agentLabel={composerState.agentId ? t(getAgentCore(composerState.agentId).displayNameKey) : tLoose('common.unknown')}
            permissionMode={composerState.permissionMode}
            onPermissionModeChange={(mode) => {
                props.onChangeDraft((current) => current
                    ? updateSessionAuthoringDraftPermissionMode(current, mode, nowServerMs())
                    : current);
            }}
            modelMode={composerState.modelMode}
            onModelModeChange={(mode) => {
                props.onChangeDraft((current) => current
                    ? updateSessionAuthoringDraftModelMode(current, mode, nowServerMs())
                    : current);
            }}
            machineName={composerState.machineName}
            currentPath={props.context.draft.directory}
            profileId={profileId}
            onProfileClick={profileId
                ? () => {
                    void Modal.alert(
                        t('profiles.title'),
                        `${t('profiles.sessionUses', { profile: profileId })}\n\n${t('profiles.profilesFixedPerSession')}`,
                    );
                }
                : undefined}
            contentPaddingHorizontal={0}
            disabled={props.editable === false}
            extraActionChips={props.extraActionChips}
        />
    );
}
