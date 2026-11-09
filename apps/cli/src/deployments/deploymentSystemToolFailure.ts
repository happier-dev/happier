import { MISSING_SYSTEM_TOOL_DETAILS } from '@/plugins/runtime/exec/system/tools/diagnostics';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Expose closed Docker prerequisite facts, never private native diagnostic payloads. */
export function readDeploymentSystemToolFailure(errorCode: string, error: unknown): ActionExecuteFailure | null {
    if (errorCode === 'docker_buildx_not_installed') return { ok: false, errorCode,
        error: 'Docker Buildx is unavailable on the image preparation Machine. Install the Docker Buildx plugin (docker-buildx-plugin with Docker Engine packages) and verify docker buildx version works for the daemon user.',
        details: { kind: 'systemToolUnavailable', toolId: 'docker-buildx', remedy: 'install_docker_buildx_plugin_on_machine' } };
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
