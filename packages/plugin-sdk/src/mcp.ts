import type { ClassifiedRuntimeErrorV1 } from './errors';
import type { ExecClientHandleV1, ExecLaunchInputV1 } from './exec';
import type { ManagedServerHandleV1, ManagedServerSpecV1 } from './managedServer';

export type McpHostedServerTransportV1 = Readonly<{
    kind: 'hosted';
}>;

export type McpStdioTransportV1 = Readonly<{
    kind: 'stdio';
    launch: ExecLaunchInputV1;
}>;

export type McpManagedServerTransportV1 = Readonly<{
    kind: 'managed';
    server: ManagedServerSpecV1;
    url?: string;
}>;

export type McpEndpointTransportV1 = Readonly<{
    kind: 'http' | 'sse';
    url: string;
}>;

export type McpServerTransportV1 =
    | McpHostedServerTransportV1
    | McpStdioTransportV1
    | McpManagedServerTransportV1
    | McpEndpointTransportV1;

export type McpServerSpecV1 = Readonly<{
    id: string;
    name: string;
    title?: string | null;
    description?: string | null;
    transport: McpServerTransportV1;
}>;

export type McpClientTransportV1 =
    | McpStdioTransportV1
    | McpManagedServerTransportV1
    | McpEndpointTransportV1;

export type McpClientSpecV1 = Readonly<{
    id: string;
    transport: McpClientTransportV1;
}>;

export type McpResolvedScopeV1 = Readonly<{
    sessionId: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;

export type ResolvedMcpServerSpecV1 = McpServerSpecV1 & Readonly<{
    scope: McpResolvedScopeV1;
}>;

export type McpResolveForSessionInputV1 = Readonly<{
    sessionId: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;

export type McpServerHandleV1 = Readonly<{
    id: string;
    spec?: McpServerSpecV1;
    managedServer?: ManagedServerHandleV1;
    dispose(): Promise<void>;
}>;

export type McpClientHandleV1 = Readonly<{
    id: string;
    spec?: McpClientSpecV1;
    client?: ExecClientHandleV1;
    managedServer?: ManagedServerHandleV1;
    request?(message: unknown): Promise<unknown>;
    notify?(message: unknown): Promise<void>;
    dispose(): Promise<void>;
}>;

export type McpRuntimeErrorV1 = ClassifiedRuntimeErrorV1 & Readonly<{
    substrate: 'mcp';
}>;

export interface McpRuntimeServiceV1 {
    startServer(spec: McpServerSpecV1): Promise<McpServerHandleV1>;
    createClient(spec: McpClientSpecV1): Promise<McpClientHandleV1>;
    list(): Promise<readonly McpServerSpecV1[]>;
    resolveForSession(input: McpResolveForSessionInputV1): Promise<readonly ResolvedMcpServerSpecV1[]>;
}
