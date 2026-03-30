import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { canCreateNewSession } from '@/components/sessions/new/modules/canCreateNewSession';
import {
    resolveEffectiveAutomationDraft,
    shouldShowAutomationActionChips,
} from '@/components/sessions/new/modules/automationFeatureGate';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { Machine } from '@/sync/domains/state/storageTypes';

import type {
    NewSessionAuthoringContext,
    NewSessionAuthoringSubmissionMode,
    NewSessionSubmitAccessibilityLabelKey,
} from './sessionAuthoringContext';

function resolveSubmissionMode(params: Readonly<{
    effectiveAutomationDraft: NewSessionAutomationDraft;
    automationEditId: string | null;
}>): NewSessionAuthoringSubmissionMode {
    if (!params.effectiveAutomationDraft.enabled) {
        return 'launch';
    }
    return params.automationEditId ? 'editAutomation' : 'createAutomation';
}

function resolveSubmitAccessibilityLabelKey(
    submissionMode: NewSessionAuthoringSubmissionMode,
): NewSessionSubmitAccessibilityLabelKey | undefined {
    if (submissionMode === 'editAutomation') {
        return 'automations.edit.saveAutomationLabel';
    }
    if (submissionMode === 'createAutomation') {
        return 'automations.create.createButtonTitle';
    }
    return undefined;
}

export function buildNewSessionAuthoringContext(params: Readonly<{
    automationDraft: NewSessionAutomationDraft;
    automationFeatureEnabled: boolean;
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    selectedPath: string;
    automationEditId: string | null;
    buildDraft: (effectiveAutomationDraft: NewSessionAutomationDraft) => SessionAuthoringDraft;
}>): NewSessionAuthoringContext {
    const effectiveAutomationDraft = resolveEffectiveAutomationDraft({
        draft: params.automationDraft,
        automationsEnabled: params.automationFeatureEnabled,
    });
    const submissionMode = resolveSubmissionMode({
        effectiveAutomationDraft,
        automationEditId: params.automationEditId,
    });

    return {
        kind: 'newSession',
        draft: params.buildDraft(effectiveAutomationDraft),
        effectiveAutomationDraft,
        showAutomationActionChips: shouldShowAutomationActionChips({
            automationsEnabled: params.automationFeatureEnabled,
        }),
        canSubmit: canCreateNewSession({
            selectedMachineId: params.selectedMachineId,
            selectedMachine: params.selectedMachine,
            selectedPath: params.selectedPath,
            allowOfflineMachine: effectiveAutomationDraft.enabled,
        }),
        submissionMode,
        submitAccessibilityLabelKey: resolveSubmitAccessibilityLabelKey(submissionMode),
    };
}
