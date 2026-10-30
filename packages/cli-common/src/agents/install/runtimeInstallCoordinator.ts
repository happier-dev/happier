import type { InstallAgentCliResult, AgentCliInstallIntent, AgentCliInstallPlan } from '../install.js';
import { type AgentCliRuntimeDescriptor, type AgentCliSourcePolicy } from '../resolution.js';
import type { ManagedInstallDeps } from './managedInstall.js';
import {
    createRuntimeInstallLifecycleContext,
    disposeRuntimeInstallLifecycleContext,
} from './runtimeInstallLifecycleContext.js';
import { buildRuntimeInstallFailureResult } from './runtimeInstallFailureHandling.js';
import { runRuntimeInstallModeDispatch } from './runtimeInstallModeDispatch.js';
import { runRuntimeInstallPreflight } from './runtimeInstallPreflight.js';
import type { AgentInstallProgressCallback } from '../installProgress.js';
import { ExecFileTerminationError } from '../../process/index.js';

export async function runRuntimeInstallCoordinator(params: Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
    plan: AgentCliInstallPlan;
    env: NodeJS.ProcessEnv;
    logDir?: string | null;
    dryRun?: boolean;
    skipIfInstalled?: boolean;
    intent?: AgentCliInstallIntent;
    allowVendorRecipeExecution?: boolean;
    sourcePolicy?: AgentCliSourcePolicy;
    signal?: AbortSignal;
    onProgress?: AgentInstallProgressCallback;
    deps: ManagedInstallDeps;
}>): Promise<InstallAgentCliResult> {
    params.signal?.throwIfAborted();
    const { runtimeSpec, plan, env } = params;

    const preflight = runRuntimeInstallPreflight({
        runtimeSpec,
        plan,
        env,
        dryRun: params.dryRun,
        skipIfInstalled: params.skipIfInstalled,
        intent: params.intent,
        allowVendorRecipeExecution: params.allowVendorRecipeExecution,
        sourcePolicy: params.sourcePolicy,
    });
    if (preflight.kind === 'return') {
        return preflight.result;
    }

    const lifecycleContext = await createRuntimeInstallLifecycleContext({
        runtimeSpec,
        plan,
        env,
        logDir: params.logDir,
        onProgress: params.onProgress,
    });

    try {
        return await runRuntimeInstallModeDispatch({
            runtimeSpec,
            plan,
            env,
            lifecycleContext,
            deps: params.deps,
            signal: params.signal,
            onProgress: lifecycleContext.onProgress,
        });
    } catch (error) {
        if (!(error instanceof ExecFileTerminationError) && params.signal?.aborted) {
            const reason: unknown = params.signal.reason;
            try {
                lifecycleContext.appendLogLine(lifecycleContext.logPath, reason instanceof Error ? reason.message : String(reason));
            } finally {
                params.signal.throwIfAborted();
            }
        }
        return buildRuntimeInstallFailureResult({ error, plan, lifecycleContext });
    } finally {
        await disposeRuntimeInstallLifecycleContext(lifecycleContext);
    }
}
