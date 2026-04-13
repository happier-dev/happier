import type { InstallProviderCliResult, ProviderCliInstallPlan } from '../install.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';

type RuntimeInstallModeErrorCode = Extract<InstallProviderCliResult, { ok: false }>['errorCode'];

type RuntimeInstallModeResultInputs = Readonly<{
    plan: ProviderCliInstallPlan;
    lifecycleContext: RuntimeInstallLifecycleContext;
}>;

export function buildRuntimeInstallModeOkResult(params: RuntimeInstallModeResultInputs): InstallProviderCliResult {
    return {
        ok: true,
        plan: params.plan,
        logPath: params.lifecycleContext.logPath,
        alreadyInstalled: false,
    };
}

export function buildRuntimeInstallModeErrorResult(params: Readonly<{
    plan: ProviderCliInstallPlan;
    lifecycleContext: RuntimeInstallLifecycleContext;
    errorCode: RuntimeInstallModeErrorCode;
    errorMessage: string;
}>): InstallProviderCliResult {
    return {
        ok: false,
        plan: params.plan,
        logPath: params.lifecycleContext.logPath,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
    };
}
