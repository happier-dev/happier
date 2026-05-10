const TOOL_NAME_SEGMENT_PATTERN = /^[a-z0-9_-]+$/;

export type PluginMcpToolNamespaceRegistry = Readonly<{
    claimedNamespaces: Map<string, Readonly<{
        pluginId: string;
        registrationId: string;
        namespace: string;
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
        if (parts.length < 3) {
            throw new Error(`MCP tool '${toolName}' must use a canonical MCP tool prefix`);
        }
        return `happier.${parts[1]}`;
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

export function readPluginMcpToolNamespacePrefix(namespace: string, pluginId: string): string {
    const parts = splitToolName(namespace);
    if (!hasValidSegments(parts)) {
        throw new Error(`MCP tool namespace '${namespace}' must use a canonical MCP tool namespace prefix`);
    }
    if (parts[0] === 'happier') {
        if (parts.length !== 2) {
            throw new Error(`MCP tool namespace '${namespace}' must use a canonical MCP tool namespace prefix`);
        }
        return namespace;
    }
    const owningExtensionNamespace = `ext.${pluginId}`;
    if (namespace === owningExtensionNamespace) {
        return namespace;
    }
    if (parts[0] === 'ext') {
        throw new Error(`MCP tool namespace '${namespace}' must use the owning plugin namespace ${owningExtensionNamespace}`);
    }
    if (parts.length !== 2) {
        throw new Error(`MCP tool namespace '${namespace}' must use a canonical MCP tool namespace prefix`);
    }
    return namespace;
}

export function assertPluginMcpToolName(toolName: string, pluginId: string): void {
    readPluginMcpToolNamespace(toolName, pluginId);
}

export function assertPluginMcpToolNamespace(namespace: string, pluginId: string): void {
    readPluginMcpToolNamespacePrefix(namespace, pluginId);
}

function claimNamespace(
    registry: PluginMcpToolNamespaceRegistry,
    claim: Readonly<{
        pluginId: string;
        namespace: string;
        registrationId: string;
    }>,
): void {
    const existing = registry.claimedNamespaces.get(claim.namespace);
    if (existing) {
        throw new Error(
            `MCP tool namespace collision for '${claim.namespace}' between '${existing.registrationId}' and '${claim.registrationId}'`,
        );
    }
    registry.claimedNamespaces.set(claim.namespace, Object.freeze({ ...claim }));
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
    claimNamespace(registry, {
        pluginId: claim.pluginId,
        namespace,
        registrationId: claim.registrationId,
    });
}

export function claimPluginMcpToolNamespacePrefix(
    registry: PluginMcpToolNamespaceRegistry,
    claim: Readonly<{
        pluginId: string;
        namespace: string;
        registrationId: string;
    }>,
): void {
    const namespace = readPluginMcpToolNamespacePrefix(claim.namespace, claim.pluginId);
    claimNamespace(registry, {
        pluginId: claim.pluginId,
        namespace,
        registrationId: claim.registrationId,
    });
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
        && existing.namespace === namespace
    ) {
        registry.claimedNamespaces.delete(namespace);
    }
}

export function releasePluginMcpToolNamespacePrefix(
    registry: PluginMcpToolNamespaceRegistry,
    claim: Readonly<{
        pluginId: string;
        namespace: string;
        registrationId: string;
    }>,
): void {
    const namespace = readPluginMcpToolNamespacePrefix(claim.namespace, claim.pluginId);
    const existing = registry.claimedNamespaces.get(namespace);
    if (
        existing
        && existing.pluginId === claim.pluginId
        && existing.registrationId === claim.registrationId
        && existing.namespace === namespace
    ) {
        registry.claimedNamespaces.delete(namespace);
    }
}
