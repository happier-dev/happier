import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import type { ResolvedSessionMcpTransport } from '../runtimeTypes';

/**
 * Points a selected catalog row at its plugin-materialized endpoint. The endpoint's own
 * credential headers replace any same-named configured header, so they travel through the
 * canonical remote materializer (private bridge config file), never argv or MCP config env.
 */
export function applyAttachedPluginMcpTransport<Selected extends Readonly<{ config: McpServerCatalogEntryV1 }>>(
    selected: Selected,
    transport: ResolvedSessionMcpTransport,
): Selected {
    if (transport.kind !== 'http' && transport.kind !== 'sse') return selected;
    const remote = selected.config.remote!;
    const attached = Object.entries(transport.headers ?? {});
    const replaced = new Set(attached.map(([name]) => name.toLowerCase()));
    const headers = {
        ...Object.fromEntries(Object.entries(remote.headers).filter(([name]) => !replaced.has(name.toLowerCase()))),
        ...Object.fromEntries(attached.map(([name, value]) => [name, { t: 'literal' as const, v: value }])),
    };
    return { ...selected, config: { ...selected.config, remote: { ...remote, url: transport.url, headers } } };
}
