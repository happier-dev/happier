import React from 'react';

import { getAgentCore } from '@/agents/catalog/catalog';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import { AgentInput } from '@/components/sessions/agentInput';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
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
import { t } from '@/text';

// R-9: automation composers offer file/plugin references and slash commands only. No $ skills.
const AUTOMATION_COMPOSER_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'vendorPlugin', 'slashCommand'];

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
            autocompleteKinds={AUTOMATION_COMPOSER_SUGGESTION_KINDS}
            autocompleteSuggestions={(query, signal) => resolveSessionComposerSuggestions(props.context.session.id, query, {
                kinds: AUTOMATION_COMPOSER_SUGGESTION_KINDS,
                signal,
            })}
            sessionId={props.context.session.id}
            metadata={props.context.session.metadata}
            agentType={composerState.agentId}
            agentLabel={t(getAgentCore(composerState.agentId).displayNameKey)}
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
