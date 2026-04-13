import type { InstallProviderCliResult, ProviderCliInstallPlan } from '../install.js';
import type { ProviderCliRuntimeDescriptor } from '../resolution.js';
import type { ManagedInstallDeps } from './managedInstall.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';

export type RuntimeInstallModeHandlerParams = Readonly<{
    runtimeSpec: ProviderCliRuntimeDescriptor;
    plan: ProviderCliInstallPlan;
    env: NodeJS.ProcessEnv;
    lifecycleContext: RuntimeInstallLifecycleContext;
    deps: ManagedInstallDeps;
    spawn: typeof import('node:child_process').spawnSync;
}>;

export type RuntimeInstallModeHandlerEntry = Readonly<{
    matchesPlan: (plan: ProviderCliInstallPlan) => boolean;
    run: (params: RuntimeInstallModeHandlerParams) => Promise<InstallProviderCliResult>;
}>;
