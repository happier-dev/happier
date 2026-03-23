import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

export function updateSessionAuthoringDraftPrompt(
    draft: SessionAuthoringDraft,
    prompt: string,
): SessionAuthoringDraft {
    return {
        ...draft,
        prompt,
        displayText: prompt,
    };
}

export function updateSessionAuthoringDraftPermissionMode(
    draft: SessionAuthoringDraft,
    permissionMode: PermissionMode,
    updatedAt: number,
): SessionAuthoringDraft {
    return {
        ...draft,
        permissionMode,
        permissionModeUpdatedAt: updatedAt,
    };
}

export function updateSessionAuthoringDraftModelMode(
    draft: SessionAuthoringDraft,
    modelMode: ModelMode,
    updatedAt: number,
): SessionAuthoringDraft {
    return {
        ...draft,
        modelId: modelMode,
        modelUpdatedAt: updatedAt,
    };
}

export function updateSessionAuthoringDraftAutomation(
    draft: SessionAuthoringDraft,
    automation: SessionAuthoringDraft['automation'],
): SessionAuthoringDraft {
    return {
        ...draft,
        automation,
    };
}
