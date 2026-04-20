import type { AgentId } from '@happier-dev/agents';
import {
    listNativeReviewEngines,
    convertBackendTargetRefV2ToV1,
    readBackendTargetRefV2,
    type BackendTargetRefV1,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { resolveConfiguredAcpRuntimeOwner } from '@/agent/acp/catalog/configured/configuredAcpRuntimeOwner';
import type {
    ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
    buildExecutionRunRuntimeIdentityPublication,
    withExecutionRunRuntimeIdentityPublication,
} from '@/agent/runtime/identity/executionRunRuntimeIdentityPublication';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import {
    createDescriptorBackendFromRegistry,
    isMissingBoundCliBindingsError,
} from '@/agent/runtime/registry/createCliBindings';
import { throwIfPluginRuntimeStartBlocked } from '@/agent/runtime/registry/throwIfPluginRuntimeStartBlocked';
import { resolveCustomHappierToolsContext } from '@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext';
import { configuration } from '@/configuration';
import { readCredentials, readSettings } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { assertBackendEnabledByAccountSettings } from '@/settings/backendEnabled';

import { createLazyExecutionRunHostRuntime } from './hostRuntime/lazy';

const REVIEW_ENGINE_DESCRIPTOR_FALLBACK_IDS = new Set<string>(listNativeReviewEngines().map((engine) => engine.id));

function normalizeNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAccountSettings(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Readonly<Record<string, unknown>>;
}

function resolveExecutionRunAccountSettings(params: Readonly<{
    backendTarget?: BackendTargetRefV2 | null;
    accountSettings?: unknown;
}>): Readonly<Record<string, unknown>> | null {
    const explicitSettings = normalizeAccountSettings(params.accountSettings);
    if (explicitSettings) return explicitSettings;
    if (params.backendTarget?.sourceKind === 'configured') {
        return null;
    }
    return normalizeAccountSettings(getActiveAccountSettingsSnapshot()?.settings ?? null);
}

function resolveExecutionRunCompatBackendTarget(
    backendTarget: BackendTargetRefV2Input | null | undefined,
): Readonly<{
    canonical: BackendTargetRefV2;
    compat: BackendTargetRefV1;
}> | null {
    if (!backendTarget) {
        return null;
    }

    const canonical = readBackendTargetRefV2(backendTarget);
    return {
        canonical,
        compat: convertBackendTargetRefV2ToV1(canonical),
    };
}

function createReviewEngineDescriptorExecutionRunBackendFallback(
    opts: Readonly<{
        cwd: string;
        runId?: string;
        backendId: string;
        backendTarget?: BackendTargetRefV2Input;
        modelId?: string;
        permissionMode: string;
        accountSettings?: Readonly<Record<string, unknown>> | null;
        start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
    }>,
): ExecutionRunHostRuntime | null {
    // Native review engines still keep a bounded descriptor-backed execution-run compatibility seam
    // until they publish first-class bindings execution-run bindings through the engine registry.
    if (!REVIEW_ENGINE_DESCRIPTOR_FALLBACK_IDS.has(String(opts.backendId ?? '').trim())) {
        return null;
    }
    return createDescriptorBackendFromRegistry(opts);
}

type LazyExecutionRunRuntimeShellConfig = Parameters<typeof createLazyExecutionRunHostRuntime>[0];

function createConfiguredAcpExecutionRunRuntimeShellConfig(opts: Readonly<{
    cwd: string;
    runId?: string;
    backendTarget: BackendTargetRefV2 & Readonly<{
        sourceKind: 'configured';
        configuredBackendId: string;
    }>;
    modelId?: string;
    permissionMode: string;
    credentials?: Awaited<ReturnType<typeof readCredentials>> | null;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
}>): LazyExecutionRunRuntimeShellConfig {
    let resolvedRuntimePromise: Promise<ExecutionRunHostRuntime> | null = null;

    const resolveRuntime = async (): Promise<ExecutionRunHostRuntime> => {
        if (resolvedRuntimePromise) return await resolvedRuntimePromise;
        resolvedRuntimePromise = (async () => {
            const credentials = opts.credentials ?? await readCredentials();
            if (!credentials) {
                throw new Error('Missing credentials for configured ACP execution run');
            }
            const settings = opts.accountSettings ?? (await bootstrapAccountSettingsContext({
                credentials,
                backendTarget: convertBackendTargetRefV2ToV1(opts.backendTarget),
            })).settings;
            const runtimeOwner = await resolveConfiguredAcpRuntimeOwner({
                credentials,
                accountSettings: settings,
                backendId: opts.backendTarget.configuredBackendId,
                happyHomeDir: configuration.happyHomeDir,
            });
            const machineId = normalizeNonEmptyString((await readSettings()).machineId);
            const resolvedMcpServers = machineId
                ? (await resolveCustomHappierToolsContext({
                    credentials,
                    accountSettings: settings,
                    machineId,
                    directory: opts.cwd,
                })).mcpServers
                : {};
            return runtimeOwner.createExecutionRunBackend({
                cwd: opts.cwd,
                runId: opts.runId,
                backendId: runtimeOwner.backend.backendId,
                backendTarget: opts.backendTarget,
                modelId: opts.modelId,
                permissionMode: opts.permissionMode,
                accountSettings: settings,
                start: opts.start ?? null,
                mcpServers: resolvedMcpServers,
            });
        })();
        return await resolvedRuntimePromise;
    };

    // Configured ACP still keeps a dedicated discovery branch because the leaf comes from account settings /
    // plugin-contributed ACP definitions instead of the static engine registry. After discovery,
    // execution-run creation now flows through the same configured ACP runtime owner without a
    // second post-provision model shim in this shared shell.
    return {
        resolveRuntime,
        runtimeDescriptor: {
            backendId: opts.backendTarget.configuredBackendId,
            runtimeKind: 'acp',
        },
        runtimeCapabilities: {
            executionRun: { supported: true },
        },
    };
}

function createEngineExecutionRunRuntimeShellConfig(opts: Readonly<{
    cwd: string;
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    modelId?: string;
    permissionMode: string;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
}>): LazyExecutionRunRuntimeShellConfig {
    let resolvedBackendPromise: Promise<ExecutionRunHostRuntime> | null = null;

    const resolveBackend = async (): Promise<ExecutionRunHostRuntime> => {
        if (resolvedBackendPromise) return await resolvedBackendPromise;
        resolvedBackendPromise = (async () => {
            const engineResolution = await resolveBackendEngineAdapterResolution(opts.backendId, {
                happyHomeDir: configuration.happyHomeDir,
            });
            if (engineResolution) {
                throwIfPluginRuntimeStartBlocked(engineResolution);
            }
            let runtime: ExecutionRunHostRuntime | null = null;
            if (engineResolution) {
                try {
                    runtime = engineResolution.engineAdapter.bindings.createExecutionRunBackend({
                        cwd: opts.cwd,
                        runId: opts.runId,
                        backendId: opts.backendId,
                        backendTarget: opts.backendTarget,
                        modelId: opts.modelId,
                        permissionMode: opts.permissionMode,
                        accountSettings: opts.accountSettings ?? null,
                        start: opts.start ?? null,
                    });
                } catch (error) {
                    if (!isMissingBoundCliBindingsError(error)) {
                        throw error;
                    }
                    runtime = createReviewEngineDescriptorExecutionRunBackendFallback({
                        cwd: opts.cwd,
                        runId: opts.runId,
                        backendId: opts.backendId,
                        backendTarget: opts.backendTarget,
                        modelId: opts.modelId,
                        permissionMode: opts.permissionMode,
                        accountSettings: opts.accountSettings ?? null,
                        start: opts.start ?? null,
                    });
                }
            } else {
                runtime = createReviewEngineDescriptorExecutionRunBackendFallback({
                    cwd: opts.cwd,
                    runId: opts.runId,
                    backendId: opts.backendId,
                    backendTarget: opts.backendTarget,
                    modelId: opts.modelId,
                    permissionMode: opts.permissionMode,
                    accountSettings: opts.accountSettings ?? null,
                    start: opts.start ?? null,
                });
            }
            if (!runtime) {
                throw new Error(`Unsupported execution-run backend: ${opts.backendId}`);
            }

            return engineResolution
                ? withExecutionRunRuntimeIdentityPublication({
                    runtime,
                    identity: buildExecutionRunRuntimeIdentityPublication(engineResolution),
                })
                : runtime;
        })();
        return await resolvedBackendPromise;
    };

    return {
        resolveRuntime: resolveBackend,
    };
}

export function createExecutionRunRuntime(opts: Readonly<{
    cwd: string;
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    modelId?: string;
    permissionMode: string;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
}>): ExecutionRunHostRuntime {
    const resolvedBackendTarget = resolveExecutionRunCompatBackendTarget(opts.backendTarget);
    const backendId = String(opts.backendId ?? '').trim();
    const accountSettings = resolveExecutionRunAccountSettings({
        backendTarget: resolvedBackendTarget?.canonical,
        accountSettings: opts.accountSettings,
    });
    if (accountSettings && resolvedBackendTarget?.canonical.sourceKind === 'built_in') {
        assertBackendEnabledByAccountSettings({
            agentId: resolvedBackendTarget.compat.kind === 'builtInAgent' ? resolvedBackendTarget.compat.agentId as AgentId : undefined,
            backendTarget: resolvedBackendTarget.compat,
            settings: accountSettings,
        });
    }
    if (accountSettings && resolvedBackendTarget?.canonical.sourceKind === 'configured') {
        assertBackendEnabledByAccountSettings({
            backendTarget: resolvedBackendTarget.compat,
            settings: accountSettings,
        });
    }
    const runtimeShellConfig = resolvedBackendTarget?.canonical.sourceKind === 'configured'
        ? createConfiguredAcpExecutionRunRuntimeShellConfig({
            cwd: opts.cwd,
            runId: opts.runId,
            backendTarget: {
                ...resolvedBackendTarget.canonical,
                configuredBackendId: resolvedBackendTarget.canonical.configuredBackendId ?? resolvedBackendTarget.canonical.backendId,
                sourceKind: 'configured',
            },
            modelId: opts.modelId,
            permissionMode: opts.permissionMode,
            credentials: null,
            accountSettings,
            start: opts.start ?? null,
        })
        : createEngineExecutionRunRuntimeShellConfig({
            cwd: opts.cwd,
            runId: opts.runId,
            backendId,
            ...(resolvedBackendTarget ? { backendTarget: resolvedBackendTarget.canonical } : {}),
            modelId: opts.modelId,
            permissionMode: opts.permissionMode,
            accountSettings,
            start: opts.start ?? null,
        });
    return createLazyExecutionRunHostRuntime(runtimeShellConfig);
}
