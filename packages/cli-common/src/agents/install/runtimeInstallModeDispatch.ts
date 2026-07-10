import { spawnSync } from 'node:child_process';

import type { InstallAgentCliResult, AgentCliInstallPlan } from '../install.js';
import { type AgentCliRuntimeDescriptor } from '../resolution.js';
import type { ManagedInstallDeps } from './managedInstall.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';
import { runtimeInstallModeHandlerTable } from './runtimeInstallModeHandlerTable.js';
import {
    buildRuntimeInstallModeErrorResult,
} from './runtimeInstallModeResult.js';

export async function runRuntimeInstallModeDispatch(params: Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
    plan: AgentCliInstallPlan;
    env: NodeJS.ProcessEnv;
    lifecycleContext: RuntimeInstallLifecycleContext;
    deps: ManagedInstallDeps;
}>): Promise<InstallAgentCliResult> {
    const { runtimeSpec, plan, env, lifecycleContext } = params;
    const spawn = params.deps.spawnSync ?? spawnSync;
    const modeHandler = runtimeInstallModeHandlerTable[plan.installMode];
    const modeResult = modeHandler.matchesPlan(plan)
        ? await modeHandler.run({
            runtimeSpec,
            plan,
            env,
            lifecycleContext,
            deps: params.deps,
            spawn,
        })
        : null;
    if (modeResult) {
        return modeResult;
    }

    return buildRuntimeInstallModeErrorResult({
        plan,
        lifecycleContext,
        errorCode: 'no-recipe',
        errorMessage: `Unsupported install mode for ${runtimeSpec.id}`,
    });
}
