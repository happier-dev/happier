import type { AutomationTemplate } from '@/sync/domains/automations/automationTypes';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

function trimOrUndefined(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function buildAutomationTemplateFromSessionAuthoringDraft(draft: SessionAuthoringDraft): AutomationTemplate {
    const template: AutomationTemplate = {
        directory: draft.directory.trim(),
    };

    const prompt = trimOrUndefined(draft.prompt);
    const displayText = trimOrUndefined(draft.displayText);
    const agent = trimOrUndefined(draft.agentId);
    const profileId = trimOrUndefined(draft.profileId);
    const resume = trimOrUndefined(draft.resumeSessionId);
    const permissionMode = trimOrUndefined(draft.permissionMode);
    const modelId = trimOrUndefined(draft.modelId);
    const existingSessionId = trimOrUndefined(draft.existingSessionId);
    const sessionEncryptionKeyBase64 = trimOrUndefined(draft.sessionEncryptionKeyBase64);

    if (prompt) template.prompt = prompt;
    if (displayText) template.displayText = displayText;
    if (agent) template.agent = agent;
    if (draft.transcriptStorage) template.transcriptStorage = draft.transcriptStorage;
    if (profileId) template.profileId = profileId;
    if (draft.environmentVariables) template.environmentVariables = draft.environmentVariables;
    if (resume) template.resume = resume;
    if (permissionMode) template.permissionMode = permissionMode;
    if (typeof draft.permissionModeUpdatedAt === 'number') template.permissionModeUpdatedAt = draft.permissionModeUpdatedAt;
    if (modelId) template.modelId = modelId;
    if (typeof draft.modelUpdatedAt === 'number') template.modelUpdatedAt = draft.modelUpdatedAt;
    if (draft.mcpSelection) template.mcpSelection = draft.mcpSelection;
    if (draft.terminal !== null && draft.terminal !== undefined) template.terminal = draft.terminal;
    if (draft.windowsRemoteSessionLaunchMode) template.windowsRemoteSessionLaunchMode = draft.windowsRemoteSessionLaunchMode;
    if (draft.windowsRemoteSessionConsole) template.windowsRemoteSessionConsole = draft.windowsRemoteSessionConsole;
    if (draft.experimentalCodexAcp !== null && draft.experimentalCodexAcp !== undefined) {
        template.experimentalCodexAcp = draft.experimentalCodexAcp;
    }
    if (existingSessionId) template.existingSessionId = existingSessionId;
    if (sessionEncryptionKeyBase64) template.sessionEncryptionKeyBase64 = sessionEncryptionKeyBase64;
    if (draft.sessionEncryptionVariant) template.sessionEncryptionVariant = draft.sessionEncryptionVariant;

    return template;
}

