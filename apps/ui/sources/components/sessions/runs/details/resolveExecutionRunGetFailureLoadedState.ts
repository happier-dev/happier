import type { ExecutionRunPublicState } from '@happier-dev/protocol';

import type {
    ExecutionRunDaemonFallback,
    ExecutionRunTranscriptFallback,
} from '@/components/sessions/runs/details/resolveDaemonExecutionRunFallback';

export type ExecutionRunDetailsLoadedFallbackState = Readonly<{
    status: 'loaded';
    run: ExecutionRunPublicState;
    latestToolResult?: unknown;
    source: 'transcript_fallback' | 'daemon_fallback';
}>;

type ExecutionRunGetErrorLike = Readonly<{
    error?: string;
    errorCode?: string;
}>;

function readExecutionRunGetErrorLike(input: unknown): ExecutionRunGetErrorLike {
    if (!input || typeof input !== 'object') return {};
    return {
        ...(typeof (input as { error?: unknown }).error === 'string'
            ? { error: String((input as { error: string }).error) }
            : {}),
        ...(typeof (input as { errorCode?: unknown }).errorCode === 'string'
            ? { errorCode: String((input as { errorCode: string }).errorCode) }
            : {}),
    };
}

function isRpcMethodNotAvailableError(input: unknown): boolean {
    const errorLike = readExecutionRunGetErrorLike(input);
    if (String(errorLike.errorCode ?? '') === 'RPC_METHOD_NOT_AVAILABLE') return true;
    return /rpc method not available/i.test(String(errorLike.error ?? ''));
}

export function resolveExecutionRunGetFailureLoadedState(params: Readonly<{
    result: unknown;
    transcriptFallback?: ExecutionRunTranscriptFallback | null;
    daemonFallback?: ExecutionRunDaemonFallback | null;
}>): ExecutionRunDetailsLoadedFallbackState | null {
    if (isRpcMethodNotAvailableError(params.result)) {
        if (params.daemonFallback) {
            return {
                status: 'loaded',
                run: params.daemonFallback.run,
                latestToolResult: params.transcriptFallback?.latestToolResult,
                source: 'daemon_fallback',
            };
        }
        if (params.transcriptFallback) {
            return {
                status: 'loaded',
                run: params.transcriptFallback.run,
                latestToolResult: params.transcriptFallback.latestToolResult,
                source: 'transcript_fallback',
            };
        }
        return null;
    }

    const errorLike = readExecutionRunGetErrorLike(params.result);
    if (String(errorLike.errorCode ?? '') === 'execution_run_not_found' && params.transcriptFallback) {
        return {
            status: 'loaded',
            run: params.transcriptFallback.run,
            latestToolResult: params.transcriptFallback.latestToolResult,
            source: 'transcript_fallback',
        };
    }

    return null;
}
