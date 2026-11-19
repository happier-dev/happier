import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

/** Docker resolves the admitted tuple's context and host overrides. */
export async function readOwnServerDockerEndpoint(docker: ProjectNativeDockerPort, signal?: AbortSignal): Promise<Readonly<{ host: string | null }> | Readonly<{ parseError: unknown }>> {
    const endpoint = await docker.run(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], signal);
    try {
        const host: unknown = JSON.parse(endpoint.stdout.trim());
        return { host: endpoint.exitCode === 0 && !endpoint.stdoutTruncated && typeof host === 'string' ? host : null };
    } catch (parseError) { return { parseError }; }
}
