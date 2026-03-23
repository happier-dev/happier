import type { McpServersSettingsV1 } from '@happier-dev/protocol';

export function normalizeMcpServersSettingsV1(settings: McpServersSettingsV1): McpServersSettingsV1 {
    const serverIds = new Set(settings.servers.map((s) => s.id));
    const filteredBindings = settings.bindings.filter((b) => serverIds.has(b.serverId));
    if (filteredBindings.length === settings.bindings.length) {
        return settings;
    }
    return { ...settings, bindings: filteredBindings };
}

