import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';

export async function requireTerminalRuntimeResolveTranscriptBinding<TParams>(
    backendId?: string | null,
): Promise<(params: TParams) => LocalHostedDirectTranscriptBinding | undefined | Promise<LocalHostedDirectTranscriptBinding | undefined>> {
    const terminalRuntimeOps = (await resolveBackendExecutionSurfaces(backendId)).terminalRuntime;
    if (!terminalRuntimeOps?.resolveTranscriptBinding) {
        throw new Error(`${backendId ?? 'default'} terminal runtime transcript binding adapter is not configured`);
    }

    return terminalRuntimeOps.resolveTranscriptBinding as (
        params: TParams,
    ) => LocalHostedDirectTranscriptBinding | undefined | Promise<LocalHostedDirectTranscriptBinding | undefined>;
}
