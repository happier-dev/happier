import type {
    ExecBinaryLaunchInputV1,
    SystemToolSourceV1,
} from '@/plugins/runtime/exec/privateContract';
import type { PluginSystemToolContributionV1 } from '@happier-dev/protocol';

export type PluginExecSystemToolDefinition = Readonly<{
    toolId: string;
    displayName: string;
    source?: SystemToolSourceV1;
    executablePath?: string | null;
    lookupNames?: readonly string[];
    allowedArguments?: readonly string[];
    platforms?: readonly ('macos' | 'linux' | 'windows')[];
    defaultArgs?: readonly string[];
    env?: Readonly<Record<string, string>>;
    expiresInMs?: number | null;
}>;

export function resolvePluginExecSystemToolHostPlatform(
    platform: NodeJS.Platform,
): 'macos' | 'linux' | 'windows' | null {
    if (platform === 'darwin') return 'macos';
    if (platform === 'linux') return 'linux';
    if (platform === 'win32') return 'windows';
    return null;
}

export function isPluginExecSystemToolSupportedOnHost(
    definition: Pick<PluginExecSystemToolDefinition, 'platforms'>,
    platform: NodeJS.Platform,
): boolean {
    if (definition.platforms === undefined) return true;
    const hostPlatform = resolvePluginExecSystemToolHostPlatform(platform);
    return hostPlatform !== null && definition.platforms.includes(hostPlatform);
}

/**
 * Canonical boundary projection from manifest-declared system tools to the
 * executable grant model consumed by plugin runtime services.
 */
export function projectPluginSystemToolContributions(
    definitions: readonly PluginSystemToolContributionV1[],
): readonly PluginExecSystemToolDefinition[] {
    return Object.freeze(definitions.map((definition) => Object.freeze({
        toolId: definition.id,
        displayName: typeof definition.title === 'string'
            ? definition.title
            : definition.title.fallback,
        lookupNames: Object.freeze([...definition.executableNames]),
        ...(definition.allowedArguments ? {
            allowedArguments: Object.freeze([...definition.allowedArguments]),
        } : {}),
        ...(definition.platforms ? {
            platforms: Object.freeze([...definition.platforms]),
        } : {}),
    })));
}

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
