import type { InstallProviderCliResult, ProviderCliInstallPlan } from '../install.js';
import { type ProviderCliRuntimeDescriptor } from '../resolution.js';
import type { ManagedInstallDeps } from './managedInstall.js';
import {
    createRuntimeInstallLifecycleContext,
    disposeRuntimeInstallLifecycleContext,
} from './runtimeInstallLifecycleContext.js';
import { buildRuntimeInstallFailureResult } from './runtimeInstallFailureHandling.js';
import { runRuntimeInstallModeDispatch } from './runtimeInstallModeDispatch.js';
import { runRuntimeInstallPreflight } from './runtimeInstallPreflight.js';

export async function runRuntimeInstallCoordinator(params: Readonly<{
    runtimeSpec: ProviderCliRuntimeDescriptor;
    plan: ProviderCliInstallPlan;
    env: NodeJS.ProcessEnv;
    logDir?: string | null;
    dryRun?: boolean;
    skipIfInstalled?: boolean;
    allowVendorRecipeExecution?: boolean;
    deps: ManagedInstallDeps;
}>): Promise<InstallProviderCliResult> {
    const { runtimeSpec, plan, env } = params;

    const preflight = runRuntimeInstallPreflight({
        runtimeSpec,
        plan,
        env,
        dryRun: params.dryRun,
        skipIfInstalled: params.skipIfInstalled,
        allowVendorRecipeExecution: params.allowVendorRecipeExecution,
    });
    if (preflight.kind === 'return') {
        return preflight.result;
    }

    const lifecycleContext = await createRuntimeInstallLifecycleContext({
        runtimeSpec,
        plan,
        env,
        logDir: params.logDir,
    });

    try {
        return await runRuntimeInstallModeDispatch({
            runtimeSpec,
            plan,
            env,
            lifecycleContext,
            deps: params.deps,
        });
    } catch (error) {
        return buildRuntimeInstallFailureResult({ error, plan, lifecycleContext });
    } finally {
        await disposeRuntimeInstallLifecycleContext(lifecycleContext);
    }
}
