import { resolve } from 'node:path';

import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { JsonValue, PluginPath } from '@happier-dev/plugin-sdk';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import type {
    AgentCliAuthContributionV1,
    AgentCliSessionCommandBuildOptionsResultV1,
    AgentCliSessionCommandDeclarationV1,
    AgentConnectedAccountLaunchContributionV1,
    AgentExperimentalVendorResumeSupportContributionV1,
    AgentPreflightSessionControlsCommandResultV1,
    AgentPreflightSessionControlsCommandV1,
    AgentPreflightSessionControlsContributionV1,
    AgentPreflightSessionControlsProbeContextV1,
    AgentProviderCliAttachDeclarationV1,
    AgentSessionStartupContributionV1,
    AgentTerminalPromptSubmitVerificationPolicyV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    isPluginAgentCliAuthBackgroundCheckSafe,
    StrictJsonValueSchema,
    type PluginAgentCliMetadata,
} from '@happier-dev/protocol';
import { type PluginSystemToolContributionV1 } from '@happier-dev/protocol/plugins/contributions/system-tools';

import type { PreflightSessionControlsProbeParams } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import type { CliAuthSpec, CliAuthStatusDraft } from '@/capabilities/cliAuth/types';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import type {
    CatalogAgentId,
    ConnectedServiceStateSharingDescriptor,
} from '@/agent/catalog/types';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { projectPluginSystemToolContributions } from '@/plugins/runtime/exec/system/tools/definitions';
import {
    createAgentCliSystemToolService,
    type AgentCliSystemToolBinding,
} from '@/plugins/runtime/exec/system/tools/agentCliBinding';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import type {
    ManagedServiceSessionBaseUrlResolver,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import type {
    ConnectedServiceProviderRuntimeAuthAdapter,
    ConnectedServiceRuntimeAuthAdapterResult,
} from '@/daemon/connectedServices/runtimeAuth/types';
import { createNativeAgentCliAuthStaticProbe } from './agentCliMetadata';

import type {
    ResolvedCatalogEntry,
    ResolvedAgentContribution,
} from './types';

type CatalogCliCommandHandler = Awaited<ReturnType<NonNullable<ResolvedCatalogEntry['getCliCommandHandler']>>>;
type RuntimeAuthTargetInput = Parameters<ConnectedServiceProviderRuntimeAuthAdapter['materializeActiveProfile']>[0];
type RuntimeAuthFailureInput = Parameters<ConnectedServiceProviderRuntimeAuthAdapter['classifyRuntimeAuthFailure']>[0];
type RuntimeAuthProviderOutcomeInput = Parameters<
    NonNullable<ConnectedServiceProviderRuntimeAuthAdapter['verifyProviderOutcome']>
>[0];
type VerifyResumeReachableInput = Parameters<NonNullable<ResolvedCatalogEntry['verifyResumeReachable']>>[0];
type SessionControlsProbeVariantInput = Parameters<
    NonNullable<ResolvedCatalogEntry['resolveSessionControlsProbeVariant']>
>[0];
type ModelsProbeVariantInput = Parameters<NonNullable<ResolvedCatalogEntry['resolveModelsProbeVariant']>>[0];
type SessionRuntimePreferencesInput = Parameters<
    NonNullable<ResolvedCatalogEntry['resolveSessionRuntimePreferences']>
>[0];
type RunBackendSessionCliCommand = typeof import('@/cli/runBackendSessionCliCommand')['runBackendSessionCliCommand'];
type ResolveSessionCommandResumeDelegation =
    typeof import('@/cli/sessionCommandResumeDelegation')['resolveSessionCommandResumeDelegation'];
type HandleResumeCommand = typeof import('@/cli/commands/resume')['handleResumeCommand'];
type CliSessionCommandHandlerDeps = Readonly<{
    runBackendSessionCliCommand?: RunBackendSessionCliCommand;
    resolveSessionCommandResumeDelegation?: ResolveSessionCommandResumeDelegation;
    handleResumeCommand?: HandleResumeCommand;
}>;

/**
 * Projects the one bounded daemon-spawn hook contract onto a catalog entry.
 * Both declarative bundled contributions and activation-registered Agent
 * runtimes use this exact catalog seam.
 */
export function projectAgentDaemonSpawnHooksCatalogEntry(
    daemonSpawnHooks: DaemonSpawnHooks,
): Pick<ResolvedCatalogEntry, 'getDaemonSpawnHooks'> {
    return Object.freeze({
        getDaemonSpawnHooks: async () => daemonSpawnHooks,
    });
}

/**
 * Projects a generation-bound deferred-startup eligibility callback through
 * the sole host-owned Session bootstrap decision seam. A retired generation
 * fails closed before its Agent callback can influence a later Session.
 */
export function projectAgentSessionStartupCatalogEntry(params: Readonly<{
    sessionStartup: AgentSessionStartupContributionV1;
    isCurrent(): boolean;
}>): Pick<ResolvedCatalogEntry, 'shouldUseDeferredSessionStartup'> {
    return Object.freeze({
        shouldUseDeferredSessionStartup: (input) => (
            params.isCurrent() && params.sessionStartup.shouldUseDeferredBootstrap(input)
        ),
    });
}

/**
 * Projects an Agent-native experimental vendor-resume predicate. The static
 * manifest support level remains the canonical decision owner; catalogHooks
 * invokes this only for normalized `experimental` entries.
 */
export function projectAgentExperimentalVendorResumeSupportCatalogEntry(params: Readonly<{
    vendorResumeSupport: AgentExperimentalVendorResumeSupportContributionV1;
    isCurrent(): boolean;
}>): Pick<ResolvedCatalogEntry, 'getVendorResumeSupport'> {
    return Object.freeze({
        getVendorResumeSupport: async () => (input) => (
            params.isCurrent() && params.vendorResumeSupport.supportsVendorResume(input)
        ),
    });
}

/**
 * Projects the static, registration-owned Connected Account launch facts onto
 * the existing catalog seam. Account selection, grants, materialization,
 * filesystem custody, refresh, quota recovery, and Session lifecycle remain
 * with their established host owners.
 */
export function projectAgentConnectedAccountLaunchCatalogEntry(params: Readonly<{
    agentId: CatalogAgentId;
    connectedAccountLaunch: AgentConnectedAccountLaunchContributionV1;
    hostAccess?: ResolvedAgentContribution['hostAccess'];
    isCurrent(): boolean;
}>): Pick<
    ResolvedCatalogEntry,
    | 'connectedAccountRequestAuthUses'
    | 'connectedAccountFileEnvironmentUses'
    | 'connectedAccountEnvironmentUses'
    | 'connectedAccountSwitchContinuity'
    | 'getConnectedServiceStateSharingDescriptor'
    | 'getConnectedServiceRuntimeAuthAdapter'
    | 'verifyResumeReachable'
> {
    const requestAuthUses = params.connectedAccountLaunch.requestAuthUses;
    const fileEnvironmentUses = params.connectedAccountLaunch.fileEnvironmentUses;
    const environmentUses = params.connectedAccountLaunch.environmentUses;
    const switchContinuity = params.connectedAccountLaunch.switchContinuity;
    const stateSharingDescriptor = params.connectedAccountLaunch.stateSharingDescriptor;
    const continuity = params.connectedAccountLaunch.continuity;
    const nativeAuthCodec = continuity?.nativeAuthCodec;
    const nativeHomeEnvironmentKey = stateSharingDescriptor?.nativeHome?.environmentKey;
    if (
        fileEnvironmentUses !== undefined
        || environmentUses !== undefined
        || nativeHomeEnvironmentKey !== undefined
    ) {
        const admittedProcessEnvironmentKeys = new Set(
            [
                ...(params.hostAccess?.required ?? []),
                ...(params.hostAccess?.optional ?? []),
            ].flatMap((request) => request.capability === 'environment'
                ? request.scope.keys.map((key) => key.toLowerCase())
                : request.capability === 'process'
                    ? (request.scope.envKeys ?? []).map((key) => key.toLowerCase())
                    : []),
        );
        const environmentKeyIdentities = new Set<string>();
        for (const use of [
            ...(fileEnvironmentUses ?? []),
            ...(environmentUses ?? []),
            ...(nativeHomeEnvironmentKey === undefined ? [] : [{ environmentKey: nativeHomeEnvironmentKey }]),
        ]) {
            const identity = use.environmentKey.toLowerCase();
            if (!admittedProcessEnvironmentKeys.has(identity)) {
                throw new Error(`Agent '${params.agentId}' connected-account launch environment '${use.environmentKey}' is not declared in its process environment`);
            }
            if (environmentKeyIdentities.has(identity)) {
                throw new Error(`Agent '${params.agentId}' connected-account launch environment '${use.environmentKey}' is declared more than once`);
            }
            environmentKeyIdentities.add(identity);
        }
    }
    const descriptor: ConnectedServiceStateSharingDescriptor | undefined = stateSharingDescriptor === undefined
        ? undefined
        : Object.freeze({
            ...stateSharingDescriptor,
            providerId: params.agentId,
        });
    const retiredAdapterResult = Object.freeze({
        supported: false,
        reason: 'plugin_generation_retired',
    }) satisfies ConnectedServiceRuntimeAuthAdapterResult;
    const contributedAdapter = continuity?.runtimeAuthAdapter;
    const commonRuntimeAuthInput = (input: RuntimeAuthTargetInput) => Object.freeze({
        target: input.target,
        selection: input.selection,
    });
    const unavailableNativeAuthVerification = (reason: string) => Object.freeze({
        status: 'unavailable' as const,
        retryable: true,
        reason,
    });
    const inspectNativeAuth = nativeAuthCodec
        ? async (input: RuntimeAuthTargetInput) => {
            if (!params.isCurrent()) {
                return unavailableNativeAuthVerification('plugin_generation_retired');
            }
            if (!input.credential || !input.nativeHome || !stateSharingDescriptor) {
                return unavailableNativeAuthVerification('native_auth_materialization_unavailable');
            }
            try {
                const files = await input.nativeHome.readFiles(
                    stateSharingDescriptor.authIsolation.secretEntries,
                );
                if (!params.isCurrent()) {
                    return unavailableNativeAuthVerification('plugin_generation_retired');
                }
                return nativeAuthCodec.inspect({
                    selection: input.selection,
                    credential: input.credential,
                    files,
                });
            }
            catch {
                return unavailableNativeAuthVerification('native_auth_codec_failed');
            }
        }
        : undefined;
    const materializeNativeAuth = nativeAuthCodec
        ? async (input: RuntimeAuthTargetInput) => {
            if (!params.isCurrent()) {
                return unavailableNativeAuthVerification('plugin_generation_retired');
            }
            if (!input.credential || !input.nativeHome || !stateSharingDescriptor) {
                return unavailableNativeAuthVerification('native_auth_materialization_unavailable');
            }
            let materialization: ReturnType<typeof nativeAuthCodec.materialize>;
            try {
                materialization = nativeAuthCodec.materialize({
                    selection: input.selection,
                    credential: input.credential,
                });
            }
            catch {
                return unavailableNativeAuthVerification('native_auth_codec_failed');
            }
            if (!params.isCurrent()) {
                return unavailableNativeAuthVerification('plugin_generation_retired');
            }
            const currentness = await input.validateCurrentBeforeMutation?.();
            if (currentness?.current === false) {
                return unavailableNativeAuthVerification(currentness.reason);
            }
            await input.nativeHome.replaceFiles(materialization.files);
            return await inspectNativeAuth!(input);
        }
        : undefined;
    const runtimeAuthAdapter: ConnectedServiceProviderRuntimeAuthAdapter | null = contributedAdapter
        ? Object.freeze({
            classifyRuntimeAuthFailure: (input: RuntimeAuthFailureInput) => params.isCurrent()
                ? contributedAdapter.classifyRuntimeAuthFailure(input)
                : null,
            materializeActiveProfile: async (input: RuntimeAuthTargetInput) => {
                if (!params.isCurrent()) return retiredAdapterResult;
                const result = await contributedAdapter.materializeActiveProfile(commonRuntimeAuthInput(input));
                return params.isCurrent() ? result : retiredAdapterResult;
            },
            canHotApply: (input: RuntimeAuthTargetInput) => params.isCurrent()
                ? contributedAdapter.canHotApply({
                    ...commonRuntimeAuthInput(input),
                    ...(input.applySelectedAuthGeneration
                        ? { applySelectedAuthGeneration: input.applySelectedAuthGeneration }
                        : {}),
                    ...(materializeNativeAuth
                        ? { materializeNativeAuth: async () => await materializeNativeAuth(input) }
                        : {}),
                })
                : retiredAdapterResult,
            hotApply: async (input: RuntimeAuthTargetInput) => {
                if (!params.isCurrent()) return retiredAdapterResult;
                const result = await contributedAdapter.hotApply({
                    ...commonRuntimeAuthInput(input),
                    ...(input.applySelectedAuthGeneration
                        ? { applySelectedAuthGeneration: input.applySelectedAuthGeneration }
                        : {}),
                    ...(materializeNativeAuth
                        ? { materializeNativeAuth: async () => await materializeNativeAuth(input) }
                        : {}),
                });
                return params.isCurrent() ? result : retiredAdapterResult;
            },
            ...(contributedAdapter.verifyActiveAccount
                ? {
                    verifyActiveAccount: async (input: RuntimeAuthTargetInput) => {
                        if (!params.isCurrent()) {
                            return { status: 'unavailable' as const, retryable: false, reason: 'plugin_generation_retired' };
                        }
                        const result = await contributedAdapter.verifyActiveAccount!({
                            ...commonRuntimeAuthInput(input),
                            ...(input.readProviderAccount
                                ? { readProviderAccount: input.readProviderAccount }
                                : {}),
                            ...(inspectNativeAuth
                                ? { inspectNativeAuth: async () => await inspectNativeAuth(input) }
                                : {}),
                        });
                        return params.isCurrent()
                            ? result
                            : { status: 'unavailable' as const, retryable: false, reason: 'plugin_generation_retired' };
                    },
                }
                : {}),
            ...(contributedAdapter.verifyProviderOutcome
                ? {
                    verifyProviderOutcome: async (input: RuntimeAuthProviderOutcomeInput) => {
                        if (!params.isCurrent()) {
                            return { status: 'unavailable' as const, reason: 'plugin_generation_retired' };
                        }
                        const result = await contributedAdapter.verifyProviderOutcome!(input);
                        return params.isCurrent()
                            ? result
                            : { status: 'unavailable' as const, reason: 'plugin_generation_retired' };
                    },
                }
                : {}),
            probeQuota: async (input: RuntimeAuthTargetInput) => {
                if (!params.isCurrent()) return retiredAdapterResult;
                const result = await contributedAdapter.probeQuota({
                    ...commonRuntimeAuthInput(input),
                    ...(input.readProviderUsage
                        ? { readProviderUsage: input.readProviderUsage as (params?: JsonValue) => Promise<unknown> }
                        : {}),
                });
                return params.isCurrent() ? result : retiredAdapterResult;
            },
            refreshActiveProfile: async (input: RuntimeAuthTargetInput) => {
                if (!params.isCurrent()) return retiredAdapterResult;
                const result = await contributedAdapter.refreshActiveProfile(commonRuntimeAuthInput(input));
                return params.isCurrent() ? result : retiredAdapterResult;
            },
        })
        : null;
    return Object.freeze({
        ...(requestAuthUses === undefined
            ? {}
            : { connectedAccountRequestAuthUses: requestAuthUses }),
        ...(fileEnvironmentUses === undefined
            ? {}
            : { connectedAccountFileEnvironmentUses: fileEnvironmentUses }),
        ...(environmentUses === undefined
            ? {}
            : { connectedAccountEnvironmentUses: environmentUses }),
        ...(switchContinuity === undefined
            ? {}
            : { connectedAccountSwitchContinuity: switchContinuity }),
        ...(descriptor === undefined
            ? {}
            : { getConnectedServiceStateSharingDescriptor: async () => descriptor }),
        ...(runtimeAuthAdapter === null
            ? {}
            : { getConnectedServiceRuntimeAuthAdapter: async () => runtimeAuthAdapter }),
        ...(continuity?.verifyResumeReachable === undefined
            ? {}
            : {
                verifyResumeReachable: async (input: VerifyResumeReachableInput) => {
                    if (!params.isCurrent()) {
                        return { ok: false as const, reason: 'plugin_generation_retired' };
                    }
                    const result = await continuity.verifyResumeReachable!(input);
                    return params.isCurrent()
                        ? result
                        : { ok: false as const, reason: 'plugin_generation_retired' };
                },
            }),
    });
}

/**
 * Creates the provider CLI attach surface at the host boundary. The Agent
 * declaration supplies only static target/argv/health facts; this owner keeps
 * launch, reachability probing, credentials, and connection custody.
 */
export function projectAgentProviderCliAttachCatalogEntry(params: Readonly<{
    agentId: CatalogAgentId;
    pluginId: string;
    localAgentId: string;
    providerCliAttach: AgentProviderCliAttachDeclarationV1;
    resolveManagedServiceSessionBaseUrl?: ManagedServiceSessionBaseUrlResolver;
}>): Pick<ResolvedCatalogEntry, 'resolveHostAgentRuntimeSurfaces'> {
    const providerCliAttach = params.providerCliAttach;
    const resolveManagedServiceSessionBaseUrl = params.resolveManagedServiceSessionBaseUrl;
    return Object.freeze({
        resolveHostAgentRuntimeSurfaces: async () => {
            const { createProviderCliAttachSurface } = await import(
                '@/session/attach/providerCliAttach'
            );
            return Object.freeze({
                attach: createProviderCliAttachSurface({
                    agentId: params.agentId,
                    resolveTarget: providerCliAttach.resolveTarget,
                    createArgs: providerCliAttach.createArgs,
                    buildHealthUrl: providerCliAttach.buildHealthUrl,
                    ...(resolveManagedServiceSessionBaseUrl
                        ? {
                            readFallbackServerBaseUrl: async (input) => (
                                await resolveManagedServiceSessionBaseUrl({
                                    pluginId: params.pluginId,
                                    sessionId: input.sessionId,
                                    contributionId: `${params.pluginId}/agents/${params.localAgentId}`,
                                })
                            ),
                        }
                        : {}),
                }),
            });
        },
    });
}

/**
 * Projects Agent-native prompt recognition through the incumbent terminal-host
 * adapter seam. The policy cannot create or control a terminal; submission,
 * retry, lifecycle, cancellation, and cleanup stay with that host.
 */
export function projectAgentTerminalPromptSubmitVerificationCatalogEntry(params: Readonly<{
    terminalPromptSubmitVerification: AgentTerminalPromptSubmitVerificationPolicyV1;
    isCurrent(): boolean;
}>): Pick<ResolvedCatalogEntry, 'getTerminalPromptSubmitVerificationPolicy'> {
    const policy = Object.freeze({
        shouldVerifyAfterSubmit: (promptText: string) => params.isCurrent()
            && params.terminalPromptSubmitVerification.shouldVerifyAfterSubmit(promptText),
        ...(params.terminalPromptSubmitVerification.verifyBeforeSubmitStaging
            ? {
                verifyBeforeSubmitStaging: (input: Parameters<NonNullable<
                    AgentTerminalPromptSubmitVerificationPolicyV1['verifyBeforeSubmitStaging']
                >>[0]) => params.isCurrent()
                    && params.terminalPromptSubmitVerification.verifyBeforeSubmitStaging!(input),
            }
            : {}),
        verifyAfterSubmit: (input: Parameters<
            AgentTerminalPromptSubmitVerificationPolicyV1['verifyAfterSubmit']
        >[0]) => params.isCurrent()
            && params.terminalPromptSubmitVerification.verifyAfterSubmit(input),
    });
    return Object.freeze({
        getTerminalPromptSubmitVerificationPolicy: async () => params.isCurrent()
            ? policy
            : null,
    });
}

/**
 * Projects a generation-bound Agent auth callback through the one catalog auth
 * seam. The host supplies environment and executes only declared system tools;
 * the Agent interprets bounded command output into the shared auth result.
 */
export function projectAgentCliAuthCatalogEntry(params: Readonly<{
    agentId: CatalogAgentId;
    pluginId: string;
    cliAuth: AgentCliAuthContributionV1;
    cli: PluginAgentCliMetadata;
    runtimeSpec?: AgentCliRuntimeDescriptor | null;
    systemTools: readonly PluginSystemToolContributionV1[];
    agentCliSystemTool?: AgentCliSystemToolBinding | null;
    hostAccess?: ResolvedAgentContribution['hostAccess'];
    isCurrent(): boolean;
}>): Pick<ResolvedCatalogEntry, 'getCliAuthSpec'> {
    const staticProbe = createNativeAgentCliAuthStaticProbe(params.cli);
    const admittedSystemToolIds = new Set<string>();
    for (const request of params.hostAccess?.required ?? []) {
        if (request.capability !== 'process') continue;
        for (const executable of request.scope.executables) {
            if (executable.kind === 'systemTool') {
                if (typeof executable.id !== 'string' && executable.id.pluginId !== params.pluginId) {
                    continue;
                }
                admittedSystemToolIds.add(
                    typeof executable.id === 'string' ? executable.id : executable.id.localId,
                );
            }
        }
    }
    const admittedSystemTools = params.systemTools.filter((tool) => admittedSystemToolIds.has(tool.id));
    return Object.freeze({
        getCliAuthSpec: async (): Promise<CliAuthSpec> => ({
            binaryNames: [
                params.cli.executable.binaryName,
                ...(params.cli.executable.alternativeBinaryNames ?? []),
            ],
            isSafeForBackgroundChecks: isPluginAgentCliAuthBackgroundCheckSafe(params.cli),
            detectAuthStatus: async (): Promise<CliAuthStatusDraft> => {
                if (!params.isCurrent()) {
                    return { state: 'unknown', reason: 'probe_failed' };
                }
                const staticCredential = staticProbe?.readPresentCredential();
                if (staticCredential) return staticCredential;
                const executableEnvironment = Object.freeze(Object.fromEntries(
                    Object.entries(process.env).filter(
                        (entry): entry is [string, string] => typeof entry[1] === 'string',
                    ),
                ));
                const systemToolExec = createProviderScopedStableExecService({
                    cwd: process.cwd(),
                    environment: executableEnvironment,
                    systemTools: admittedSystemTools,
                    agentId: params.agentId,
                    runtimeSpec: params.runtimeSpec,
                    agentCliSystemTool: params.agentCliSystemTool,
                });
                const unavailable = () => ({
                    ok: false,
                    stdout: '',
                    stderr: '',
                    exitCode: null,
                });
                try {
                    const status = await params.cliAuth.detectAuthStatus({
                        runDeclaredSystemToolCommand: async ({ toolId, args, timeoutMs }) => {
                            try {
                                const resolved = await systemToolExec.systemTools.resolve({
                                    toolId,
                                    purpose: `Probe ${params.agentId} CLI authentication`,
                                });
                                const result = await runCliCommandBestEffort({
                                    resolvedPath: resolved.executablePath,
                                    args: [...args],
                                    timeoutMs,
                                });
                                return params.isCurrent() ? result : unavailable();
                            } catch {
                                return unavailable();
                            }
                        },
                    });
                    return params.isCurrent()
                        ? status
                        : { state: 'unknown', reason: 'probe_failed' };
                } catch {
                    return { state: 'unknown', reason: 'probe_failed' };
                }
            },
        }),
    });
}

const PREFLIGHT_COMMAND_OUTPUT_MAX_BYTES = 256 * 1024;
const PREFLIGHT_JSON_RPC_MAX_FRAME_BYTES = 32 * 1024 * 1024;

function readPreflightProbeEnvironment(
    environment: NodeJS.ProcessEnv | undefined,
): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(
        Object.entries(environment ?? process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
    ));
}

function readPreflightProbeInput(params: Readonly<{
    accountSettings?: Readonly<Record<string, unknown>> | null;
    environment: Readonly<Record<string, string>>;
}>): Readonly<{
    accountSettings: Readonly<Record<string, JsonValue>> | null;
    environment: Readonly<Record<string, boolean>>;
}> {
    const source = params.accountSettings;
    const settings: Record<string, JsonValue> = {};
    if (source) {
        for (const [key, value] of Object.entries(source)) {
            const parsed = StrictJsonValueSchema.safeParse(value);
            if (!parsed.success) {
                return Object.freeze({
                    accountSettings: null,
                    environment: Object.freeze(Object.fromEntries(
                        Object.keys(params.environment).map((key) => [key, true]),
                    )),
                });
            }
            settings[key] = parsed.data as JsonValue;
        }
    }
    return Object.freeze({
        accountSettings: source ? Object.freeze(settings) : null,
        environment: Object.freeze(Object.fromEntries(
            Object.keys(params.environment).map((key) => [key, true]),
        )),
    });
}

function applyPreflightCommandEnvironment(
    environment: Readonly<Record<string, string>>,
    command: AgentPreflightSessionControlsCommandV1,
): Readonly<Record<string, string>> {
    const allow = command.environmentKeys ? new Set(command.environmentKeys) : null;
    const exclude = command.environmentExcludeKeys
        ? new Set(command.environmentExcludeKeys)
        : null;
    const selected = Object.fromEntries(Object.entries(environment).filter(([key]) => (
        (allow === null || allow.has(key))
        && (exclude === null || !exclude.has(key))
    )));
    if (command.ci === 'omit') {
        delete selected.CI;
    } else {
        selected.CI = '1';
    }
    return Object.freeze(selected);
}

function isExactPreflightCommand(
    command: AgentPreflightSessionControlsCommandV1,
    requested: Readonly<{ toolId: string; args: readonly string[] }>,
): boolean {
    return command.toolId === requested.toolId
        && command.args.length === requested.args.length
        && command.args.every((arg, index) => arg === requested.args[index]);
}

function resolveDeclaredPreflightCommand(
    contribution: AgentPreflightSessionControlsContributionV1,
    requested: Readonly<{ toolId: string; args: readonly string[] }>,
): AgentPreflightSessionControlsCommandV1 | null {
    const candidates = [
        contribution.models?.command,
        contribution.models?.fallback?.command,
        contribution.jsonRpcCommand,
    ];
    return candidates.find((candidate): candidate is AgentPreflightSessionControlsCommandV1 => (
        candidate !== undefined && isExactPreflightCommand(candidate, requested)
    )) ?? null;
}

function readPreflightCommandResult(
    result: Awaited<ReturnType<ExecService['run']>>,
): AgentPreflightSessionControlsCommandResultV1 {
    const observed = result.termination.observed;
    return Object.freeze({
        ok: observed.kind === 'exit' && observed.exitCode === 0,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        exitCode: observed.kind === 'exit' ? observed.exitCode : null,
    });
}

function createPreflightProbeSignal(
    signal: AbortSignal | undefined,
    retirementSignal: AbortSignal,
): AbortSignal {
    return signal ? AbortSignal.any([signal, retirementSignal]) : retirementSignal;
}

/**
 * Projects a public Agent preflight declaration through the incumbent catalog
 * probe seam. The Agent receives only strict settings JSON, environment
 * presence, bounded command output, and a request-only JSON-RPC client. This
 * host remains the sole executor, cancellation/currentness owner, and result
 * projection owner.
 */
export function projectAgentPreflightSessionControlsCatalogEntry(params: Readonly<{
    agentId: CatalogAgentId;
    preflightSessionControls: AgentPreflightSessionControlsContributionV1;
    systemTools: readonly PluginSystemToolContributionV1[];
    runtimeSpec?: AgentCliRuntimeDescriptor | null;
    agentCliSystemTool?: AgentCliSystemToolBinding | null;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
}>): Pick<ResolvedCatalogEntry,
    | 'needsAccountSettingsForProbes'
    | 'resolveModelsProbeVariant'
    | 'resolveSessionControlsProbeVariant'
    | 'getPreflightSessionControlsProbeAdapter'
> {
    const contribution = params.preflightSessionControls;
    const requiresAccountSettings = contribution.resolveProbeVariant !== undefined
        || contribution.jsonRpcCommand !== undefined;
    const resolveVariant = (input: Readonly<{
        accountSettings?: Readonly<Record<string, unknown>> | null;
    }>): string | null => {
        if (!params.isCurrent() || !contribution.resolveProbeVariant) return null;
        const output = contribution.resolveProbeVariant(readPreflightProbeInput({
            accountSettings: input.accountSettings,
            environment: readPreflightProbeEnvironment(undefined),
        }));
        return typeof output === 'string' && output.length > 0 ? output : null;
    };
    const createContext = (
        probeParams: PreflightSessionControlsProbeParams,
    ): AgentPreflightSessionControlsProbeContextV1 => {
        const signal = createPreflightProbeSignal(probeParams.signal, params.retirementSignal);
        const environment = readPreflightProbeEnvironment(probeParams.env);
        const input = readPreflightProbeInput({
            accountSettings: probeParams.accountSettings,
            environment,
        });
        const exec = createProviderScopedStableExecService({
            cwd: probeParams.cwd,
            environment,
            systemTools: params.systemTools,
            agentId: params.agentId,
            runtimeSpec: params.runtimeSpec,
            agentCliSystemTool: params.agentCliSystemTool,
            signal,
            isGenerationCurrent: params.isCurrent,
        });
        const assertCurrent = (): void => {
            if (!params.isCurrent() || signal.aborted) {
                throw new Error('Agent preflight belongs to a retired or cancelled generation');
            }
        };
        const unavailable = (): AgentPreflightSessionControlsCommandResultV1 => Object.freeze({
            ok: false,
            stdout: '',
            stderr: '',
            exitCode: null,
        });
        const runDeclaredSystemToolCommand: AgentPreflightSessionControlsProbeContextV1['runDeclaredSystemToolCommand'] =
            async (request) => {
                const command = resolveDeclaredPreflightCommand(contribution, request);
                if (!command) return unavailable();
                try {
                    assertCurrent();
                    const resolved = await exec.systemTools.resolve({
                        toolId: command.toolId,
                        purpose: `Probe ${params.agentId} Session controls`,
                        cwd: probeParams.cwd,
                        signal,
                    });
                    const result = await exec.run({
                        executable: resolved.executable,
                        args: command.args,
                        cwd: { root: 'workspace', relativePath: '' },
                        env: applyPreflightCommandEnvironment(environment, command),
                        maxStdoutBytes: PREFLIGHT_COMMAND_OUTPUT_MAX_BYTES,
                        maxStderrBytes: PREFLIGHT_COMMAND_OUTPUT_MAX_BYTES,
                        timeoutMs: probeParams.timeoutMs,
                    }, { signal });
                    assertCurrent();
                    return readPreflightCommandResult(result);
                } catch {
                    return unavailable();
                }
            };
        const withDeclaredJsonRpcClient: AgentPreflightSessionControlsProbeContextV1['withDeclaredJsonRpcClient'] =
            async (request, inspect) => {
                const command = contribution.jsonRpcCommand;
                if (!command || !isExactPreflightCommand(command, request)) {
                    throw new Error('Agent preflight JSON-RPC command is not declared');
                }
                assertCurrent();
                const resolved = await exec.systemTools.resolve({
                    toolId: command.toolId,
                    purpose: `Probe ${params.agentId} Session controls`,
                    cwd: probeParams.cwd,
                    signal,
                });
                const handle = await exec.clients.spawn({
                    kind: 'jsonRpc',
                    launch: {
                        executable: resolved.executable,
                        args: command.args,
                        cwd: { root: 'workspace', relativePath: '' },
                        env: applyPreflightCommandEnvironment(environment, command),
                        maxStderrBytes: PREFLIGHT_COMMAND_OUTPUT_MAX_BYTES,
                    },
                    framing: 'jsonLines',
                    maxFrameBytes: PREFLIGHT_JSON_RPC_MAX_FRAME_BYTES,
                    requestTimeoutMs: probeParams.timeoutMs,
                }, { signal });
                try {
                    const client = Object.freeze({
                        request: async (method: string, requestParams?: JsonValue): Promise<JsonValue> => (
                            await handle.client.request(method, requestParams, { signal })
                        ),
                    });
                    const result = await inspect(client, signal);
                    assertCurrent();
                    return result;
                } finally {
                    await handle.dispose();
                }
            };
        return Object.freeze({
            ...input,
            signal,
            runDeclaredSystemToolCommand,
            withDeclaredJsonRpcClient,
        });
    };
    const invoke = <T>(
        callback: ((context: AgentPreflightSessionControlsProbeContextV1) => Promise<T> | T) | undefined,
        probeParams: PreflightSessionControlsProbeParams,
    ): Promise<T | null> => callback
        ? Promise.resolve(callback(createContext(probeParams))).catch(() => null)
        : Promise.resolve(null);
    return Object.freeze({
        ...(requiresAccountSettings ? { needsAccountSettingsForProbes: true } : {}),
        ...(contribution.resolveProbeVariant
            ? {
                resolveSessionControlsProbeVariant: (variantParams: SessionControlsProbeVariantInput) => (
                    resolveVariant(variantParams)
                ),
                resolveModelsProbeVariant: (variantParams: ModelsProbeVariantInput) => (
                    resolveVariant(variantParams)
                ),
            }
            : {}),
        getPreflightSessionControlsProbeAdapter: async () => Object.freeze({
            // JSON-RPC preflight is the existing retryable probe form; static
            // command parsing uses the incumbent one-shot/cooldown behavior.
            ...(contribution.jsonRpcCommand ? { failureCacheStrategy: 'retry' as const } : {}),
            ...(contribution.models
                ? {
                    probeModelsRaw: async (probeParams: PreflightSessionControlsProbeParams) => {
                        const primary = await createContext(probeParams).runDeclaredSystemToolCommand({
                            toolId: contribution.models!.command.toolId,
                            args: contribution.models!.command.args,
                        });
                        if (primary.ok) {
                            const parsed = contribution.models!.parseOutput
                                ? await contribution.models!.parseOutput(primary)
                                : primary.stdout;
                            if (parsed !== null) return parsed;
                        }
                        const fallback = contribution.models!.fallback;
                        if (!fallback) return null;
                        const fallbackResult = await createContext(probeParams).runDeclaredSystemToolCommand({
                            toolId: fallback.command.toolId,
                            args: fallback.command.args,
                        });
                        if (!fallbackResult.ok) return null;
                        return fallback.parseOutput
                            ? await fallback.parseOutput(fallbackResult)
                            : fallbackResult.stdout;
                    },
                }
                : {}),
            ...(contribution.probeModels
                ? { probeModelsRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                    await invoke(contribution.probeModels, probeParams) }
                : {}),
            ...(contribution.probeModes
                ? { probeModesRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                    await invoke(contribution.probeModes, probeParams) }
                : {}),
            ...(contribution.probeConfigOptions
                ? { probeConfigOptionsRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                    await invoke(contribution.probeConfigOptions, probeParams) }
                : {}),
            ...(contribution.probePassiveRealtimeSetup
                ? { probePassiveRealtimeSetupRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                    await invoke(contribution.probePassiveRealtimeSetup, probeParams) }
                : {}),
        }),
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

type ResolvedAgentCliSessionCommandDeclaration = Readonly<{
    sessionRuntimeId: string;
    deprecatedAliasAgentId?: string;
    accountSettingsAgentId: string;
    implicitResumeDelegation?: Readonly<{ resumeFlags: readonly string[] }>;
    directoryFlags?: readonly string[];
    forwardModelFlag?: boolean;
    forwardResumeFlag?: boolean;
    yoloAgentArgs?: readonly string[];
    versionFlags?: readonly string[];
    infoCommandPrefixes?: readonly (readonly string[])[];
    buildSessionOptions?: AgentCliSessionCommandDeclarationV1['buildSessionOptions'];
}>;

function resolveAgentCliSessionCommandDeclaration(
    declaration: AgentCliSessionCommandDeclarationV1 | undefined,
    agentId: CatalogAgentId,
): ResolvedAgentCliSessionCommandDeclaration {
    return Object.freeze({
        sessionRuntimeId: declaration?.sessionRuntimeId ?? agentId,
        ...(declaration?.deprecatedAliasAgentId
            ? { deprecatedAliasAgentId: declaration.deprecatedAliasAgentId }
            : {}),
        accountSettingsAgentId: declaration?.accountSettingsAgentId ?? agentId,
        ...(declaration?.implicitResumeDelegation
            ? { implicitResumeDelegation: declaration.implicitResumeDelegation }
            : {}),
        ...(declaration?.directoryFlags ? { directoryFlags: declaration.directoryFlags } : {}),
        ...(declaration?.forwardModelFlag !== undefined
            ? { forwardModelFlag: declaration.forwardModelFlag }
            : {}),
        ...(declaration?.forwardResumeFlag !== undefined
            ? { forwardResumeFlag: declaration.forwardResumeFlag }
            : {}),
        ...(declaration?.yoloAgentArgs ? { yoloAgentArgs: declaration.yoloAgentArgs } : {}),
        ...(declaration?.versionFlags ? { versionFlags: declaration.versionFlags } : {}),
        ...(declaration?.infoCommandPrefixes
            ? { infoCommandPrefixes: declaration.infoCommandPrefixes }
            : {}),
        ...(declaration?.buildSessionOptions
            ? { buildSessionOptions: declaration.buildSessionOptions }
            : {}),
    });
}

function normalizeAgentCliSessionCommandOptions(
    value: AgentCliSessionCommandBuildOptionsResultV1,
): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error('Agent CLI session command returned an invalid result.');
    }
    if (value.ok === false) {
        const errorMessage = readString(value.errorMessage) ?? 'Agent CLI session command rejected the request.';
        throw new Error(errorMessage);
    }
    if (value.ok !== true || !isRecord(value.options)) {
        throw new Error('Agent CLI session command returned an invalid result.');
    }
    const options: Record<string, unknown> = {};
    for (const [key, option] of Object.entries(value.options)) {
        if (option !== undefined && !StrictJsonValueSchema.safeParse(option).success) {
            throw new Error(`Agent CLI session command returned a non-JSON Session option '${key}'.`);
        }
        options[key] = option;
    }
    return options;
}

/**
 * Projects a focused Agent command declaration through the one host-owned
 * parser and dispatcher. Omission intentionally creates the generic command
 * handler, not a second fallback path.
 */
export function projectAgentCliSessionCommandCatalogEntry(params: Readonly<{
    agentId: CatalogAgentId;
    cliSessionCommand?: AgentCliSessionCommandDeclarationV1;
    isCurrent?: () => boolean;
}>): Pick<ResolvedCatalogEntry, 'getCliCommandHandler' | 'resolveSessionRuntimePreferences'> {
    const cliSessionCommand = resolveAgentCliSessionCommandDeclaration(
        params.cliSessionCommand,
        params.agentId,
    );
    const isCurrent = params.isCurrent ?? (() => true);
    return Object.freeze({
        getCliCommandHandler: createCliSessionCommandHandler(
            cliSessionCommand,
            {
                cliSubcommand: params.agentId,
                runtimeAuthorityAgentId: params.agentId,
            },
            {},
            isCurrent,
        ),
        ...(cliSessionCommand.buildSessionOptions
            ? {
                resolveSessionRuntimePreferences: (input: SessionRuntimePreferencesInput) => {
                    if (!isCurrent()) return {};
                    const result = normalizeAgentCliSessionCommandOptions(
                        cliSessionCommand.buildSessionOptions!(input),
                    );
                    return isCurrent() ? result : {};
                },
            }
            : {}),
    });
}

export function createCliSessionCommandHandler(
    cliSessionCommand: ResolvedAgentCliSessionCommandDeclaration,
    identity: Readonly<{
        cliSubcommand: string;
        runtimeAuthorityAgentId: string;
    }>,
    deps: CliSessionCommandHandlerDeps = {},
    isCurrent: () => boolean = () => true,
) {
    return async () => {
        if (!isCurrent()) return async () => undefined;
        const runBackendSessionCliCommand = deps.runBackendSessionCliCommand
            ?? (await import('@/cli/runBackendSessionCliCommand')).runBackendSessionCliCommand;
        if (!isCurrent()) return async () => undefined;
        return async (context: Parameters<CatalogCliCommandHandler>[0]) => {
            if (!isCurrent()) return;
            if (cliSessionCommand.implicitResumeDelegation) {
                const resolveSessionCommandResumeDelegation = deps.resolveSessionCommandResumeDelegation
                    ?? (await import('@/cli/sessionCommandResumeDelegation')).resolveSessionCommandResumeDelegation;
                const decision = await resolveSessionCommandResumeDelegation({
                    args: context.args,
                    explicitProviderSubcommand:
                        context.args[0] === identity.cliSubcommand,
                    resumeFlags: cliSessionCommand.implicitResumeDelegation.resumeFlags,
                });
                if (!isCurrent()) return;
                if (decision.kind === 'delegate') {
                    const handleResumeCommand = deps.handleResumeCommand
                        ?? (await import('@/cli/commands/resume')).handleResumeCommand;
                    await handleResumeCommand([decision.sessionId], {
                        terminalRuntime: context.terminalRuntime,
                        rawArgv: context.rawArgv,
                    });
                    if (!isCurrent()) return;
                    return;
                }
            }

            if (!isCurrent()) return;
            await runBackendSessionCliCommand({
                context,
                backendIdForSessionRuntime: cliSessionCommand.sessionRuntimeId,
                runtimeAuthorityAgentId: identity.runtimeAuthorityAgentId,
                isExplicitCliSubcommand: context.args[0] === identity.cliSubcommand,
                ...(cliSessionCommand.deprecatedAliasAgentId
                    ? {
                        agentIdForDeprecatedAliases: cliSessionCommand.deprecatedAliasAgentId as Parameters<typeof runBackendSessionCliCommand>[0]['agentIdForDeprecatedAliases'],
                    }
                    : {}),
                ...(cliSessionCommand.accountSettingsAgentId
                    ? {
                        agentIdForAccountSettings: cliSessionCommand.accountSettingsAgentId as Parameters<typeof runBackendSessionCliCommand>[0]['agentIdForAccountSettings'],
                    }
                    : {}),
                ...(cliSessionCommand.directoryFlags ? { directoryFlags: cliSessionCommand.directoryFlags } : {}),
                ...(cliSessionCommand.forwardModelFlag !== undefined
                    ? { forwardModelFlag: cliSessionCommand.forwardModelFlag }
                    : {}),
                ...(cliSessionCommand.forwardResumeFlag !== undefined
                    ? { forwardResumeFlag: cliSessionCommand.forwardResumeFlag }
                    : {}),
                ...(cliSessionCommand.yoloAgentArgs ? { yoloProviderArgs: cliSessionCommand.yoloAgentArgs } : {}),
                ...(cliSessionCommand.versionFlags ? { versionFlags: cliSessionCommand.versionFlags } : {}),
                ...(cliSessionCommand.infoCommandPrefixes
                    ? { providerInfoCommandPrefixes: cliSessionCommand.infoCommandPrefixes }
                    : {}),
            });
            if (!isCurrent()) return;
        };
    };
}

function createProviderScopedStableExecService(params: Readonly<{
    cwd: string;
    environment: Readonly<Record<string, string>>;
    systemTools: readonly PluginSystemToolContributionV1[];
    agentId?: CatalogAgentId;
    runtimeSpec?: AgentCliRuntimeDescriptor | null;
    agentCliSystemTool?: AgentCliSystemToolBinding | null;
    signal?: AbortSignal;
    isGenerationCurrent?: () => boolean;
}>): ExecService {
    const workspaceRoot = resolve(params.cwd);
    const definitions = projectPluginSystemToolContributions(params.systemTools);
    const unboundSystemTools = createPluginExecSystemToolResolver({
        definitions,
        baseEnv: params.environment,
        // Stable invocation services consume the launch immediately, so no
        // legacy grant identity crosses this projection boundary.
        registerGrant() {},
    });
    const boundDefinition = params.agentCliSystemTool
        ? definitions.find((definition) => definition.toolId === params.agentCliSystemTool?.toolId)
        : undefined;
    const systemTools = params.agentId
        && params.runtimeSpec
        && params.agentCliSystemTool
        && boundDefinition
        ? createAgentCliSystemToolService({
            agentId: params.agentId,
            runtimeSpec: params.runtimeSpec,
            binding: params.agentCliSystemTool,
            definition: boundDefinition,
            processEnv: { ...params.environment },
            delegate: unboundSystemTools,
        })
        : unboundSystemTools;
    return createStablePluginExecService({
        allowedExecutables: params.systemTools.map((tool) => Object.freeze({
            kind: 'systemTool' as const,
            id: tool.id,
        })),
        allowedEnvKeys: Object.freeze([...new Set([...Object.keys(params.environment), 'CI'])]),
        environment: Object.freeze({}),
        allowedCwdScopes: Object.freeze([{
            root: 'workspace' as const,
            pathPrefix: '',
            access: Object.freeze(['read' as const]),
        }]),
        signal: params.signal ?? new AbortController().signal,
        isGenerationCurrent: params.isGenerationCurrent ?? (() => true),
        async resolveExecutable() {
            throw new Error('Provider preflight executables must resolve through a declared system tool');
        },
        async resolvePath(path: PluginPath) {
            if (path.root !== 'workspace') {
                throw new Error('Provider preflight working directories must use the scoped workspace root');
            }
            const resolvedPath = resolve(workspaceRoot, path.relativePath);
            const relativePath = resolvedPath.slice(workspaceRoot.length);
            if (
                resolvedPath !== workspaceRoot
                && !relativePath.startsWith('/')
                && !relativePath.startsWith('\\')
            ) {
                throw new Error('Provider preflight working directory escaped the scoped workspace root');
            }
            return resolvedPath;
        },
        systemTools,
    });
}
