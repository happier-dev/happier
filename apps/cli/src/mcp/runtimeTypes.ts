import type { McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint } from '@happier-dev/plugin-sdk/mcp';
import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1 } from '@happier-dev/protocol';

export type HostedMcpRuntimeEndpoint =
    | Readonly<{ kind: 'registryOnly' }>
    | Readonly<{
        kind: 'loopbackHttp';
        url: string;
        host: '127.0.0.1';
        port: number;
        /** Endpoint credential; carried only through private launch material. */
        headers: Readonly<{ authorization: string }>;
        expiresAtMs?: number;
    }>;

export type McpSessionResolutionInput = Readonly<({ sessionId: string; executionRunId?: never } | { sessionId?: never; executionRunId: string }) & {
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;
export type ResolvedMcpEndpointDiscoveryResult = Readonly<{
    endpoints: readonly PluginMcpDiscoveredEndpoint[];
    detectedServers?: readonly DetectedMcpServerV1[];
    warnings?: readonly DaemonMcpServersDetectWarningV1[];
}>;
export type ResolvedSessionMcpScope = Readonly<{
    sessionId?: string;
    executionRunId?: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;

export type ResolvedSessionMcpTransport =
    | Readonly<{ kind: 'hosted' }>
    | Readonly<{ kind: 'stdio' }>
    | Readonly<{ kind: 'http' | 'sse'; url: string; headers?: Readonly<Record<string, string>> }>;

export type ResolvedSessionMcpServer = Readonly<{
    id: string;
    name: string;
    title?: string | null;
    description?: string | null;
    transport: ResolvedSessionMcpTransport;
    scope: ResolvedSessionMcpScope;
}>;

export type PluginMcpSessionResolver = Readonly<{
    resolveToolNaming?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionMcpService['resolveToolNaming'];
    resolveForSession(
        input: McpSessionResolutionInput,
    ): Promise<readonly ResolvedSessionMcpServer[]>;
}>;
