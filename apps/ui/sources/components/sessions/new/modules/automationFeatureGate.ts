import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';

export function resolveEffectiveAutomationDraft(params: {
    draft: NewSessionAutomationDraft;
    automationsEnabled: boolean;
}): NewSessionAutomationDraft {
    if (params.automationsEnabled) {
        return params.draft;
    }
    if (!params.draft.enabled) {
        return params.draft;
    }
    return {
        ...params.draft,
        enabled: false,
    };
}

export function shouldShowAutomationActionChips(params: { automationsEnabled: boolean }): boolean {
    return params.automationsEnabled;
}
