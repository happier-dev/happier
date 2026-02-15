import type { AgentId } from '@/agents/catalog/catalog';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { AutomationTemplate } from '@/sync/domains/automations/automationTypes';

export function buildAutomationTemplate(params: {
    directory: string;
    agentType: AgentId;
    prompt?: string;
    displayText?: string;
    profileId?: string;
    environmentVariables?: Record<string, string>;
    resume?: string;
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
    modelId?: string;
    modelUpdatedAt?: number;
    terminal?: unknown;
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
    experimentalCodexResume?: boolean;
    experimentalCodexAcp?: boolean;
}): AutomationTemplate {
    return {
        directory: params.directory,
        agent: params.agentType,
        ...(typeof params.prompt === 'string' && params.prompt.trim().length > 0 ? { prompt: params.prompt } : {}),
        ...(typeof params.displayText === 'string' && params.displayText.trim().length > 0 ? { displayText: params.displayText } : {}),
        ...(params.profileId !== undefined ? { profileId: params.profileId } : {}),
        ...(params.environmentVariables ? { environmentVariables: params.environmentVariables } : {}),
        ...(params.resume ? { resume: params.resume } : {}),
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: params.permissionModeUpdatedAt,
        ...(params.modelId ? { modelId: params.modelId } : {}),
        ...(typeof params.modelUpdatedAt === 'number' ? { modelUpdatedAt: params.modelUpdatedAt } : {}),
        ...(params.terminal ? { terminal: params.terminal } : {}),
        ...(params.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: params.windowsRemoteSessionConsole } : {}),
        ...(params.experimentalCodexResume !== undefined ? { experimentalCodexResume: params.experimentalCodexResume } : {}),
        ...(params.experimentalCodexAcp !== undefined ? { experimentalCodexAcp: params.experimentalCodexAcp } : {}),
    };
}
