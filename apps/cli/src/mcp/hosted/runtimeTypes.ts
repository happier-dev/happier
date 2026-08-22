export type HostedMcpToolTextContent = Readonly<{
    type: 'text';
    text: string;
    annotations?: unknown;
    _meta?: Record<string, unknown>;
}>;

export type HostedMcpToolResult = Readonly<{
    content: readonly HostedMcpToolTextContent[];
    structuredContent?: unknown;
    isError?: boolean;
    _meta?: Record<string, unknown>;
}>;

export type HostedMcpToolCallContext = Readonly<{
    pluginId: string;
    serverId: string;
    toolName: string;
    signal: AbortSignal;
}>;

export type HostedMcpToolHandler = (
    args: unknown,
    context: HostedMcpToolCallContext,
) => HostedMcpToolResult | Promise<HostedMcpToolResult>;

export type HostedMcpToolAnnotations = Readonly<{
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}>;

export type HostedMcpToolDefinition = Readonly<{
    name: string;
    title?: string | null;
    description?: string | null;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: HostedMcpToolAnnotations;
    _meta?: Record<string, unknown>;
    handler: HostedMcpToolHandler;
}>;

export type PluginHostedMcpServerSpec = Readonly<{
    id: string;
    name: string;
    title?: string | null;
    description?: string | null;
    transport: Readonly<{
        kind: 'hosted';
        exposure?:
            | Readonly<{ kind: 'registryOnly' }>
            | Readonly<{ kind: 'loopbackHttp'; requested: true }>;
    }>;
    hosted?: Readonly<{
        tools?: readonly HostedMcpToolDefinition[];
    }>;
}>;
