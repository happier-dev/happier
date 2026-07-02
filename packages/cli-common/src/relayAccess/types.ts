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
    signal?: AbortSignal;
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

export type RelayAccessDeadlineV1 = Readonly<{
    startedAt: number;
    deadlineAt: number;
    now: () => number;
    signal?: AbortSignal;
}>;

export type RelayAccessDiagnosticCodeV1 =
    | 'provider_not_installed'
    | 'provider_not_authenticated'
    | 'provider_disabled'
    | 'provider_command_timeout'
    | 'provider_command_failed'
    | 'provider_unreachable'
    | 'invalid_provider_output'
    | 'unknown';

export type RelayAccessDiagnosticV1 = Readonly<{
    code: RelayAccessDiagnosticCodeV1;
    providerId: RelayAccessProviderId;
    phase: string;
    message: string;
    developerMessage?: string;
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

export type RelayAccessProviderStatusOptions = Readonly<{
    timeoutMs?: number;
    deadline?: RelayAccessDeadlineV1;
    signal?: AbortSignal;
}>;

export type RelayAccessConfig =
    | Readonly<{ providerId: 'localOnly' }>
    | Readonly<{ providerId: 'lan'; url: string }>
    | Readonly<{ providerId: 'tailscaleServe' }>
    | Readonly<{ providerId: 'tailscaleFunnel' }>
    | Readonly<{ providerId: 'cloudflareNamed'; hostname: string; token: string }>;

export type RelayAccessProvider = Readonly<{
    descriptor: RelayAccessProviderDescriptor;
    status: (params: Readonly<{ config: RelayAccessConfig | null; ctx: RelayAccessExecutionContext } & RelayAccessProviderStatusOptions>) => Promise<RelayAccessStatus> | RelayAccessStatus;
    configure?: (params: Readonly<{ config: RelayAccessConfig; ctx: RelayAccessExecutionContext } & RelayAccessProviderStatusOptions>) => Promise<RelayAccessStatus> | RelayAccessStatus;
    disable?: (params: Readonly<{ config: RelayAccessConfig; ctx: RelayAccessExecutionContext } & RelayAccessProviderStatusOptions>) => Promise<void> | void;
}>;
