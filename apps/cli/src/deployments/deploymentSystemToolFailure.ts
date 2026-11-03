import { MISSING_SYSTEM_TOOL_DETAILS } from '@/plugins/runtime/exec/system/tools/diagnostics';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Own-server deployment uses Docker; expose only that closed tool fact, never native diagnostic payloads. */
export function readDeploymentSystemToolFailure(errorCode: string, error: unknown): ActionExecuteFailure | null {
    if (errorCode !== 'plugin_exec_system_tool_unavailable') return null;
    const retained = ActionExecuteFailureSchema.safeParse(error instanceof Error ? error.cause : error);
    const details = isPluginError(error) ? error.details
        : retained.success && retained.data.errorCode === errorCode ? retained.data.details : undefined;
    if (!details || typeof details !== 'object' || Array.isArray(details)
        || !('kind' in details) || details.kind !== MISSING_SYSTEM_TOOL_DETAILS.kind
        || !('toolId' in details) || details.toolId !== 'docker'
        || !('remedy' in details) || details.remedy !== MISSING_SYSTEM_TOOL_DETAILS.remedy) return null;
    return { ok: false, errorCode,
        error: 'Docker is unavailable. Install Docker Engine with Docker Compose on this Machine, make docker available on the daemon PATH, and allow the daemon user to access Docker.',
        details: { ...MISSING_SYSTEM_TOOL_DETAILS, toolId: 'docker' } };
}
