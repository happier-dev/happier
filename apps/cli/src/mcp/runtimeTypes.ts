import type {
    McpServerSpecV1,
} from '@happier-dev/plugin-sdk/experimental/mcp';

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
export type ResolvedSessionMcpScope = Readonly<{
    sessionId: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;

export type ResolvedSessionMcpTransport =
    | Readonly<{ kind: 'hosted' }>
    | Readonly<{ kind: 'stdio' }>
    | Readonly<{ kind: 'managed'; url?: string }>
    | Readonly<{ kind: 'http' | 'sse'; url: string }>;

export type ResolvedSessionMcpServer = Omit<McpServerSpecV1, 'transport'> & Readonly<{
    transport: ResolvedSessionMcpTransport;
    scope: ResolvedSessionMcpScope;
}>;

export type PluginMcpSessionResolver = Readonly<{
    resolveForSession(
        input: McpSessionResolutionInput,
    ): Promise<readonly ResolvedSessionMcpServer[]>;
}>;
