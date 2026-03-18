import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

export function updateSessionAuthoringDraftPrompt(draft: SessionAuthoringDraft, prompt: string): SessionAuthoringDraft {
    return {
        ...draft,
        prompt,
        displayText: prompt,
    };
}

export function updateSessionAuthoringDraftPermissionMode(
    draft: SessionAuthoringDraft,
    permissionMode: string,
    permissionModeUpdatedAt: number,
): SessionAuthoringDraft {
    return {
        ...draft,
        permissionMode,
        permissionModeUpdatedAt,
    };
}

export function updateSessionAuthoringDraftModelMode(
    draft: SessionAuthoringDraft,
    modelId: string,
    modelUpdatedAt: number,
): SessionAuthoringDraft {
    return {
        ...draft,
        modelId,
        modelUpdatedAt,
    };
}

export function updateSessionAuthoringDraftAutomation(
    draft: SessionAuthoringDraft,
    automation: NewSessionAutomationDraft | null,
): SessionAuthoringDraft {
    return {
        ...draft,
        automation,
    };
}

