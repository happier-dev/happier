import type { InstallAgentCliResult, AgentCliInstallPlan } from '../install.js';
import type { AgentCliRuntimeDescriptor } from '../resolution.js';
import type { ManagedInstallDeps } from './managedInstall.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';

export type RuntimeInstallModeHandlerParams = Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
    plan: AgentCliInstallPlan;
    env: NodeJS.ProcessEnv;
    lifecycleContext: RuntimeInstallLifecycleContext;
    deps: ManagedInstallDeps;
    spawn: typeof import('node:child_process').spawnSync;
}>;

export type RuntimeInstallModeHandlerEntry = Readonly<{
    matchesPlan: (plan: AgentCliInstallPlan) => boolean;
    run: (params: RuntimeInstallModeHandlerParams) => Promise<InstallAgentCliResult>;
}>;
