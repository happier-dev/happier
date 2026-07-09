import {
    DetectedMcpServerV1Schema,
} from '@happier-dev/protocol';
import type {
    DaemonMcpServersDetectWarningV1,
    DetectedMcpServerV1,
} from '@happier-dev/protocol';

import type { ClassifiedRuntimeErrorV1 } from './errors.js';
import type { ExecClientHandleV1, ExecLaunchInputV1 } from './exec.js';
import type { ManagedServerHandleV1, ManagedServerSpecV1 } from './managedServer.js';

export type McpHostedRuntimeExposureV1 =
    | Readonly<{ kind: 'registryOnly' }>
    | Readonly<{ kind: 'loopbackHttp'; requested: true }>;

export type McpHostedRuntimeEndpointV1 =
    | Readonly<{ kind: 'registryOnly' }>
    | Readonly<{
        kind: 'loopbackHttp';
        url: string;
        host: '127.0.0.1';
        port: number;
        expiresAtMs?: number;
    }>;

export type McpHostedServerTransportV1 = Readonly<{
    kind: 'hosted';
    exposure?: McpHostedRuntimeExposureV1;
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

export type McpHostedToolTextContentV1 = Readonly<{
    type: 'text';
    text: string;
    annotations?: unknown;
    _meta?: Record<string, unknown>;
}>;

export type McpHostedToolContentV1 = McpHostedToolTextContentV1;

export type McpHostedToolResultV1 = Readonly<{
    content: readonly McpHostedToolContentV1[];
    structuredContent?: unknown;
    isError?: boolean;
    _meta?: Record<string, unknown>;
}>;

export type McpHostedToolCallContextV1 = Readonly<{
    pluginId: string;
    serverId: string;
    toolName: string;
    signal: AbortSignal;
}>;

export type McpHostedToolHandlerV1 = (
    args: unknown,
    context: McpHostedToolCallContextV1,
) => McpHostedToolResultV1 | Promise<McpHostedToolResultV1>;

export type McpHostedToolAnnotationsV1 = Readonly<{
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}>;

export type McpHostedToolDefinitionV1 = Readonly<{
    name: string;
    title?: string | null;
    description?: string | null;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: McpHostedToolAnnotationsV1;
    _meta?: Record<string, unknown>;
    handler: McpHostedToolHandlerV1;
}>;

export type McpHostedServerDefinitionV1 = Readonly<{
    tools?: readonly McpHostedToolDefinitionV1[];
}>;

export type McpServerSpecV1 = Readonly<{
    id: string;
    name: string;
    title?: string | null;
    description?: string | null;
    transport: McpServerTransportV1;
    hosted?: McpHostedServerDefinitionV1;
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

export type McpResolvedStdioTransportV1 = Readonly<{
    kind: 'stdio';
}>;

export type McpResolvedManagedServerTransportV1 = Readonly<{
    kind: 'managed';
    url?: string;
}>;

export type McpResolvedServerTransportV1 =
    | McpHostedServerTransportV1
    | McpResolvedStdioTransportV1
    | McpResolvedManagedServerTransportV1
    | McpEndpointTransportV1;

export type ResolvedMcpServerSpecV1 = Omit<McpServerSpecV1, 'transport'> & Readonly<{
    transport: McpResolvedServerTransportV1;
    scope: McpResolvedScopeV1;
}>;

export type McpDiscoveryWarningV1 = DaemonMcpServersDetectWarningV1;
export type {
    DaemonMcpServersDetectWarningV1,
    DetectedMcpServerV1,
};

export function normalizeDetectedMcpServerV1(value: unknown): DetectedMcpServerV1 | null {
    const parsed = DetectedMcpServerV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export type McpDiscoveryProviderResultV1 = Readonly<{
    servers: readonly McpServerSpecV1[];
    warnings?: readonly McpDiscoveryWarningV1[];
    diagnostics?: readonly McpDiscoveryWarningV1[];
}>;

export type McpDiscoveryProviderReturnV1 =
    | readonly McpServerSpecV1[]
    | McpDiscoveryProviderResultV1;

export type McpResolveForSessionInputV1 = Readonly<{
    sessionId: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;

export type McpServerHandleV1 = Readonly<{
    id: string;
    spec?: McpServerSpecV1;
    endpoint?: McpHostedRuntimeEndpointV1;
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
