const TOOL_NAME_SEGMENT_PATTERN = /^[a-z0-9_-]+$/;

export type PluginMcpToolNamespaceRegistry = Readonly<{
    claimedNamespaces: Map<string, Readonly<{
        pluginId: string;
        registrationId: string;
        toolName: string;
    }>>;
}>;

export function createPluginMcpToolNamespaceRegistry(): PluginMcpToolNamespaceRegistry {
    return Object.freeze({
        claimedNamespaces: new Map(),
    });
}

function splitToolName(toolName: string): readonly string[] {
    return toolName.trim().split('.');
}

function hasValidSegments(parts: readonly string[]): boolean {
    return parts.length > 0 && parts.every((part) => TOOL_NAME_SEGMENT_PATTERN.test(part));
}

export function readPluginMcpToolNamespace(toolName: string, pluginId: string): string {
    const parts = splitToolName(toolName);
    if (!hasValidSegments(parts)) {
        throw new Error(`MCP tool '${toolName}' must use a canonical MCP tool prefix`);
    }
    if (parts[0] === 'happier') {
        if (parts.length < 2) {
            throw new Error(`MCP tool '${toolName}' must use a canonical MCP tool prefix`);
        }
        return 'happier';
    }
    const extensionPrefix = `ext.${pluginId}.`;
    if (toolName.startsWith(extensionPrefix)) {
        if (parts.length < pluginId.split('.').length + 2) {
            throw new Error(`MCP tool '${toolName}' must include a tool name after the plugin namespace`);
        }
        return `ext.${pluginId}`;
    }
    if (parts[0] === 'ext') {
        throw new Error(`MCP tool '${toolName}' must use the owning plugin namespace ext.${pluginId}.*`);
    }
    if (parts.length < 3) {
        throw new Error(`MCP tool '${toolName}' must use a canonical MCP tool prefix`);
    }
    return `${parts[0]}.${parts[1]}`;
}

export function assertPluginMcpToolName(toolName: string, pluginId: string): void {
    readPluginMcpToolNamespace(toolName, pluginId);
}

export function claimPluginMcpToolNamespace(
    registry: PluginMcpToolNamespaceRegistry,
    claim: Readonly<{
        pluginId: string;
        toolName: string;
        registrationId: string;
    }>,
): void {
    const namespace = readPluginMcpToolNamespace(claim.toolName, claim.pluginId);
    const existing = registry.claimedNamespaces.get(namespace);
    if (existing) {
        throw new Error(
            `MCP tool namespace collision for '${namespace}' between '${existing.registrationId}' and '${claim.registrationId}'`,
        );
    }
    registry.claimedNamespaces.set(namespace, Object.freeze({ ...claim }));
}

export function releasePluginMcpToolNamespace(
    registry: PluginMcpToolNamespaceRegistry,
    claim: Readonly<{
        pluginId: string;
        toolName: string;
        registrationId: string;
    }>,
): void {
    const namespace = readPluginMcpToolNamespace(claim.toolName, claim.pluginId);
    const existing = registry.claimedNamespaces.get(namespace);
    if (
        existing
        && existing.pluginId === claim.pluginId
        && existing.registrationId === claim.registrationId
        && existing.toolName === claim.toolName
    ) {
        registry.claimedNamespaces.delete(namespace);
    }
}
