import { join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';

import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { JsonValue, PluginPath } from '@happier-dev/plugin-sdk';
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
import { getAgentCliRuntimeSpec } from '@happier-dev/agents/cli/runtime';
import { isBundledAgentId } from '@happier-dev/agents/agent-ids';
import {
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol/account/settings/connected-services';
import {
    isPluginAgentCliAuthBackgroundCheckSafe,
    StrictJsonValueSchema,
    type PluginAgentCliMetadata,
} from '@happier-dev/protocol';
import { ConnectedAccountRequestAuthUsesV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { readConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol/connect/connected-service-limit-category';
import { type ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { type PluginSystemToolContributionV1 } from '@happier-dev/protocol/plugins/contributions/system-tools';

import type { PreflightSessionControlsProbeParams } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import {
    hasExactConnectedServiceRestartContinuityContext,
    isConnectedToConnectedServiceSwitch,
    isExactSameConnectedServiceSelection,
    isSameConnectedServiceAuthGroup,
    providerSessionStateUnavailableForResume,
} from '@/daemon/connectedServices/switchContinuityContext';
import type {
    CatalogAgentId,
    ConnectedServiceStateSharingDescriptor,
    ConnectedServiceSwitchContinuityParams,
    ConnectedServiceSwitchContinuityResult,
} from '@/agent/catalog/types';
import {
    resolveConnectedServiceCredentialResolutions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
    resolveConnectedServiceGroupHomeDir,
    resolveConnectedServiceHomeDir,
} from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import {
    createRetainedConnectedServicesMaterialization,
    type ConnectedServiceMaterializationCredentialRefreshFailureCategory,
    type ConnectedServicesMaterializationDiagnostic,
    type ConnectedServicesMaterializer,
} from '@/daemon/connectedServices/materialization/materializer';
import {
    ensurePrivateConnectedServiceMaterializedRoot,
} from '@/daemon/connectedServices/materialize/privateMaterializedRoot';
import { parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';
import { createRestartResumeConnectedServiceRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/createRestartResumeConnectedServiceRuntimeAuthAdapter';
import type {
    ConnectedServiceProviderRuntimeAuthAdapter,
    ConnectedServiceRuntimeFailureClassification,
} from '@/daemon/connectedServices/runtimeAuth/types';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { sanitizeConnectedServiceDiagnosticString } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import { canResumeFromMaterializedStateCore } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedStateCore';
import { REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON } from '@/daemon/connectedServices/verifyResumeReachableTypes';
import { applyConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import {
    withConnectedServiceStateSharingDestinationLock,
    withConnectedServiceStateSharingLocks,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
    readConnectedServiceStateSharingManifest,
    writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { configuration } from '@/configuration';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import {
    readSessionHandoffContribution,
} from './sessionHandoffContribution';
import { projectPluginSystemToolContributions } from '@/plugins/runtime/exec/system/tools/definitions';
import {
    createAgentCliSystemToolService,
    type AgentCliSystemToolBinding,
} from '@/plugins/runtime/exec/system/tools/agentCliBinding';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { createNativeAgentCliAuthStaticProbe } from './agentCliMetadata';

import type {
    ResolvedCatalogEntry,
    ResolvedAgentContribution,
} from './types';
import type {
    ConnectedServiceStateSharingDescriptorResult,
    ConnectedServicesContribution,
    AgentRuntimeContribution,
    VerifyResumeReachable,
} from './agentRuntimeContribution';

type CredentialRecord = ConnectedServiceCredentialRecordV1;
type AgentCatalogHookFactory = () => Partial<NonNullable<ResolvedAgentContribution['catalogEntry']>>;
type CatalogCliCommandHandler = Awaited<ReturnType<NonNullable<ResolvedCatalogEntry['getCliCommandHandler']>>>;
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
}>): Pick<
    ResolvedCatalogEntry,
    'connectedAccountRequestAuthUses' | 'getConnectedServiceStateSharingDescriptor'
> {
    const requestAuthUses = params.connectedAccountLaunch.requestAuthUses;
    const stateSharingDescriptor = params.connectedAccountLaunch.stateSharingDescriptor;
    const descriptor: ConnectedServiceStateSharingDescriptor | undefined = stateSharingDescriptor === undefined
        ? undefined
        : Object.freeze({
            ...stateSharingDescriptor,
            providerId: params.agentId,
        });
    return Object.freeze({
        ...(requestAuthUses === undefined
            ? {}
            : { connectedAccountRequestAuthUses: requestAuthUses }),
        ...(descriptor === undefined
            ? {}
            : { getConnectedServiceStateSharingDescriptor: async () => descriptor }),
    });
}

/**
 * Creates the provider CLI attach surface at the host boundary. The Agent
 * declaration supplies only static target/argv/health facts; this owner keeps
 * launch, reachability probing, credentials, and connection custody.
 */
export function projectAgentProviderCliAttachCatalogEntry(params: Readonly<{
    agentId: CatalogAgentId;
    providerCliAttach: AgentProviderCliAttachDeclarationV1;
}>): Pick<ResolvedCatalogEntry, 'resolveHostAgentRuntimeSurfaces'> {
    const providerCliAttach = params.providerCliAttach;
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
}>): Pick<ResolvedCatalogEntry, 'getTerminalPromptSubmitVerificationPolicy'> {
    return Object.freeze({
        getTerminalPromptSubmitVerificationPolicy: async () => (
            params.terminalPromptSubmitVerification
        ),
    });
}

/**
 * Projects a generation-bound Agent auth callback through the one catalog auth
 * seam. The host supplies environment and executes only declared system tools;
 * the Agent interprets bounded command output into the shared auth result.
 */
export function projectAgentCliAuthCatalogEntry(params: Readonly<{
    agentId: CatalogAgentId;
    cliAuth: AgentCliAuthContributionV1;
    cli: PluginAgentCliMetadata | null;
    systemTools: readonly PluginSystemToolContributionV1[];
    agentCliSystemTool?: AgentCliSystemToolBinding | null;
    hostAccess?: ResolvedAgentContribution['hostAccess'];
    isCurrent(): boolean;
}>): Pick<ResolvedCatalogEntry, 'getCliAuthSpec'> {
    const staticProbe = params.cli
        ? createNativeAgentCliAuthStaticProbe(params.cli)
        : null;
    const admittedSystemToolIds = new Set<string>();
    for (const request of params.hostAccess?.required ?? []) {
        if (request.capability !== 'process') continue;
        for (const executable of request.scope.executables) {
            if (executable.kind === 'systemTool') admittedSystemToolIds.add(executable.id);
        }
    }
    const admittedSystemTools = params.systemTools.filter((tool) => admittedSystemToolIds.has(tool.id));
    return Object.freeze({
        getCliAuthSpec: async () => {
            const { createCatalogCliAuthSpec } = await import(
                '@/capabilities/cliAuth/createCatalogCliAuthSpec'
            );
            return createCatalogCliAuthSpec(params.agentId, {
                isSafeForBackgroundChecks: params.cli !== null
                    && isPluginAgentCliAuthBackgroundCheckSafe(params.cli),
                detectAuthStatus: async () => {
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
            });
        },
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
                resolveSessionControlsProbeVariant: (variantParams) => resolveVariant(variantParams),
                resolveModelsProbeVariant: (variantParams) => resolveVariant(variantParams),
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

type MaterializedAuthEnvironmentResult = Awaited<ReturnType<ConnectedServicesContribution['materializeAuthEnvironment']>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readAgentCliSystemToolBinding(
    value: unknown,
    systemTools: readonly PluginSystemToolContributionV1[],
): AgentCliSystemToolBinding | null {
    if (value === undefined) return null;
    if (!isRecord(value)) {
        throw new Error('Agent CLI system-tool binding must be an object with a toolId');
    }
    if (Object.keys(value).some((key) => key !== 'toolId')) {
        throw new Error('Agent CLI system-tool binding accepts only toolId');
    }
    const toolId = readString(value.toolId);
    if (!toolId) {
        throw new Error('Agent CLI system-tool binding toolId must be a non-empty string');
    }
    if (!systemTools.some((tool) => tool.id === toolId)) {
        throw new Error(`Agent CLI system-tool binding '${toolId}' must name a declared system tool`);
    }
    return Object.freeze({ toolId });
}

function readFunction<T>(value: unknown): T | null {
    return typeof value === 'function' ? value as T : null;
}

function readPositiveNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function readProviderHttpStatus(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
        ? value
        : null;
}

function readMaterializationCredentialRefreshFailureCategory(
    value: unknown,
): ConnectedServiceMaterializationCredentialRefreshFailureCategory | null {
    switch (value) {
        case 'invalid_grant':
        case 'invalid_client':
        case 'provider_401':
        case 'provider_403':
        case 'network_error':
        case 'malformed_response':
        case 'missing_access_token':
        case 'missing_refresh_token':
        case 'unknown':
            return value;
        default:
            return null;
    }
}

function normalizeMaterializationCredentialRefreshFailure(value: unknown): ConnectedServicesMaterializationDiagnostic['credentialRefreshFailure'] {
    const record = isRecord(value) ? value : null;
    if (!record) return undefined;
    const category = readMaterializationCredentialRefreshFailureCategory(record.category);
    if (!category) return undefined;
    const providerStatus = readProviderHttpStatus(record.providerStatus);
    const providerErrorCode = readString(record.providerErrorCode);
    return {
        category,
        ...(providerStatus !== null ? { providerStatus } : {}),
        ...(providerErrorCode ? { providerErrorCode } : {}),
    };
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readNonEmptyStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
            const stringValue = readString(entry);
            return stringValue ? [stringValue] : [];
        })
        : [];
}

function readNonEmptyStringArrayArray(value: unknown): readonly (readonly string[])[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
            const stringArray = readNonEmptyStringArray(entry);
            return stringArray.length > 0 ? [stringArray] : [];
        })
        : [];
}

function readStringFunction(value: unknown): ((input: string) => string) | null {
    return typeof value === 'function' ? value as (input: string) => string : null;
}

function readConnectedServiceIdArray(value: unknown): readonly ConnectedServiceId[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const parsed = ConnectedServiceIdSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

function readRuntimeAuthAdapter(value: unknown): ConnectedServicesContribution['runtimeAuthAdapter'] {
    if (value === false) return false;
    if (!isRecord(value)) return undefined;
    return typeof value.classifyRuntimeAuthFailure === 'function'
        && typeof value.materializeActiveProfile === 'function'
        && typeof value.canHotApply === 'function'
        && typeof value.hotApply === 'function'
        && typeof value.recoverAfterRuntimeAuthSwitch === 'function'
        && typeof value.probeQuota === 'function'
        && typeof value.refreshActiveProfile === 'function'
        ? value as ConnectedServicesContribution['runtimeAuthAdapter']
        : undefined;
}

function serializeRuntimeAuthDestinationTransitions(
    agentId: CatalogAgentId,
    adapter: ConnectedServiceProviderRuntimeAuthAdapter,
): ConnectedServiceProviderRuntimeAuthAdapter {
    const run = async <T>(
        input: Parameters<ConnectedServiceProviderRuntimeAuthAdapter['hotApply']>[0],
        operation: () => Promise<T>,
    ): Promise<T> => {
        const destinationHome = adapter.resolveDestinationHome?.(input) ?? null;
        return destinationHome
            ? await withConnectedServiceStateSharingDestinationLock(destinationHome, operation, { providerId: agentId })
            : await operation();
    };
    return {
        ...adapter,
        hotApply: async (input) => await run(input, async () => {
            const currentness = await input.validateCurrentBeforeMutation?.();
            if (currentness?.current === false) {
                return {
                    applied: false,
                    ...(currentness.authoritativeTarget
                        ? {
                            status: 'superseded_after_apply',
                            activeProfileId: currentness.authoritativeTarget.profileId,
                            generation: currentness.authoritativeTarget.generation,
                            credentialRevision: currentness.authoritativeTarget.credentialRevision,
                        }
                        : {}),
                    reason: currentness.reason,
                    recovery: 'none',
                };
            }
            return await adapter.hotApply(input);
        }),
        ...(adapter.verifyActiveAccount
            ? {
                verifyActiveAccount: async (input) => await run(
                    input,
                    async () => await adapter.verifyActiveAccount!(input),
                ),
            }
            : {}),
    };
}

function readQuotaFetcherDescriptor(value: unknown): ConnectedServicesContribution['quotaFetcherDescriptor'] {
    if (!isRecord(value)) return undefined;
    const id = readString(value.id);
    const createFetcher = readFunction<
        NonNullable<ConnectedServicesContribution['quotaFetcherDescriptor']>['createFetcher']
    >(value.createFetcher);
    const terminalAuthFailureProviderCodes = readNonEmptyStringArray(value.terminalAuthFailureProviderCodes);
    return id && createFetcher
        ? {
            id,
            createFetcher,
            ...(terminalAuthFailureProviderCodes.length > 0 ? { terminalAuthFailureProviderCodes } : {}),
        }
        : undefined;
}

function resolveProjectedResumeReachability(
    connectedServices: ConnectedServicesContribution | null,
): VerifyResumeReachable {
    return connectedServices?.verifyResumeReachable
        ?? connectedServices?.resolveResumeReachabilityUnsupported
        ?? (async () => ({ ok: false, reason: REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON }));
}

function readPredictiveSoftSwitchLiveSessionRequirement(value: unknown): NonNullable<
    NonNullable<ConnectedServicesContribution['recoveryCapabilities']>['predictiveSoftSwitch']['liveSessionRequirement']
> | null | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) return null;
    if (value.kind === 'none') return { kind: 'none' };
    if (value.kind !== 'shared_group_auth_surface') return null;
    const serviceIds = readConnectedServiceIdArray(value.serviceIds);
    const authEnvKey = typeof value.authEnvKey === 'string' ? value.authEnvKey.trim() : '';
    if (serviceIds.length === 0 || !authEnvKey) return null;
    const authEnvSubpath = readStringArray(value.authEnvSubpath);
    return {
        kind: 'shared_group_auth_surface',
        serviceIds,
        authEnvKey,
        ...(authEnvSubpath.length > 0 ? { authEnvSubpath } : {}),
    };
}

function readRuntimeAuthApplyCapability(value: unknown): NonNullable<
    ConnectedServicesContribution['recoveryCapabilities']
>['runtimeAuthApply'] | null | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) return null;
    const directLiveHotAuth = value.directLiveHotAuth;
    if (directLiveHotAuth === 'unsupported') return { directLiveHotAuth: 'unsupported' };
    if (!isRecord(directLiveHotAuth)) return null;
    if (typeof directLiveHotAuth.supportsInTurnApply !== 'boolean') return null;
    if (typeof directLiveHotAuth.requiresExactRuntimeIdentity !== 'boolean') return null;
    if (
        directLiveHotAuth.refreshSelectionResync !== 'required'
        && directLiveHotAuth.refreshSelectionResync !== 'not_applicable'
    ) {
        return null;
    }
    const authMode = readRuntimeAuthApplyAuthMode(directLiveHotAuth.authMode);
    if (!authMode) return null;
    return {
        directLiveHotAuth: {
            supportsInTurnApply: directLiveHotAuth.supportsInTurnApply,
            requiresExactRuntimeIdentity: directLiveHotAuth.requiresExactRuntimeIdentity,
            refreshSelectionResync: directLiveHotAuth.refreshSelectionResync,
            authMode,
        },
    };
}

function readRuntimeAuthApplyAuthMode(
    value: unknown,
): NonNullable<
    Exclude<
        NonNullable<
            NonNullable<ConnectedServicesContribution['recoveryCapabilities']>['runtimeAuthApply']
        >['directLiveHotAuth'],
        'unsupported'
    >['authMode']
> | null {
    if (!isRecord(value)) return null;
    if (value.kind === 'managed_provider_session') return { kind: 'managed_provider_session' };
    if (value.kind === 'api_key') return { kind: 'api_key' };
    if (value.kind === 'external_token_injection') {
        const surface = typeof value.surface === 'string' ? value.surface.trim() : '';
        return surface ? { kind: 'external_token_injection', surface } : null;
    }
    if (value.kind === 'provider_owned') {
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        return name ? { kind: 'provider_owned', name } : null;
    }
    return null;
}

function readConnectedServiceRecoveryCapabilities(
    value: unknown,
): NonNullable<ConnectedServicesContribution['recoveryCapabilities']> | null {
    if (!isRecord(value)) return null;
    const predictiveSoftSwitch = isRecord(value.predictiveSoftSwitch) ? value.predictiveSoftSwitch : null;
    const mode = predictiveSoftSwitch?.mode;
    if (mode !== 'supported' && mode !== 'unsupported') return null;
    const liveSessionRequirement = readPredictiveSoftSwitchLiveSessionRequirement(
        predictiveSoftSwitch?.liveSessionRequirement,
    );
    if (liveSessionRequirement === null) return null;
    const runtimeAuthApply = readRuntimeAuthApplyCapability(value.runtimeAuthApply);
    if (runtimeAuthApply === null) return null;
    const sameAccountFanoutStrategy = value.sameAccountFanoutStrategy;
    const generationApplicationScope = value.generationApplicationScope;
    const sharedGenerationApplicationServiceIds = readConnectedServiceIdArray(
        value.sharedGenerationApplicationServiceIds,
    );
    return {
        predictiveSoftSwitch: {
            mode,
            ...(liveSessionRequirement === undefined ? {} : { liveSessionRequirement }),
        },
        ...(sameAccountFanoutStrategy === 'provider_account_id'
            || sameAccountFanoutStrategy === 'shared_group_auth_surface'
            || sameAccountFanoutStrategy === 'none'
            ? { sameAccountFanoutStrategy }
            : {}),
        ...(generationApplicationScope === 'per_session_runtime'
            || generationApplicationScope === 'shared_group_auth_surface'
            || generationApplicationScope === 'request_time_auth'
            || generationApplicationScope === 'unsupported'
            ? { generationApplicationScope }
            : {}),
        ...(sharedGenerationApplicationServiceIds.length > 0
            ? { sharedGenerationApplicationServiceIds }
            : {}),
        ...(runtimeAuthApply === undefined ? {} : { runtimeAuthApply }),
    };
}

function readConnectedServicesContribution(value: unknown): ConnectedServicesContribution | null {
    if (!isRecord(value)) return null;
    const serviceIds = readConnectedServiceIdArray(value.serviceIds);
    const requestAuthUses = value.requestAuthUses === undefined
        ? null
        : ConnectedAccountRequestAuthUsesV1Schema.safeParse(value.requestAuthUses);
    const stateSharingServiceIds = readConnectedServiceIdArray(value.stateSharingServiceIds);
    const noRestartRequiredServiceIds = readConnectedServiceIdArray(value.noRestartRequiredServiceIds);
    const materializedHomeCredentialEntries = readStringArray(value.materializedHomeCredentialEntries);
    const resolveStateSharingSourceRoot = readFunction<ConnectedServicesContribution['resolveStateSharingSourceRoot']>(
        value.resolveStateSharingSourceRoot,
    );
    const resolveStateSharingStateEntryNames = readFunction<ConnectedServicesContribution['resolveStateSharingStateEntryNames']>(
        value.resolveStateSharingStateEntryNames,
    );
    const resolveStateSharingStateSourceRoot = readFunction<ConnectedServicesContribution['resolveStateSharingStateSourceRoot']>(
        value.resolveStateSharingStateSourceRoot,
    );
    const createStateSharingSessionImportRoots = readFunction<ConnectedServicesContribution['createStateSharingSessionImportRoots']>(
        value.createStateSharingSessionImportRoots,
    );
    const resolveVendorResumeIdFromImportedFile = readFunction<ConnectedServicesContribution['resolveVendorResumeIdFromImportedFile']>(
        value.resolveVendorResumeIdFromImportedFile,
    );
    const readConnectedServiceId = readFunction<ConnectedServicesContribution['readConnectedServiceId']>(
        value.readConnectedServiceId,
    );
    const createAuthMaterializationInput = readFunction<ConnectedServicesContribution['createAuthMaterializationInput']>(
        value.createAuthMaterializationInput,
    );
    const materializeAuthEnvironment = readFunction<ConnectedServicesContribution['materializeAuthEnvironment']>(
        value.materializeAuthEnvironment,
    );
    const isMaterializedHomeStale = readFunction<
        NonNullable<ConnectedServicesContribution['materializedHomeFreshness']>['isMaterializedHomeStale']
    >(value.isMaterializedHomeStale);
    const sanitizeRetainedMaterializedHome = readFunction<ConnectedServicesContribution['sanitizeRetainedMaterializedHome']>(
        value.sanitizeRetainedMaterializedHome,
    );
    const shouldRestartForServiceSwitch = readFunction<ConnectedServicesContribution['shouldRestartForServiceSwitch']>(
        value.shouldRestartForServiceSwitch,
    );
    const unsupportedSwitchReason = readFunction<ConnectedServicesContribution['unsupportedSwitchReason']>(
        value.unsupportedSwitchReason,
    );
    const verifyResumeReachable = readFunction<ConnectedServicesContribution['verifyResumeReachable']>(
        value.verifyResumeReachable,
    );
    const resolveCandidatePersistedSessionFile = readFunction<
        NonNullable<ConnectedServicesContribution['resolveCandidatePersistedSessionFile']>
    >(value.resolveCandidatePersistedSessionFile);
    const resolveResumeReachabilityUnsupported = readFunction<ConnectedServicesContribution['resolveResumeReachabilityUnsupported']>(
        value.resolveResumeReachabilityUnsupported,
    );
    const classifyUsageLimitError = readFunction<ConnectedServicesContribution['classifyUsageLimitError']>(
        value.classifyUsageLimitError,
    );
    const runtimeAuthAdapter = readRuntimeAuthAdapter(value.runtimeAuthAdapter);
    const quotaFetcherDescriptor = readQuotaFetcherDescriptor(value.quotaFetcherDescriptor);
    const daemonAuthBridge = isRecord(value.daemonAuthBridge) ? value.daemonAuthBridge : null;
    const daemonAuthBridgeRefresh = readFunction<
        NonNullable<ConnectedServicesContribution['daemonAuthBridge']>['refresh']
    >(daemonAuthBridge?.refresh);
    const daemonAuthBridgeServiceIds = readConnectedServiceIdArray(daemonAuthBridge?.serviceIds);
    const restartRematerializeRequiredReason = readString(value.restartRematerializeRequiredReason);
    const connectedSwitchSharedStateRequiredReason = readString(value.connectedSwitchSharedStateRequiredReason);
    const nativeSwitchSharedStateRequiredReason = readString(value.nativeSwitchSharedStateRequiredReason);
    const usageLimitRecovery = isRecord(value.usageLimitRecovery) ? value.usageLimitRecovery : null;
    const usageLimitRecoveryOwnerId = readString(usageLimitRecovery?.agentId);
    const issueProviderFilter = readString(usageLimitRecovery?.issueProviderFilter);
    const parsedDefaultNativeServiceId = usageLimitRecovery?.defaultNativeServiceId === undefined
        ? null
        : ConnectedServiceIdSchema.safeParse(usageLimitRecovery.defaultNativeServiceId);
    const defaultNativeServiceId = parsedDefaultNativeServiceId?.success ? parsedDefaultNativeServiceId.data : null;
    const fallbackBackoffEnvKey = readString(usageLimitRecovery?.fallbackBackoffEnvKey);
    const maxAttemptsEnvKey = readString(usageLimitRecovery?.maxAttemptsEnvKey);
    const defaultFallbackBackoffMs = readPositiveNumber(usageLimitRecovery?.defaultFallbackBackoffMs);
    const defaultMaxAttempts = readPositiveNumber(usageLimitRecovery?.defaultMaxAttempts);
    const recoveryCapabilities = readConnectedServiceRecoveryCapabilities(value.recoveryCapabilities);
    const resolveLegacyRuntimeAuthFailureSourceRevision = readFunction<
        NonNullable<ConnectedServicesContribution['resolveLegacyRuntimeAuthFailureSourceRevision']>
    >(value.resolveLegacyRuntimeAuthFailureSourceRevision);
    const stateSharingDescriptor = value.stateSharingDescriptor as ConnectedServiceStateSharingDescriptorResult;
    if (
        serviceIds.length === 0
        || !readConnectedServiceId
        || !createAuthMaterializationInput
        || !materializeAuthEnvironment
        || !stateSharingDescriptor
        || requestAuthUses?.success === false
    ) {
        return null;
    }
    return {
        serviceIds,
        ...(requestAuthUses?.success
            ? { requestAuthUses: Object.freeze(requestAuthUses.data.map((use) => Object.freeze(use))) }
            : {}),
        ...(stateSharingServiceIds.length > 0 ? { stateSharingServiceIds } : {}),
        ...(noRestartRequiredServiceIds.length > 0 ? { noRestartRequiredServiceIds } : {}),
        ...(readString(value.materializedRootSubdir) ? { materializedRootSubdir: readString(value.materializedRootSubdir)! } : {}),
        ...(materializedHomeCredentialEntries.length > 0 ? { materializedHomeCredentialEntries } : {}),
        ...(resolveStateSharingSourceRoot ? { resolveStateSharingSourceRoot } : {}),
        ...(resolveStateSharingStateEntryNames ? { resolveStateSharingStateEntryNames } : {}),
        ...(resolveStateSharingStateSourceRoot ? { resolveStateSharingStateSourceRoot } : {}),
        ...(createStateSharingSessionImportRoots ? { createStateSharingSessionImportRoots } : {}),
        ...(resolveVendorResumeIdFromImportedFile ? { resolveVendorResumeIdFromImportedFile } : {}),
        readConnectedServiceId,
        createAuthMaterializationInput,
        materializeAuthEnvironment,
        ...(isMaterializedHomeStale
            ? {
                materializedHomeFreshness: {
                    isMaterializedHomeStale,
                },
            }
            : {}),
        ...(sanitizeRetainedMaterializedHome ? { sanitizeRetainedMaterializedHome } : {}),
        stateSharingDescriptor,
        ...(shouldRestartForServiceSwitch ? { shouldRestartForServiceSwitch } : {}),
        ...(unsupportedSwitchReason ? { unsupportedSwitchReason } : {}),
        ...(restartRematerializeRequiredReason ? { restartRematerializeRequiredReason } : {}),
        ...(connectedSwitchSharedStateRequiredReason ? { connectedSwitchSharedStateRequiredReason } : {}),
        ...(nativeSwitchSharedStateRequiredReason ? { nativeSwitchSharedStateRequiredReason } : {}),
        ...(value.sameAuthGroupRequiresResumeReachability === true ? { sameAuthGroupRequiresResumeReachability: true } : {}),
        ...(value.exactSameSelectionRequiresResumeReachability === false
            ? { exactSameSelectionRequiresResumeReachability: false }
            : {}),
        ...(verifyResumeReachable ? { verifyResumeReachable } : {}),
        ...(resolveCandidatePersistedSessionFile ? { resolveCandidatePersistedSessionFile } : {}),
        ...(resolveResumeReachabilityUnsupported ? { resolveResumeReachabilityUnsupported } : {}),
        ...(classifyUsageLimitError ? { classifyUsageLimitError } : {}),
        ...(runtimeAuthAdapter !== undefined ? { runtimeAuthAdapter } : {}),
        ...(daemonAuthBridgeRefresh && daemonAuthBridgeServiceIds.length > 0
            ? {
                daemonAuthBridge: {
                    serviceIds: daemonAuthBridgeServiceIds,
                    refresh: daemonAuthBridgeRefresh,
                },
            }
            : {}),
        ...(quotaFetcherDescriptor ? { quotaFetcherDescriptor } : {}),
        ...(usageLimitRecoveryOwnerId && fallbackBackoffEnvKey && maxAttemptsEnvKey && defaultFallbackBackoffMs && defaultMaxAttempts
            ? {
                usageLimitRecovery: {
                    agentId: usageLimitRecoveryOwnerId,
                    ...(issueProviderFilter ? { issueProviderFilter } : {}),
                    ...(defaultNativeServiceId ? { defaultNativeServiceId } : {}),
                    fallbackBackoffEnvKey,
                    maxAttemptsEnvKey,
                    defaultFallbackBackoffMs,
                    defaultMaxAttempts,
                },
            }
            : {}),
        ...(recoveryCapabilities ? { recoveryCapabilities } : {}),
        ...(resolveLegacyRuntimeAuthFailureSourceRevision
            ? { resolveLegacyRuntimeAuthFailureSourceRevision }
            : {}),
    };
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
}>): Pick<ResolvedCatalogEntry, 'getCliCommandHandler' | 'resolveSessionRuntimePreferences'> {
    const cliSessionCommand = resolveAgentCliSessionCommandDeclaration(
        params.cliSessionCommand,
        params.agentId,
    );
    return Object.freeze({
        getCliCommandHandler: createCliSessionCommandHandler(
            cliSessionCommand,
            {
                cliSubcommand: params.agentId,
                runtimeAuthorityAgentId: params.agentId,
            },
        ),
        ...(cliSessionCommand.buildSessionOptions
            ? {
                resolveSessionRuntimePreferences: (input) => normalizeAgentCliSessionCommandOptions(
                    cliSessionCommand.buildSessionOptions!(input),
                ),
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
) {
    return async () => {
        const runBackendSessionCliCommand = deps.runBackendSessionCliCommand
            ?? (await import('@/cli/runBackendSessionCliCommand')).runBackendSessionCliCommand;
        return async (context: Parameters<CatalogCliCommandHandler>[0]) => {
            if (cliSessionCommand.implicitResumeDelegation) {
                const resolveSessionCommandResumeDelegation = deps.resolveSessionCommandResumeDelegation
                    ?? (await import('@/cli/sessionCommandResumeDelegation')).resolveSessionCommandResumeDelegation;
                const decision = await resolveSessionCommandResumeDelegation({
                    args: context.args,
                    explicitProviderSubcommand:
                        context.args[0] === identity.cliSubcommand,
                    resumeFlags: cliSessionCommand.implicitResumeDelegation.resumeFlags,
                });
                if (decision.kind === 'delegate') {
                    const handleResumeCommand = deps.handleResumeCommand
                        ?? (await import('@/cli/commands/resume')).handleResumeCommand;
                    await handleResumeCommand([decision.sessionId], {
                        terminalRuntime: context.terminalRuntime,
                        rawArgv: context.rawArgv,
                    });
                    return;
                }
            }

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
        };
    };
}

function materializedRootDirForStableRoot(
    connectedServices: ConnectedServicesContribution,
    stableRootDir: string,
): string {
    return connectedServices.materializedRootSubdir
        ? join(stableRootDir, connectedServices.materializedRootSubdir)
        : stableRootDir;
}

function normalizeMaterializationDiagnostics(value: readonly unknown[] | undefined): readonly {
    code: string;
    providerId?: string;
    serviceId?: ConnectedServiceId;
    severity?: 'info' | 'warning' | 'blocking';
    requestedStateMode?: string;
    effectiveStateMode?: string;
    reason?: string;
    entryName?: string;
    credentialRefreshFailure?: ConnectedServicesMaterializationDiagnostic['credentialRefreshFailure'];
}[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const record = isRecord(entry) ? entry : null;
        const code = readString(record?.code);
        if (!record || !code) return [];
        const runtimeOwnerId = readString(record.agentId);
        const parsedServiceId = record.serviceId === undefined ? null : ConnectedServiceIdSchema.safeParse(record.serviceId);
        const severity = record.severity === 'info' || record.severity === 'warning' || record.severity === 'blocking'
            ? record.severity
            : undefined;
        const credentialRefreshFailure = normalizeMaterializationCredentialRefreshFailure(record.credentialRefreshFailure);
        return [{
            code,
            ...(runtimeOwnerId ? { providerId: runtimeOwnerId } : {}),
            ...(parsedServiceId?.success ? { serviceId: parsedServiceId.data } : {}),
            ...(severity ? { severity } : {}),
            ...(readString(record.requestedStateMode) ? { requestedStateMode: readString(record.requestedStateMode)! } : {}),
            ...(readString(record.effectiveStateMode) ? { effectiveStateMode: readString(record.effectiveStateMode)! } : {}),
            ...(readString(record.reason) ? { reason: readString(record.reason)! } : {}),
            ...(readString(record.entryName) ? { entryName: readString(record.entryName)! } : {}),
            ...(credentialRefreshFailure ? { credentialRefreshFailure } : {}),
        }];
    });
}

function normalizeStateSharingDiagnostics(
    diagnostics: Awaited<ReturnType<typeof applyConnectedServiceStateSharingDescriptor>>['diagnostics'],
): readonly ConnectedServicesMaterializationDiagnostic[] {
    return diagnostics.map((diagnostic) => {
        const runtimeOwnerId = diagnostic.providerId;
        const parsedServiceId = diagnostic.serviceId === undefined
            ? null
            : ConnectedServiceIdSchema.safeParse(diagnostic.serviceId);
        return {
            code: diagnostic.code,
            providerId: runtimeOwnerId,
            ...(parsedServiceId?.success ? { serviceId: parsedServiceId.data } : {}),
            ...(diagnostic.requestedStateMode ? { requestedStateMode: diagnostic.requestedStateMode } : {}),
            ...(diagnostic.effectiveStateMode ? { effectiveStateMode: diagnostic.effectiveStateMode } : {}),
            ...(diagnostic.entryName ? { entryName: diagnostic.entryName } : {}),
            ...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
        };
    });
}

async function removeMaterializedHomeCredentialEntries(
    targetDir: string,
    entries: readonly string[] | undefined,
): Promise<void> {
    for (const entry of entries ?? []) {
        await rm(join(targetDir, entry), { recursive: true, force: true });
    }
}

async function applyConnectedServiceStateSharingForContribution(params: Readonly<{
    agentId: CatalogAgentId;
    connectedServices: ConnectedServicesContribution;
    serviceId: ConnectedServiceId;
    materializedRootDir: string;
    env: NodeJS.ProcessEnv;
    stateSourceRoot?: string | null;
    stateSharingPolicy: ReturnType<typeof resolveConnectedServicesProviderStateSharingPolicyV1>;
    sessionDirectory?: string | null;
}>): Promise<Readonly<{
    diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
    effectiveStateMode: 'isolated' | 'shared';
}>> {
    const resolveStateSharingSourceRoot = params.connectedServices.resolveStateSharingSourceRoot;
    const providerLabel = String(params.agentId);
    if (!resolveStateSharingSourceRoot) {
        return { diagnostics: [], effectiveStateMode: params.stateSharingPolicy.stateMode };
    }
    if (
        params.connectedServices.stateSharingServiceIds
        && !params.connectedServices.stateSharingServiceIds.includes(params.serviceId)
    ) {
        return { diagnostics: [], effectiveStateMode: params.stateSharingPolicy.stateMode };
    }
    const settings = params.stateSharingPolicy;
    const sourceRoot = resolveStateSharingSourceRoot({ env: params.env });
    const stateSourceRoot = readString(params.stateSourceRoot) ?? sourceRoot;
    const lockRoots = settings.stateMode === 'shared'
        ? [params.materializedRootDir, sourceRoot, stateSourceRoot]
        : [params.materializedRootDir];
    return await withConnectedServiceStateSharingLocks(lockRoots, async () => {
        const stateEntryNames = await params.connectedServices.resolveStateSharingStateEntryNames?.({
            sourceRoot: stateSourceRoot,
            materializedRootDir: params.materializedRootDir,
            env: params.env,
            requestedStateMode: settings.stateMode,
            effectiveStateMode: settings.stateMode,
        });
        const sessionImportRoots = settings.stateMode === 'shared'
            ? params.connectedServices.createStateSharingSessionImportRoots?.({
                sourceRoot: stateSourceRoot,
                materializedRootDir: params.materializedRootDir,
            }) ?? [{
                sourceRoot: join(params.materializedRootDir, 'projects'),
                destinationRoot: join(stateSourceRoot, 'projects'),
                includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
            }]
            : [];
        await removeMaterializedHomeCredentialEntries(
            params.materializedRootDir,
            params.connectedServices.materializedHomeCredentialEntries,
        );
        const existingManifest = await readConnectedServiceStateSharingManifest(params.materializedRootDir);
        if (settings.stateMode === 'shared') {
            await params.connectedServices.reconcileStateSharingSource?.({
                sourceRoot: stateSourceRoot,
                materializedRootDir: params.materializedRootDir,
            });
        }
        const applyResult = await applyConnectedServiceStateSharingDescriptor({
            descriptor: params.connectedServices.stateSharingDescriptor,
            nativeSourceContext: {
                sourceRoot,
                sourceEnv: params.env as Record<string, string>,
            },
            target: {
                targetMaterializedRoot: params.materializedRootDir,
                targetMaterializedEnv: {},
            },
            configMode: settings.configMode,
            requestedStateMode: settings.stateMode,
            effectiveStateMode: settings.stateMode,
            cwd: params.sessionDirectory ?? process.cwd(),
            existingManifest,
            ...(stateEntryNames ? { stateEntryNames } : {}),
            resolveStateSourceRoot: (entryName) =>
                params.connectedServices.resolveStateSharingStateSourceRoot?.({
                    entryName,
                    sourceRoot: stateSourceRoot,
                    materializedRootDir: params.materializedRootDir,
                    env: params.env,
                }) ?? stateSourceRoot,
            sessionImportRoots,
            ...(params.connectedServices.resolveVendorResumeIdFromImportedFile
                ? { resolveVendorResumeIdFromImportedFile: params.connectedServices.resolveVendorResumeIdFromImportedFile }
                : {}),
            providerLabel,
        });
        await removeMaterializedHomeCredentialEntries(
            params.materializedRootDir,
            params.connectedServices.materializedHomeCredentialEntries,
        );
        await writeConnectedServiceStateSharingManifest(params.materializedRootDir, applyResult.manifest);
        return {
            diagnostics: normalizeStateSharingDiagnostics(applyResult.diagnostics),
            effectiveStateMode: applyResult.manifest.effectiveStateMode,
        };
    }, { providerId: providerLabel });
}

function createConnectedServicesMaterializer(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    exec: ExecService,
): ConnectedServicesMaterializer {
    const mergeAuthMaterializationInput = (
        target: Record<string, unknown>,
        input: Readonly<Record<string, unknown>>,
    ): void => {
        for (const [key, value] of Object.entries(input)) {
            if (value === null || value === undefined) continue;
            target[key] = value;
        }
    };

    return async ({
        materializationKey,
        activeServerDir,
        rootDir,
        recordsByServiceId,
        selectionsByServiceId,
        connectedAccountMaterializationAuthority,
        accountSettings,
        processEnv,
        sessionDirectory,
    }) => {
        const materializationInput: Record<string, unknown> = {};
        const requestAuthPurposeBindings = connectedAccountMaterializationAuthority.kind === 'qualified'
            ? connectedAccountMaterializationAuthority.requestAuthPurposeBindings
            : [];
        let primaryRecord: CredentialRecord | null = null;
        let primaryServiceId: ConnectedServiceId | null = null;

        for (const serviceId of connectedServices.serviceIds) {
            const record = selectionsByServiceId?.get(serviceId)?.record ?? recordsByServiceId.get(serviceId) ?? null;
            if (!record) continue;
            if (connectedAccountMaterializationAuthority.kind === 'legacy_unfenced_one_shot') {
                mergeAuthMaterializationInput(
                    materializationInput,
                    connectedServices.createAuthMaterializationInput(serviceId, record),
                );
            }
            primaryRecord ??= record;
            primaryServiceId ??= serviceId;
        }

        if (!primaryRecord || !primaryServiceId) return null;
        const stateSharingPolicy = resolveConnectedServicesProviderStateSharingPolicyV1(
            accountSettings?.connectedServicesProviderStateSharingSettingsV1,
            agentId,
        );
        const primarySelection = selectionsByServiceId?.get(primaryServiceId);
        const stableRootDir = primarySelection?.kind === 'group'
            ? resolveConnectedServiceGroupHomeDir({
                activeServerDir,
                serviceId: primarySelection.serviceId,
                groupId: primarySelection.groupId,
                agentId,
            })
            : resolveConnectedServiceHomeDir({
                activeServerDir,
                serviceId: primaryServiceId,
                profileId: primarySelection?.kind === 'profile' ? primarySelection.profileId : primaryRecord.profileId,
                agentId,
            });
        const materializedRootDir = materializedRootDirForStableRoot(connectedServices, stableRootDir);
        await ensurePrivateConnectedServiceMaterializedRoot(materializedRootDir);

        const env = processEnv ?? process.env;
        // Thread group-bound selections' groupIds to the plugin materializer so runtime-auth
        // selection identities can be pool-scoped (without generation) at the single owner.
        const connectedServiceGroupIdsByServiceId = Object.fromEntries(
            [...(selectionsByServiceId?.entries() ?? [])]
                .flatMap(([serviceId, selection]) => selection.kind === 'group' ? [[serviceId, selection.groupId] as const] : []),
        );
        const materializationContext = {
            ...materializationInput,
            connectedAccountMaterializationAuthority:
                connectedAccountMaterializationAuthority.kind,
            ...(Object.keys(connectedServiceGroupIdsByServiceId).length > 0
                ? { connectedServiceGroupIdsByServiceId }
                : {}),
            rootDir: materializedRootDir,
            processEnv: env,
            connectedServicesSessionStateSharingRequested: stateSharingPolicy.stateMode === 'shared',
            sessionDirectory: sessionDirectory ?? null,
            exec,
            ...(requestAuthPurposeBindings.length
                ? {
                    requestAuth: Object.freeze({
                        purposeBindings: requestAuthPurposeBindings,
                        capabilityPath:
                            resolveConnectedAccountRequestAuthCapabilityPath(
                                rootDir,
                            ),
                    }),
                }
                : {}),
        };
        const stateSharing = await applyConnectedServiceStateSharingForContribution({
            agentId,
            connectedServices,
            serviceId: primaryServiceId,
            materializedRootDir,
            env,
            stateSharingPolicy,
            sessionDirectory: sessionDirectory ?? null,
        });
        const materialized = await connectedServices.materializeAuthEnvironment({
            ...materializationContext,
            connectedServicesSessionStateSharingEffectiveMode: stateSharing.effectiveStateMode,
            materializationId: materializationKey,
        });

        return {
            ...createRetainedConnectedServicesMaterialization({
                rootDir: materializedRootDir,
                env: materialized.env,
            }),
            ...(requestAuthPurposeBindings.length
                ? { requestAuthMaterializedRoot: rootDir }
                : {}),
            diagnostics: [
                ...stateSharing.diagnostics,
                ...normalizeMaterializationDiagnostics(materialized.diagnostics),
            ],
        };
    };
}

function createRuntimeAuthAdapter(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
): ConnectedServiceProviderRuntimeAuthAdapter | null {
    if (connectedServices.runtimeAuthAdapter === false) return null;
    if (connectedServices.runtimeAuthAdapter) return connectedServices.runtimeAuthAdapter;
    if (!connectedServices.classifyUsageLimitError) return null;
    const restartResume = createRestartResumeConnectedServiceRuntimeAuthAdapter(agentId);
    return {
        ...restartResume,
        classifyRuntimeAuthFailure(input) {
            const selection = isRecord(input.selection) ? input.selection : null;
            const error = isRecord(input.error) ? input.error : null;
            const classified = connectedServices.classifyUsageLimitError?.({
                providerErrorPath: true,
                error: input.error,
                parseResetAt: parseProviderResetAt,
            });
            if (!isRecord(classified)) return restartResume.classifyRuntimeAuthFailure(input);
            const serviceId = readString(selection?.serviceId) ?? readString(error?.serviceId);
            if (!serviceId) return null;
            const classification: ConnectedServiceRuntimeFailureClassification = {
                kind: readString(classified.kind) === 'rate_limit' ? 'rate_limit' : 'usage_limit',
                serviceId,
                profileId: readString(selection?.activeProfileId ?? selection?.profileId),
                groupId: readString(selection?.groupId),
                resetsAtMs: typeof classified.resetAtMs === 'number' ? classified.resetAtMs : null,
                retryAfterMs: typeof classified.retryAfterMs === 'number' ? classified.retryAfterMs : null,
                planType: null,
                rateLimits: classified,
                source: 'structured_provider_error',
            };
            return {
                ...classification,
                limitCategory: readConnectedServiceLimitCategoryV1(classified.limitCategory) ?? 'usage_limit',
                providerLimitId: readString(classified.providerLimitId),
                quotaScope: readString(classified.quotaScope) ?? 'unknown',
                action: isRecord(classified.action) ? classified.action : null,
            } as ConnectedServiceRuntimeFailureClassification;
        },
    };
}

function createConnectedServiceMaterializedHomeRootResolver(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
): NonNullable<ResolvedCatalogEntry['resolveConnectedServiceMaterializedHomeRoot']> {
    return (params) => {
        const serviceId = connectedServices.readConnectedServiceId(params.serviceId);
        if (!serviceId) return null;
        const selection = params.selection;
        const stableRootDir = selection?.kind === 'group'
            ? resolveConnectedServiceGroupHomeDir({
                activeServerDir: params.activeServerDir,
                serviceId,
                groupId: selection.groupId,
                agentId,
            })
            : resolveConnectedServiceHomeDir({
                activeServerDir: params.activeServerDir,
                serviceId,
                profileId: selection?.kind === 'profile' ? selection.profileId : params.profileId,
                agentId,
            });
        return materializedRootDirForStableRoot(connectedServices, stableRootDir);
    };
}

function createSwitchContinuityResolver(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    runtimeAuthAdapter: ConnectedServiceProviderRuntimeAuthAdapter | null,
    verifyResumeReachable: VerifyResumeReachable,
) {
    return async (params: ConnectedServiceSwitchContinuityParams): Promise<ConnectedServiceSwitchContinuityResult> => {
        if (!connectedServices.shouldRestartForServiceSwitch?.(params.serviceId)) {
            return {
                mode: 'unsupported',
                reason: connectedServices.unsupportedSwitchReason?.(params.serviceId)
                    ?? 'unsupported_service',
            };
        }
        if (
            runtimeAuthAdapter
            && isConnectedToConnectedServiceSwitch(params)
            && params.runtimeAuthSelection !== null
            && params.runtimeAuthSelection !== undefined
        ) {
            const hotApply = runtimeAuthAdapter.canHotApply({
                target: { agentId },
                selection: params.runtimeAuthSelection,
                targetMaterializedEnv: params.targetMaterializedEnv ?? null,
                materializedEnv: params.targetMaterializedEnv ?? null,
            });
            if (isRecord(hotApply) && hotApply.supported === true) {
                return { mode: 'hot_apply' };
            }
        }
        if (isConnectedToConnectedServiceSwitch(params)) {
            const restartContinuityCanBeProven = (
                connectedServices.exactSameSelectionRequiresResumeReachability !== false
                && isExactSameConnectedServiceSelection(params)
            )
                || (
                    connectedServices.sameAuthGroupRequiresResumeReachability === true
                    && isSameConnectedServiceAuthGroup(params)
                );
            if (!restartContinuityCanBeProven) {
                if (connectedServices.connectedSwitchSharedStateRequiredReason) {
                    return {
                        mode: 'restart_shared_state_required',
                        reason: connectedServices.connectedSwitchSharedStateRequiredReason,
                    };
                }
                return {
                    mode: 'restart_same_home',
                    reason: connectedServices.restartRematerializeRequiredReason ?? 'provider_rematerialization_required',
                };
            }
            if (!hasExactConnectedServiceRestartContinuityContext(params)) {
                return providerSessionStateUnavailableForResume();
            }

            const targetMaterializedRoot = readString(params.targetMaterializedRoot);
            const providerSessionId = readString(params.vendorResumeId);
            const cwd = readString(params.cwd);
            const materializationIdentity = params.connectedServiceMaterializationIdentityV1 ?? null;
            const targetMaterializedEnv = params.targetMaterializedEnv ?? null;
            if (!targetMaterializedRoot || !providerSessionId || !cwd || !materializationIdentity || !targetMaterializedEnv) {
                return providerSessionStateUnavailableForResume();
            }

            const reachability = await canResumeFromMaterializedStateCore({
                targetMaterializedRoot,
                targetMaterializedEnv,
                requestedStateMode: 'isolated',
                effectiveStateMode: 'isolated',
                materializationIdentity,
                vendorResumeId: providerSessionId,
                cwd,
                candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
                verifyResumeReachable,
            });
            return reachability.ok
                ? { mode: 'restart_same_home' }
                : providerSessionStateUnavailableForResume({
                    diagnostics: reachability.continuityDiagnostics,
                });
        }
        return connectedServices.nativeSwitchSharedStateRequiredReason
            ? {
                mode: 'restart_shared_state_required',
                reason: connectedServices.nativeSwitchSharedStateRequiredReason,
            }
            : {
            mode: 'restart_same_home',
            reason: connectedServices.restartRematerializeRequiredReason ?? 'provider_rematerialization_required',
        };
    };
}

function createProviderScopedStableExecService(params: Readonly<{
    cwd: string;
    environment: Readonly<Record<string, string>>;
    systemTools: readonly PluginSystemToolContributionV1[];
    agentId?: CatalogAgentId;
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
        && isBundledAgentId(params.agentId)
        && params.agentCliSystemTool
        && boundDefinition
        ? createAgentCliSystemToolService({
            agentId: params.agentId,
            runtimeSpec: getAgentCliRuntimeSpec(params.agentId),
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

function createProviderScopedExecService(
    systemTools?: readonly PluginSystemToolContributionV1[],
    agentId?: CatalogAgentId,
    agentCliSystemTool?: AgentCliSystemToolBinding | null,
): ExecService {
    const environment = Object.freeze(Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
    ));
    return createProviderScopedStableExecService({
        cwd: process.cwd(),
        environment,
        systemTools: systemTools ?? [],
        agentId,
        agentCliSystemTool,
    });
}

export function createAgentRuntimeCatalogEntryHooks(params: Readonly<{
    agentId: CatalogAgentId;
    packageName: string;
    contribution: AgentRuntimeContribution;
    /** Static manifest catalog fact; it is never sourced from the runtime aggregate. */
    agentCliSystemTool?: AgentCliSystemToolBinding;
    systemTools?: readonly PluginSystemToolContributionV1[];
}>): AgentCatalogHookFactory {
    const systemTools = params.systemTools ?? Object.freeze([]);
    const agentCliSystemTool = readAgentCliSystemToolBinding(
        params.agentCliSystemTool,
        systemTools,
    );
    const connectedServices = readConnectedServicesContribution(params.contribution.connectedServices);
    const sessionHandoff = readSessionHandoffContribution(params.contribution.sessionHandoff);
    const rawRuntimeAuthAdapter = connectedServices
        ? createRuntimeAuthAdapter(params.agentId, connectedServices)
        : null;
    const runtimeAuthAdapter = rawRuntimeAuthAdapter
        ? serializeRuntimeAuthDestinationTransitions(params.agentId, rawRuntimeAuthAdapter)
        : null;
    const projectedResumeReachability = resolveProjectedResumeReachability(connectedServices);
    const connectedServiceSwitchContinuityResolver = connectedServices?.shouldRestartForServiceSwitch
        ? createSwitchContinuityResolver(
            params.agentId,
            connectedServices,
            runtimeAuthAdapter,
            projectedResumeReachability,
        )
        : null;
    const switchContinuityResolver = connectedServiceSwitchContinuityResolver;

    return () => {
        const exec = createProviderScopedExecService(
            systemTools,
            params.agentId,
            agentCliSystemTool,
        );
        return ({
        ...(connectedServices
            ? {
                getConnectedServicesMaterializer: async () =>
                    createConnectedServicesMaterializer(params.agentId, connectedServices, exec),
                ...(connectedServices.noRestartRequiredServiceIds
                    ? { connectedServiceNoRestartRequiredServiceIds: connectedServices.noRestartRequiredServiceIds }
                    : {}),
                ...(connectedServices.shouldRestartForServiceSwitch
                    ? {
                        shouldRestartConnectedServiceOnCredentialUpdate: (serviceId: ConnectedServiceId) =>
                            connectedServices.shouldRestartForServiceSwitch?.(serviceId) === true,
                    }
                    : {}),
                connectedServiceIds: connectedServices.serviceIds,
                ...(connectedServices.requestAuthUses
                    ? { connectedAccountRequestAuthUses: connectedServices.requestAuthUses }
                    : {}),
                resolveConnectedServiceMaterializedHomeRoot:
                    createConnectedServiceMaterializedHomeRootResolver(params.agentId, connectedServices),
                ...(connectedServices.materializedHomeFreshness
                    ? {
                        getConnectedServiceMaterializedHomeFreshness: async () =>
                            connectedServices.materializedHomeFreshness ?? null,
                    }
                    : {}),
                ...(connectedServices.sanitizeRetainedMaterializedHome
                    ? { sanitizeRetainedConnectedServiceMaterializedHome: connectedServices.sanitizeRetainedMaterializedHome }
                    : {}),
                getConnectedServiceStateSharingDescriptor: async () =>
                    connectedServices.stateSharingDescriptor,
                ...(connectedServices.recoveryCapabilities
                    ? {
                        getConnectedServiceRecoveryCapabilities: async () =>
                            connectedServices.recoveryCapabilities ?? null,
                    }
                    : {}),
                ...(connectedServices.resolveLegacyRuntimeAuthFailureSourceRevision
                    ? {
                        resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevision:
                            connectedServices.resolveLegacyRuntimeAuthFailureSourceRevision,
                    }
                    : {}),
                ...(runtimeAuthAdapter
                    ? {
                        getConnectedServiceRuntimeAuthAdapter: async () => runtimeAuthAdapter,
                    }
                    : {}),
                ...(connectedServices.daemonAuthBridge
                    ? {
                        getConnectedServiceDaemonAuthBridgeRefresh: async (serviceId: ConnectedServiceId) =>
                            connectedServices.daemonAuthBridge?.serviceIds.includes(serviceId) === true
                                ? connectedServices.daemonAuthBridge.refresh
                                : null,
                    }
                    : {}),
                ...(connectedServices.quotaFetcherDescriptor
                    ? {
                        getConnectedServiceQuotaFetcherDescriptor: async () =>
                            connectedServices.quotaFetcherDescriptor ?? null,
                    }
                    : {}),
                ...(switchContinuityResolver
                    ? { resolveConnectedServiceSwitchContinuity: switchContinuityResolver }
                    : {}),
                ...(connectedServices.verifyResumeReachable || connectedServices.resolveResumeReachabilityUnsupported
                    ? { verifyResumeReachable: projectedResumeReachability }
                    : {}),
                ...(connectedServices.usageLimitRecovery
                    ? {
                        sessionUsageLimitRecoveryBackoffPolicy: {
                            providerId: connectedServices.usageLimitRecovery.agentId,
                            issueProviderFilter:
                                connectedServices.usageLimitRecovery.issueProviderFilter ?? null,
                            defaultNativeServiceId:
                                connectedServices.usageLimitRecovery.defaultNativeServiceId ?? null,
                            fallbackBackoffEnvKey:
                                connectedServices.usageLimitRecovery.fallbackBackoffEnvKey,
                            maxAttemptsEnvKey:
                                connectedServices.usageLimitRecovery.maxAttemptsEnvKey,
                            defaultFallbackBackoffMs:
                                connectedServices.usageLimitRecovery.defaultFallbackBackoffMs,
                            defaultMaxAttempts:
                                connectedServices.usageLimitRecovery.defaultMaxAttempts,
                        },
                    }
                    : {}),
            }
            : {}),
        ...(connectedServices?.resolveCandidatePersistedSessionFile
            ? {
                resolveConnectedServiceCandidatePersistedSessionFile:
                    connectedServices.resolveCandidatePersistedSessionFile,
            }
            : {}),
        ...(sessionHandoff?.agentBundleRecords
            ? {
                getSessionHandoffAgentBundleRecordExtractor: async () =>
                    sessionHandoff.agentBundleRecords?.extract ?? null,
            }
            : {}),
        ...(sessionHandoff?.runtimeLocalMetadata
            ? { buildRuntimeLocalHandoffMetadata: sessionHandoff.runtimeLocalMetadata.build }
            : {}),
        ...(sessionHandoff?.nativeSessionLog
            ? { resolveAgentNativeSessionLogPath: sessionHandoff.nativeSessionLog.resolvePath }
            : {}),
        });
    };
}

export function applyAgentCatalogEntryHooks(
    contribution: ResolvedAgentContribution,
    hooksByAgentId: Readonly<Record<string, AgentCatalogHookFactory>>,
): ResolvedAgentContribution {
    const createHooks = hooksByAgentId[contribution.id];
    if (!createHooks || !contribution.catalogEntry) return contribution;
    return Object.freeze({
        ...contribution,
        catalogEntry: Object.freeze({
            ...contribution.catalogEntry,
            ...createHooks(),
        }),
    });
}
