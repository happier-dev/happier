import { describe, expect, it } from 'vitest';

import { resolveExecutionRunGetFailureLoadedState } from './resolveExecutionRunGetFailureLoadedState';

describe('resolveExecutionRunGetFailureLoadedState', () => {
    const transcriptFallback = {
        run: {
            runId: 'run_1',
            callId: 'toolu_1',
            sidechainId: 'toolu_1',
            intent: 'review' as const,
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' } as const,
            permissionMode: 'read-only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded' as const,
            ioMode: 'streaming' as const,
            status: 'succeeded' as const,
            startedAtMs: 1,
        },
        latestToolResult: { ok: true },
    } as const satisfies NonNullable<Parameters<typeof resolveExecutionRunGetFailureLoadedState>[0]['transcriptFallback']>;

    it('keeps transcript fallback when execution.run.get is unavailable and daemon fallback is missing', () => {
        expect(resolveExecutionRunGetFailureLoadedState({
            result: {
                error: 'RPC method not available',
                errorCode: 'RPC_METHOD_NOT_AVAILABLE',
            },
            transcriptFallback,
            daemonFallback: null,
        })).toEqual({
            status: 'loaded',
            run: transcriptFallback.run,
            latestToolResult: transcriptFallback.latestToolResult,
            source: 'transcript_fallback',
        });
    });

    it('prefers daemon fallback when execution.run.get is unavailable and daemon state exists', () => {
        const daemonFallback = {
            run: {
                ...transcriptFallback.run,
                status: 'running' as const,
            },
            daemonProcessLine: 'PID 123',
        } as const satisfies NonNullable<Parameters<typeof resolveExecutionRunGetFailureLoadedState>[0]['daemonFallback']>;

        expect(resolveExecutionRunGetFailureLoadedState({
            result: {
                error: 'RPC method not available',
                errorCode: 'RPC_METHOD_NOT_AVAILABLE',
            },
            transcriptFallback,
            daemonFallback,
        })).toEqual({
            status: 'loaded',
            run: daemonFallback.run,
            latestToolResult: transcriptFallback.latestToolResult,
            source: 'daemon_fallback',
        });
    });

    it('uses transcript fallback for not-found runs', () => {
        expect(resolveExecutionRunGetFailureLoadedState({
            result: {
                error: 'Not found',
                errorCode: 'execution_run_not_found',
            },
            transcriptFallback,
            daemonFallback: null,
        })).toEqual({
            status: 'loaded',
            run: transcriptFallback.run,
            latestToolResult: transcriptFallback.latestToolResult,
            source: 'transcript_fallback',
        });
    });
});
