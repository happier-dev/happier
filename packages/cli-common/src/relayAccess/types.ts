export type RelayAccessProviderId =
    | 'localOnly'
    | 'lan'
    | 'tailscaleServe'
    | 'tailscaleFunnel'
    | 'cloudflareNamed';

export type RelayAccessProviderExposure = 'private' | 'public';

export type RelayAccessCommandRequest = Readonly<{
    command: string;
    args: ReadonlyArray<string>;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}>;

export type RelayAccessCommandResult = Readonly<{
    command: string;
    args: ReadonlyArray<string>;
    exitCode: number;
    stdout: string;
    stderr: string;
}>;

export type RelayAccessCommandRunner = (request: RelayAccessCommandRequest) => Promise<RelayAccessCommandResult>;

export type ResolveRelayAccessCommandOnPath = (
    command: string,
    env: NodeJS.ProcessEnv,
) => Promise<string | null> | string | null;

export type RelayAccessExecutionContext = Readonly<{
    env: NodeJS.ProcessEnv;
    upstreamUrl: string | null;
    runCommand?: RelayAccessCommandRunner;
    resolveCommandOnPath?: ResolveRelayAccessCommandOnPath;
}>;

export type RelayAccessProviderPrerequisite =
    | { kind: 'manualUrl' }
    | { kind: 'tailscaleInstalled' }
    | { kind: 'tailscaleAuth' }
    | { kind: 'cloudflareToken' }
    | { kind: 'cloudflareHostname' };

export type RelayAccessProviderDescriptor = Readonly<{
    id: RelayAccessProviderId;
    title: string;
    exposure: RelayAccessProviderExposure;
    prerequisites: readonly RelayAccessProviderPrerequisite[];
}>;

export type RelayAccessStatus =
    | Readonly<{
        state: 'disabled';
        shareUrl?: undefined;
        details?: unknown;
    }>
    | Readonly<{
        state: 'enabled';
        shareUrl?: string;
        details?: unknown;
    }>
    | Readonly<{
        state: 'needs_auth';
        shareUrl?: string;
        details?: unknown;
    }>
    | Readonly<{
        state: 'error';
        shareUrl?: string;
        details?: unknown;
    }>
    | Readonly<{
        state: 'unknown';
        shareUrl?: string;
        details?: unknown;
    }>;

export type RelayAccessConfig =
    | Readonly<{ providerId: 'localOnly' }>
    | Readonly<{ providerId: 'lan'; url: string }>
    | Readonly<{ providerId: 'tailscaleServe' }>
    | Readonly<{ providerId: 'tailscaleFunnel' }>
    | Readonly<{ providerId: 'cloudflareNamed'; hostname: string; token: string }>;

export type RelayAccessProvider = Readonly<{
    descriptor: RelayAccessProviderDescriptor;
    status: (params: Readonly<{ config: RelayAccessConfig | null; ctx: RelayAccessExecutionContext }>) => Promise<RelayAccessStatus> | RelayAccessStatus;
    configure?: (params: Readonly<{ config: RelayAccessConfig; ctx: RelayAccessExecutionContext }>) => Promise<RelayAccessStatus> | RelayAccessStatus;
    disable?: (params: Readonly<{ config: RelayAccessConfig; ctx: RelayAccessExecutionContext }>) => Promise<void> | void;
}>;
