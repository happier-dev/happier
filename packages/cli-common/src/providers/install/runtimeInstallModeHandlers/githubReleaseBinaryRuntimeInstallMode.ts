import type { AgentCliManagedInstallSpec } from '@happier-dev/agents';

import { installManagedBinaryProviderCli } from '../managedInstall.js';
import { buildRuntimeInstallModeOkResult } from '../runtimeInstallModeResult.js';

import type { RuntimeInstallModeHandlerEntry, RuntimeInstallModeHandlerParams } from '../runtimeInstallModeTypes.js';

export const githubReleaseBinaryRuntimeInstallModeHandler: RuntimeInstallModeHandlerEntry = {
    matchesPlan: (plan) => plan.managedInstall?.kind === 'github_release_binary',
    run: async (params: RuntimeInstallModeHandlerParams) => {
        const { runtimeSpec, plan, env, lifecycleContext, deps } = params;
        await installManagedBinaryProviderCli({
            runtimeSpec,
            managedInstall: plan.managedInstall as Extract<AgentCliManagedInstallSpec, { kind: 'github_release_binary' }>,
            env,
            logPath: lifecycleContext.logPath,
            deps,
            appendLogLine: lifecycleContext.appendLogLine,
        });
        return buildRuntimeInstallModeOkResult({ plan, lifecycleContext });
    },
};
