import { execFileWithDeadline } from '../../../process/index.js';

import { buildRuntimeInstallModeErrorResult, buildRuntimeInstallModeOkResult } from '../runtimeInstallModeResult.js';
import { installManagedVendorRecipeAgentCli, runVendorRecipeInstall } from '../vendorRecipeInstall.js';

import type { RuntimeInstallModeHandlerEntry, RuntimeInstallModeHandlerParams } from '../runtimeInstallModeTypes.js';

export const vendorRecipeRuntimeInstallModeHandler: RuntimeInstallModeHandlerEntry = {
    matchesPlan: (plan) => plan.managedInstall == null || plan.managedInstall.kind === 'vendor_recipe',
    run: async (params: RuntimeInstallModeHandlerParams) => {
        const { runtimeSpec, plan, env, lifecycleContext, deps } = params;
        const recipeParams = {
            runtimeSpec,
            commands: plan.commands,
            env,
            logPath: lifecycleContext.logPath,
            vendorScratchDir: lifecycleContext.vendorScratchDir,
            runCommand: deps.execFileWithDeadline ?? execFileWithDeadline,
            signal: params.signal,
            onProgress: params.onProgress,
            appendCommandLog: lifecycleContext.appendCommandLog,
            appendLogLine: lifecycleContext.appendLogLine,
        };
        const vendorResult = plan.managedInstall?.kind === 'vendor_recipe'
            ? await installManagedVendorRecipeAgentCli({ ...recipeParams, managedInstall: plan.managedInstall })
            : await runVendorRecipeInstall(recipeParams);
        if (vendorResult.ok) {
            return buildRuntimeInstallModeOkResult({ plan, lifecycleContext });
        }
        return buildRuntimeInstallModeErrorResult({
            plan,
            lifecycleContext,
            errorCode: vendorResult.errorCode,
            errorMessage: vendorResult.errorMessage,
        });
    },
};
