import type { AgentId } from '@/agents/catalog/catalog';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { AutomationTemplate } from '@/sync/domains/automations/automationTypes';
import type { SessionMcpSelectionV1, WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';

export function buildAutomationTemplate(params: {
    directory: string;
    agentType: AgentId;
    transcriptStorage?: 'persisted' | 'direct';
    prompt?: string;
    displayText?: string;
    profileId?: string;
    environmentVariables?: Record<string, string>;
    resume?: string;
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
    modelId?: string;
    modelUpdatedAt?: number;
    mcpSelection?: SessionMcpSelectionV1;
    terminal?: unknown;
    windowsRemoteSessionLaunchMode?: WindowsRemoteSessionLaunchMode;
    experimentalCodexAcp?: boolean;
}): AutomationTemplate {
    return {
        directory: params.directory,
        agent: params.agentType,
        ...(params.transcriptStorage ? { transcriptStorage: params.transcriptStorage } : {}),
        ...(typeof params.prompt === 'string' && params.prompt.trim().length > 0 ? { prompt: params.prompt } : {}),
        ...(typeof params.displayText === 'string' && params.displayText.trim().length > 0 ? { displayText: params.displayText } : {}),
        ...(params.profileId !== undefined ? { profileId: params.profileId } : {}),
        ...(params.environmentVariables ? { environmentVariables: params.environmentVariables } : {}),
        ...(params.resume ? { resume: params.resume } : {}),
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: params.permissionModeUpdatedAt,
        ...(params.modelId ? { modelId: params.modelId } : {}),
        ...(typeof params.modelUpdatedAt === 'number' ? { modelUpdatedAt: params.modelUpdatedAt } : {}),
        ...(params.mcpSelection ? { mcpSelection: params.mcpSelection } : {}),
        ...(params.terminal ? { terminal: params.terminal } : {}),
        ...(params.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: params.windowsRemoteSessionLaunchMode } : {}),
        ...(params.experimentalCodexAcp !== undefined ? { experimentalCodexAcp: params.experimentalCodexAcp } : {}),
    };
}
