export function resolveExecutionRunPermissionAgentId(params: Readonly<{
    selectedBackendChoices: readonly Readonly<{ agentId: string }>[];
    fallbackAgentId: string | null | undefined;
}>): string | null {
    const selectedChoice = params.selectedBackendChoices[0];
    if (selectedChoice) {
        const selectedAgentId = selectedChoice.agentId.trim();
        return selectedAgentId || null;
    }

    const fallbackAgentId = params.fallbackAgentId?.trim() ?? '';
    return fallbackAgentId || null;
}
