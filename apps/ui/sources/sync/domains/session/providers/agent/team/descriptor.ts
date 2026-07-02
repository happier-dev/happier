import type { AgentTeamSessionProviderDescriptor } from './types';

function readStringSet(values: readonly string[] | undefined): ReadonlySet<string> {
    return new Set(
        (values ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
    );
}

export function hasAgentTeamFlavor(descriptor: AgentTeamSessionProviderDescriptor, flavor: string | null): boolean {
    if (!flavor) return false;
    return readStringSet(descriptor.flavorAliases).has(flavor);
}

function hasToolName(toolNames: readonly string[] | undefined, toolName: string | null | undefined): boolean {
    const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : '';
    return normalizedToolName.length > 0 && readStringSet(toolNames).has(normalizedToolName);
}

export function isAgentTeamCreateToolName(
    descriptor: AgentTeamSessionProviderDescriptor,
    toolName: string | null | undefined,
): boolean {
    return hasToolName(descriptor.tools.teamCreate, toolName);
}

export function isAgentTeamDeleteToolName(
    descriptor: AgentTeamSessionProviderDescriptor,
    toolName: string | null | undefined,
): boolean {
    return hasToolName(descriptor.tools.teamDelete, toolName);
}

export function isAgentTeamSendMessageToolName(
    descriptor: AgentTeamSessionProviderDescriptor,
    toolName: string | null | undefined,
): boolean {
    return hasToolName(descriptor.tools.teamSendMessage, toolName);
}

export function isAgentTeamSubagentSpawnToolName(
    descriptor: AgentTeamSessionProviderDescriptor,
    toolName: string | null | undefined,
): boolean {
    return hasToolName(descriptor.tools.subagentSpawn, toolName);
}

export function isAgentTeamActiveTeamFallbackSubagentSpawnToolName(
    descriptor: AgentTeamSessionProviderDescriptor,
    toolName: string | null | undefined,
): boolean {
    return hasToolName(descriptor.tools.activeTeamFallbackSubagentSpawn, toolName);
}

export function isAgentTeamConfigMutationToolName(
    descriptor: AgentTeamSessionProviderDescriptor,
    toolName: string | null | undefined,
): boolean {
    return hasToolName(descriptor.tools.configMutation, toolName);
}

export function messagesContainAgentTeamToolSignal(
    descriptor: AgentTeamSessionProviderDescriptor,
    messages: readonly Readonly<{ kind?: string; tool?: Readonly<{ name?: string | null }> }>[],
): boolean {
    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolName = message.tool?.name;
        if (
            isAgentTeamCreateToolName(descriptor, toolName)
            || isAgentTeamSendMessageToolName(descriptor, toolName)
            || isAgentTeamDeleteToolName(descriptor, toolName)
            || isAgentTeamSubagentSpawnToolName(descriptor, toolName)
        ) {
            return true;
        }
    }
    return false;
}

export function readAgentTeamIdFromConfigPath(
    descriptor: AgentTeamSessionProviderDescriptor,
    path: string,
): string | null {
    const pathDescriptor = descriptor.configTeamPath;
    if (!pathDescriptor) return null;

    const rootDirectory = pathDescriptor.rootDirectory.trim();
    const teamsDirectory = pathDescriptor.teamsDirectory.trim();
    const filename = pathDescriptor.filename.trim();
    if (!rootDirectory || !teamsDirectory || !filename) return null;

    const segments = path.replaceAll('\\', '/').split('/').filter((segment) => segment.length > 0);
    for (let index = 0; index <= segments.length - 4; index += 1) {
        if (
            segments[index]?.toLowerCase() === rootDirectory.toLowerCase()
            && segments[index + 1]?.toLowerCase() === teamsDirectory.toLowerCase()
            && segments[index + 3]?.toLowerCase() === filename.toLowerCase()
        ) {
            const teamId = segments[index + 2]?.trim() ?? '';
            return teamId.length > 0 ? teamId : null;
        }
    }
    return null;
}

export function getAgentTeamIgnoredActivityPreviewEventTypes(
    descriptor: AgentTeamSessionProviderDescriptor,
): ReadonlySet<string> {
    return readStringSet(descriptor.lifecycleEvents?.ignoreActivityPreview);
}

export function getAgentTeamShutdownApprovedEventType(
    descriptor: AgentTeamSessionProviderDescriptor,
): string {
    return descriptor.lifecycleEvents?.shutdownApproved?.trim() || 'shutdown_approved';
}
