import type { McpServerBindingV1, McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol';

function hasDuplicateServerName(settings: McpServersSettingsV1, name: string): boolean {
    return settings.servers.some((s) => s.name === name);
}

function hasDuplicateServerId(settings: McpServersSettingsV1, id: string): boolean {
    return settings.servers.some((s) => s.id === id);
}

function hasDuplicateBindingId(settings: McpServersSettingsV1, id: string): boolean {
    return settings.bindings.some((b) => b.id === id);
}

export function addMcpServerCatalogEntryV1(settings: McpServersSettingsV1, entry: McpServerCatalogEntryV1): McpServersSettingsV1 {
    if (hasDuplicateServerId(settings, entry.id)) {
        throw new Error(`Duplicate server id: ${entry.id}`);
    }
    if (hasDuplicateServerName(settings, entry.name)) {
        throw new Error(`Duplicate server name: ${entry.name}`);
    }
    return { ...settings, servers: [...settings.servers, entry] };
}

export function deleteMcpServerCatalogEntryV1(settings: McpServersSettingsV1, serverId: string): McpServersSettingsV1 {
    const nextServers = settings.servers.filter((s) => s.id !== serverId);
    const nextBindings = settings.bindings.filter((b) => b.serverId !== serverId);
    if (nextServers.length === settings.servers.length && nextBindings.length === settings.bindings.length) {
        return settings;
    }
    return { ...settings, servers: nextServers, bindings: nextBindings };
}

export function addMcpServerBindingV1(settings: McpServersSettingsV1, binding: McpServerBindingV1): McpServersSettingsV1 {
    if (!settings.servers.some((s) => s.id === binding.serverId)) {
        throw new Error(`Server not found: ${binding.serverId}`);
    }
    if (hasDuplicateBindingId(settings, binding.id)) {
        throw new Error(`Duplicate binding id: ${binding.id}`);
    }
    return { ...settings, bindings: [...settings.bindings, binding] };
}

export function upsertMcpServerWithBindingsV1(
    settings: McpServersSettingsV1,
    entry: McpServerCatalogEntryV1,
    bindings: ReadonlyArray<McpServerBindingV1>,
): McpServersSettingsV1 {
    const collision = settings.servers.find((s) => s.id !== entry.id && s.name === entry.name);
    if (collision) {
        throw new Error(`Duplicate server name: ${entry.name}`);
    }

    const hasExisting = settings.servers.some((s) => s.id === entry.id);
    const nextServers = hasExisting
        ? settings.servers.map((s) => (s.id === entry.id ? entry : s))
        : [...settings.servers, entry];

    const remainingBindings = settings.bindings.filter((b) => b.serverId !== entry.id);
    const remainingBindingIds = new Set(remainingBindings.map((b) => b.id));
    const addedBindingIds = new Set<string>();

    for (const binding of bindings) {
        if (binding.serverId !== entry.id) {
            throw new Error(`Binding serverId mismatch (expected ${entry.id}, got ${binding.serverId})`);
        }
        if (remainingBindingIds.has(binding.id)) {
            throw new Error(`Duplicate binding id: ${binding.id}`);
        }
        if (addedBindingIds.has(binding.id)) {
            throw new Error(`Duplicate binding id: ${binding.id}`);
        }
        addedBindingIds.add(binding.id);
    }

    return {
        ...settings,
        servers: nextServers,
        bindings: [...remainingBindings, ...bindings],
    };
}
