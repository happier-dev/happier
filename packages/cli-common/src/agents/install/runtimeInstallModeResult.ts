import type { InstallAgentCliResult, AgentCliInstallPlan } from '../install.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';

type RuntimeInstallModeErrorCode = Extract<InstallAgentCliResult, { ok: false }>['errorCode'];

type RuntimeInstallModeResultInputs = Readonly<{
    plan: AgentCliInstallPlan;
    lifecycleContext: RuntimeInstallLifecycleContext;
}>;

export function buildRuntimeInstallModeOkResult(params: RuntimeInstallModeResultInputs): InstallAgentCliResult {
    return {
        ok: true,
        plan: params.plan,
        logPath: params.lifecycleContext.logPath,
        alreadyInstalled: false,
    };
}

export function buildRuntimeInstallModeErrorResult(params: Readonly<{
    plan: AgentCliInstallPlan;
    lifecycleContext: RuntimeInstallLifecycleContext;
    errorCode: RuntimeInstallModeErrorCode;
    errorMessage: string;
}>): InstallAgentCliResult {
    return {
        ok: false,
        plan: params.plan,
        logPath: params.lifecycleContext.logPath,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
    };
}
