import {
    applyOpenCodeSessionAffinityMetadata,
    buildOpenCodeSessionEnvironmentVariables,
    readOpenCodeSessionAffinityFromMetadata,
} from '../shared/opencodeSessionAffinity.js';

type ReplayForkContinuation = Readonly<{
    spawn: Readonly<{
        environmentVariables?: Readonly<Record<string, string>>;
    }>;
    metadata: Readonly<Record<string, unknown>>;
}>;

export async function opencodeReplayForkContinuationHandler(params: Readonly<{
    parentMetadata: Record<string, unknown>;
}>): Promise<ReplayForkContinuation | null> {
    const affinity = readOpenCodeSessionAffinityFromMetadata(params.parentMetadata);
    if (!affinity.backendMode) return null;

    // Preserve backend mode (server vs ACP) and inherit server affinity only when it was explicit.
    const env = buildOpenCodeSessionEnvironmentVariables({
        backendMode: affinity.backendMode,
        serverBaseUrl: affinity.serverBaseUrlExplicit ? affinity.serverBaseUrl : null,
        serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
    });
    const metadata = applyOpenCodeSessionAffinityMetadata({
        backendMode: affinity.backendMode,
        serverBaseUrl: affinity.serverBaseUrlExplicit ? affinity.serverBaseUrl : null,
        serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
    });

    return {
        spawn: { environmentVariables: env },
        metadata,
    };
}
