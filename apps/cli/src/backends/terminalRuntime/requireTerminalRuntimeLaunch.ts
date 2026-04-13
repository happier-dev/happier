import { resolveBackendExecutionSurfaces } from '@/backends/catalog';

export async function requireTerminalRuntimeLaunch<TParams, TResult>(
    backendId?: string | null,
): Promise<(params: TParams) => Promise<TResult>> {
    const terminalRuntimeOps = (await resolveBackendExecutionSurfaces(backendId)).terminalRuntime;
    if (!terminalRuntimeOps?.launch) {
        throw new Error(`${backendId ?? 'default'} terminal runtime launch adapter is not configured`);
    }

    return terminalRuntimeOps.launch as (params: TParams) => Promise<TResult>;
}
