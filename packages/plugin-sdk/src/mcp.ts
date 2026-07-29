import {
    DetectedMcpServerV1Schema,
} from '@happier-dev/protocol';
import type {
    DaemonMcpServersDetectWarningV1,
    DetectedMcpServerV1,
} from '@happier-dev/protocol';

export type McpHostedRuntimeExposureV1 =
    | Readonly<{ kind: 'registryOnly' }>
    | Readonly<{ kind: 'loopbackHttp'; requested: true }>;

export type McpHostedServerTransportV1 = Readonly<{
    kind: 'hosted';
    exposure?: McpHostedRuntimeExposureV1;
}>;

export type McpExecutableLaunchV1 =
    | Readonly<{
        kind: 'agent-cli';
        agentId: string;
        args?: readonly string[];
        cwd?: string;
        env?: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
        stdin?: string | Uint8Array;
    }>
    | Readonly<{
        kind: 'binary';
        executablePath: string;
        args?: readonly string[];
        cwd?: string;
        env?: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
        stdin?: string | Uint8Array;
    }>
    | Readonly<{
        kind: 'managed-installable';
        installableId: string;
        executableName?: string;
        args?: readonly string[];
        cwd?: string;
        env?: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
        stdin?: string | Uint8Array;
        sourcePreference?: 'managed-first';
    }>
    | Readonly<{ kind: 'ipc'; endpoint: string }>;

export type McpStdioTransportV1 = Readonly<{
    kind: 'stdio';
    launch: McpExecutableLaunchV1;
}>;

export type McpManagedServerCredentialV1 = Readonly<{
    envKey: string;
    value: string;
    httpHeader?: Readonly<{ name: string; value: string }>;
}>;

export type McpManagedServerModeV1 =
    | Readonly<{
        kind: 'managed-spawn';
        host?: string;
        port?: number;
        baseUrl?: string;
        portArg?: string;
        portEnvKey?: string;
        baseUrlEnvKey?: string;
        credential?: McpManagedServerCredentialV1;
    }>
    | Readonly<{
        kind: 'external-attach';
        baseUrl: string;
        credential?: McpManagedServerCredentialV1;
    }>;

export type McpManagedServerSpecV1 = Readonly<{
    id: string;
    launch?: McpExecutableLaunchV1;
    mode?: McpManagedServerModeV1;
    healthCheck?:
        | Readonly<{
            kind: 'http';
            url?: string;
            path?: string;
            headers?: Readonly<Record<string, string>>;
            timeoutMs?: number;
        }>
        | Readonly<{
            kind: 'command';
            launch: McpExecutableLaunchV1;
            timeoutMs?: number;
        }>;
    orphanReaper?: Readonly<{
        executablePath: string;
        commandIncludes?: readonly string[];
        initialSignal?: string;
        forceSignal?: string;
        forceAfterMs?: number;
    }>;
    watchdog?: Readonly<{ intervalMs: number; missedIntervals: number }>;
    durableLog?: Readonly<{ enabled?: boolean; dir?: string; keepCount?: number }>;
    launchFingerprint?: string;
    startupTimeoutMs?: number;
    restart?: 'never';
    signal?: AbortSignal;
}>;

export type McpManagedServerTransportV1 = Readonly<{
    kind: 'managed';
    server: McpManagedServerSpecV1;
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
