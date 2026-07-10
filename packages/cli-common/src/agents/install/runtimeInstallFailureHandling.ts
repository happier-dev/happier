import type { InstallAgentCliResult, AgentCliInstallPlan } from '../install.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';

type RuntimeInstallFailureErrorCode = 'managed-runtime-unavailable' | 'command-failed';

function resolveRuntimeInstallFailureMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function classifyRuntimeInstallFailureErrorCode(message: string): RuntimeInstallFailureErrorCode {
    if (
        message.startsWith('Managed pnpm is unavailable') ||
        message.startsWith('Managed JavaScript runtime is unavailable')
    ) {
        return 'managed-runtime-unavailable';
    }
    return 'command-failed';
}

export function buildRuntimeInstallFailureResult(params: Readonly<{
    error: unknown;
    plan: AgentCliInstallPlan;
    lifecycleContext: RuntimeInstallLifecycleContext;
}>): InstallAgentCliResult {
    const errorMessage = resolveRuntimeInstallFailureMessage(params.error);
    const errorCode = classifyRuntimeInstallFailureErrorCode(errorMessage);
    params.lifecycleContext.appendLogLine(params.lifecycleContext.logPath, errorMessage);
    return {
        ok: false,
        errorCode,
        errorMessage,
        plan: params.plan,
        logPath: params.lifecycleContext.logPath,
    };
}
