import type { McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint } from '@happier-dev/plugin-sdk/mcp';
import type { DaemonMcpServersDetectWarningV1 } from '@happier-dev/protocol';

export type HostedMcpRuntimeEndpoint =
    | Readonly<{ kind: 'registryOnly' }>
    | Readonly<{
        kind: 'loopbackHttp';
        url: string;
        host: '127.0.0.1';
        port: number;
        expiresAtMs?: number;
    }>;

export type McpSessionResolutionInput = Readonly<{
    sessionId: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;
export type ResolvedMcpEndpointDiscoveryResult = Readonly<{
    endpoints: readonly PluginMcpDiscoveredEndpoint[];
    warnings?: readonly DaemonMcpServersDetectWarningV1[];
}>;
export type ResolvedSessionMcpScope = Readonly<{
    sessionId: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;

export type ResolvedSessionMcpTransport =
    | Readonly<{ kind: 'hosted' }>
    | Readonly<{ kind: 'stdio' }>
    | Readonly<{ kind: 'http' | 'sse'; url: string }>;

export type ResolvedSessionMcpServer = Readonly<{
    id: string;
    name: string;
    title?: string | null;
    description?: string | null;
    transport: ResolvedSessionMcpTransport;
    scope: ResolvedSessionMcpScope;
}>;

export type PluginMcpSessionResolver = Readonly<{
    resolveForSession(
        input: McpSessionResolutionInput,
    ): Promise<readonly ResolvedSessionMcpServer[]>;
}>;
