import type { AgentCliManagedInstallSpec } from '@happier-dev/agents';

import { installManagedPackageProviderCli } from '../managedInstall.js';
import { buildRuntimeInstallModeOkResult } from '../runtimeInstallModeResult.js';

import type { RuntimeInstallModeHandlerEntry, RuntimeInstallModeHandlerParams } from '../runtimeInstallModeTypes.js';

export const managedPackageRuntimeInstallModeHandler: RuntimeInstallModeHandlerEntry = {
    matchesPlan: (plan) => plan.managedInstall?.kind === 'managed_package',
    run: async (params: RuntimeInstallModeHandlerParams) => {
        const { runtimeSpec, plan, env, lifecycleContext, deps } = params;
        await installManagedPackageProviderCli({
            runtimeSpec,
            managedInstall: plan.managedInstall as Extract<AgentCliManagedInstallSpec, { kind: 'managed_package' }>,
            env,
            logPath: lifecycleContext.logPath,
            deps,
            appendCommandLog: lifecycleContext.appendCommandLog,
        });
        return buildRuntimeInstallModeOkResult({ plan, lifecycleContext });
    },
};
