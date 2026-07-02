import type { AgentId } from '@happier-dev/agents';
import {
    convertBackendTargetRefV2ToV1,
    readBackendTargetRefV2,
    type BackendTargetRefV1,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import type {
    ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
    buildExecutionRunRuntimeIdentityPublication,
    withExecutionRunRuntimeIdentityPublication,
} from '@/agent/runtime/identity/executionRunRuntimeIdentityPublication';
import type { ExecutionRunSessionStateTarget } from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { throwIfPluginRuntimeStartBlocked } from '@/agent/runtime/registry/throwIfPluginRuntimeStartBlocked';
import { configuration } from '@/configuration';
import { resolveBackendIsolationBundle } from '@/packagedRuntime/isolation/resolveBackendIsolationBundle';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { assertBackendEnabledByAccountSettings } from '@/settings/backendEnabled';

import { withExecutionRunHostRuntimeCleanup } from '../hostRuntime/cleanup';
import { createLazyExecutionRunHostRuntime } from '../hostRuntime/lazy';
import { cleanupExecutionRunIsolationBundle } from './isolation';

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

function resolveExecutionRunPluginIsolationBundle(opts: Readonly<{
    cwd: string;
    runId?: string;
    backendId: string;
    start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
}>): Readonly<{
    env: Readonly<Record<string, string>>;
    cleanup?: (() => Promise<void>) | undefined;
    shouldCleanupIsolation: boolean;
}> | null {
    const retentionPolicy = String(opts.start?.retentionPolicy ?? '').trim();
    const shouldCleanupIsolation = retentionPolicy === 'ephemeral';
    const shouldIsolate = shouldCleanupIsolation || String(opts.runId ?? '').trim().length > 0;
    if (!shouldIsolate) {
        return null;
    }

    const intent = String(opts.start?.intent ?? '').trim();
    const isolationId = String(opts.runId ?? '').trim() || `run_${opts.backendId}_${Date.now()}`;
    const bundle = resolveBackendIsolationBundle({
        backendId: opts.backendId,
        isolationId,
        scope: 'execution_run',
        ...(intent.length > 0 ? { intent } : {}),
        cwd: opts.cwd,
    });
    const cleanup = bundle.cleanup
        ? async () => {
            await Promise.resolve(bundle.cleanup?.());
        }
        : undefined;

    return {
        env: bundle.env,
        cleanup,
        shouldCleanupIsolation,
    };
}

type LazyExecutionRunRuntimeShellConfig = Parameters<typeof createLazyExecutionRunHostRuntime>[0];

function createEngineExecutionRunRuntimeShellConfig(opts: Readonly<{
    cwd: string;
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    modelId?: string;
    permissionMode: string;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
    happyHomeDir?: string | null;
    parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
}>): LazyExecutionRunRuntimeShellConfig {
    let resolvedBackendPromise: Promise<ExecutionRunHostRuntime> | null = null;

    const resolveBackend = async (): Promise<ExecutionRunHostRuntime> => {
        if (resolvedBackendPromise) return await resolvedBackendPromise;
        resolvedBackendPromise = (async () => {
            const engineResolution = await resolveBackendEngineAdapterResolution(opts.backendId, {
                happyHomeDir: opts.happyHomeDir ?? configuration.happyHomeDir,
            });
            if (engineResolution) {
                throwIfPluginRuntimeStartBlocked(engineResolution);
            }
            if (!engineResolution) {
                throw new Error(`Unsupported execution-run backend: ${opts.backendId}`);
            }
            const runtimeCore = engineResolution.engineAdapter.runtimeCore;
            if (typeof runtimeCore?.createExecutionRunBackend !== 'function') {
                throw new Error(`Engine adapter for ${opts.backendId} does not expose runtimeCore.createExecutionRunBackend`);
            }
            const pluginIsolationBundle = engineResolution.runtimeOwner?.selected?.kind === 'plugin_engine'
                ? resolveExecutionRunPluginIsolationBundle(opts)
                : null;
            const runtimeOpts = {
                cwd: opts.cwd,
                runId: opts.runId,
                backendId: opts.backendId,
                backendTarget: opts.backendTarget,
                modelId: opts.modelId,
                permissionMode: opts.permissionMode,
                accountSettings: opts.accountSettings ?? null,
                start: opts.start ?? null,
                ...(opts.parentSessionStateTarget ? { parentSessionStateTarget: opts.parentSessionStateTarget } : {}),
                ...(pluginIsolationBundle
                    ? { isolation: { env: pluginIsolationBundle.env } }
                    : {}),
            };

            let runtime: ExecutionRunHostRuntime;
            try {
                runtime = runtimeCore.createExecutionRunBackend(runtimeOpts);
            } catch (error) {
                if (pluginIsolationBundle?.shouldCleanupIsolation) {
                    await cleanupExecutionRunIsolationBundle(pluginIsolationBundle);
                }
                throw error;
            }

            const runtimeWithIdentity = withExecutionRunRuntimeIdentityPublication({
                runtime,
                identity: buildExecutionRunRuntimeIdentityPublication(engineResolution),
            });
            if (pluginIsolationBundle?.shouldCleanupIsolation && pluginIsolationBundle.cleanup) {
                return withExecutionRunHostRuntimeCleanup(runtimeWithIdentity, pluginIsolationBundle.cleanup);
            }
            return runtimeWithIdentity;
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
    happyHomeDir?: string | null;
    parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
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
    const runtimeBackendId = resolvedBackendTarget?.canonical.sourceKind === 'configured'
        ? resolvedBackendTarget.canonical.configuredBackendId ?? resolvedBackendTarget.canonical.backendId
        : backendId;
    const runtimeBackendTarget = resolvedBackendTarget?.canonical.sourceKind === 'configured'
        ? {
            ...resolvedBackendTarget.canonical,
            configuredBackendId: resolvedBackendTarget.canonical.configuredBackendId ?? resolvedBackendTarget.canonical.backendId,
            sourceKind: 'configured' as const,
        }
        : resolvedBackendTarget?.canonical;
    const runtimeShellConfig = createEngineExecutionRunRuntimeShellConfig({
            cwd: opts.cwd,
            runId: opts.runId,
            backendId: runtimeBackendId,
            ...(runtimeBackendTarget ? { backendTarget: runtimeBackendTarget } : {}),
            modelId: opts.modelId,
            permissionMode: opts.permissionMode,
            accountSettings,
            start: opts.start ?? null,
            happyHomeDir: opts.happyHomeDir ?? null,
            parentSessionStateTarget: opts.parentSessionStateTarget ?? null,
        });
    return createLazyExecutionRunHostRuntime(runtimeShellConfig);
}
