import type { AccessProviderContributionV1, AccessProviderRefV1, AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { AccessProviderRoleResultV1, MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { MachineRecipeV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { runTailscaleStatusJson } from '../tailscale/commandRunner.js';

/** Builtins name existing host Actions; these are never same-plugin local ids. */
export type BuiltinAccessProviderDefinition = AccessProviderContributionV1 & Readonly<{
    actions: Readonly<{ inspect: 'machines.reachability.inspect'; configure?: 'machines.reachability.configure';
        disable?: 'machines.reachability.configure'; join?: 'machines.reachability.configure'; leave?: 'machines.reachability.configure' }>;
}>;

/** Trusted native codecs may carry exact observed ingress facts; plugin role wire schemas stay unchanged. */
export type BuiltinAccessProviderRoleResult =
    | Readonly<{ kind: 'confirmed'; facts: Extract<AccessProviderRoleResultV1, { kind: 'confirmed' }>['facts'] & Readonly<{
        ingress?: Readonly<{ https: NonNullable<AccessProviderContributionV1['https']> }>;
    }> }>
    | Exclude<AccessProviderRoleResultV1, { kind: 'confirmed' }>;

/** Static codec/display key; selection authority is a structured reference. */
export type RelayAccessProviderId = string;

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
    readNetworkInterfaces?: NonNullable<Parameters<typeof runTailscaleStatusJson>[1]>['readNetworkInterfaces'];
    platform?: NodeJS.Platform;
    route?: Readonly<{ ownerId: string; hostname: string; httpsPort: number; path: string; upstream: string }>;
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
    | 'tailscale_operator_authorization_refused'
    | 'provider_unreachable'
    | 'invalid_provider_output'
    | 'unknown';

export type RelayAccessDiagnosticV1 = Readonly<{
    code: RelayAccessDiagnosticCodeV1;
    providerId: RelayAccessProviderId;
    phase: string;
    message: string;
    developerMessage?: string;
    retryable?: false;
}>;

export type RelayAccessProviderPrerequisite =
    | { kind: 'manualUrl' }
    | { kind: 'tailscaleInstalled' }
    | { kind: 'tailscaleAuth' }
    | { kind: 'credentialPurpose'; purpose: string }
    | { kind: 'cloudflareHostname' };

export type RelayAccessRemedyId = 'tailscale.install' | 'tailscale.login' | 'tailscale.serve.enable'
    | 'tailscale.serve.approve' | 'tailscale.funnel.approve' | 'cloudflare.configure';

/** Presentation-only projection for the built-in Home setup adapter. */
export type RelayAccessHomeUi = Readonly<{
    titleKey: string;
    subtitleKey: string;
    buildPolicyFeatureId?: 'setup.relayAccess.allowTailscale' | 'setup.relayAccess.allowCloudflareTunnel';
    credentialBindings?: readonly Readonly<{
        purpose: string;
        kind: 'connectedAccount';
        service: Readonly<{ pluginId: string; localId: string }>;
        settingKey?: 'cloudflareToken';
    }>[];
    configStep?: Readonly<{
        testIDPrefix: string;
        hintKey: string;
        fields: readonly Readonly<{ id: string; labelKey: string; placeholderKey?: string; format?: 'url' | 'hostname';
            settingKey?: 'lanUrl' | 'cloudflareHostname'; testID?: string }>[];
    }>;
}>;

export type RelayAccessProviderDescriptor = Readonly<{
    id: RelayAccessProviderId;
    title: string;
    exposure: RelayAccessProviderExposure;
    prerequisites: readonly RelayAccessProviderPrerequisite[];
    provider: AccessProviderRefV1;
    definition: BuiltinAccessProviderDefinition;
    requiresUpstreamUrl: boolean;
    homeSetupTaskKind?: 'secureAccess.tailscale.v1';
    homeUi?: RelayAccessHomeUi;
    remedies?: Readonly<{
        reasons?: Readonly<Record<string, RelayAccessRemedyId>>;
        needsAuth?: RelayAccessRemedyId;
        notConfigured?: RelayAccessRemedyId;
        missingShareUrl?: RelayAccessRemedyId;
    }>;
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

export type RelayAccessConfig = AccessProviderSelectionV1;

export type RelayAccessProvider = Readonly<{
    descriptor: RelayAccessProviderDescriptor;
    inspect?: (params: Readonly<{ config: RelayAccessConfig | null; ctx: RelayAccessExecutionContext } & RelayAccessProviderStatusOptions>) => Promise<BuiltinAccessProviderRoleResult>;
    prepareMembership?: (params: Readonly<{ role: 'join' | 'leave'; setupCredentialFile?: string;
        observed: Pick<MachinePrivateNetworkObservationV1, 'state' | 'networkIdentity'>; ctx: RelayAccessExecutionContext }
        & RelayAccessProviderStatusOptions>) => Promise<Readonly<{
            ok: true; recipe: MachineRecipeV1; inputs: AccessProviderSelectionV1['config'];
            profile: Readonly<{ profileId: string | null; networkIdentity: string | null }>;
        }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
    status: (params: Readonly<{ config: RelayAccessConfig | null; ctx: RelayAccessExecutionContext } & RelayAccessProviderStatusOptions>) => Promise<RelayAccessStatus> | RelayAccessStatus;
    configure?: (params: Readonly<{ config: RelayAccessConfig; ctx: RelayAccessExecutionContext } & RelayAccessProviderStatusOptions>) => Promise<RelayAccessStatus> | RelayAccessStatus;
    disable?: (params: Readonly<{ config: RelayAccessConfig; ctx: RelayAccessExecutionContext } & RelayAccessProviderStatusOptions>) => Promise<void> | void;
}>;
