import type {
    ExecBinaryLaunchInputV1,
    SystemToolSourceV1,
} from '@happier-dev/plugin-sdk';

export type PluginExecSystemToolDefinition = Readonly<{
    toolId: string;
    displayName: string;
    source?: SystemToolSourceV1;
    executablePath?: string | null;
    lookupNames?: readonly string[];
    defaultArgs?: readonly string[];
    env?: Readonly<Record<string, string>>;
    expiresInMs?: number | null;
}>;

export type PluginExecSystemToolGrantRecord = Readonly<{
    kind?: 'system-tool';
    grantId: string;
    toolId: string;
    executablePath: string;
    expiresAt: number | null;
}>;

export type PluginExecAgentCliGrantRecord = Readonly<{
    kind: 'agent-cli';
    grantId: string;
    agentId: string;
    source: string;
    resolvedPath: string;
    executablePath: string;
    expiresAt: number | null;
}>;

export type PluginExecExecutableGrantRecord =
    | PluginExecSystemToolGrantRecord
    | PluginExecAgentCliGrantRecord;

export type ResolvedSystemToolLaunch = Readonly<{
    grant: PluginExecSystemToolGrantRecord;
    launch: ExecBinaryLaunchInputV1;
}>;
