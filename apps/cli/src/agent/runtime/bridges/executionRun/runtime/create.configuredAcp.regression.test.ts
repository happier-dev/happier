import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecutionRunHostRuntime,
    ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

const resolveBackendEngineAdapterResolutionMock = vi.fn();

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
    resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

function createStubRuntime(): ExecutionRunHostRuntime {
    let handler: ExecutionRunHostRuntimeMessageHandler | null = null;

    return {
        async readResumeSupport() {
            return false;
        },
        async provisionSession() {
            return { sessionId: 'configured-session-1' };
        },
        async sendPrompt() {
            handler?.({ type: 'model-output', fullText: 'configured ok' });
        },
        async cancel() {},
        subscribeMessages(next) {
            handler = next;
            return () => {
                if (handler === next) {
                    handler = null;
                }
            };
        },
        async dispose() {},
    };
}

function withFastFailure<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
            setTimeout(() => reject(new Error('runtimeCore registry path was not used')), 1_000);
        }),
    ]);
}

describe('createExecutionRunRuntime configured ACP registry convergence', () => {
    beforeEach(() => {
        vi.resetModules();
        resolveBackendEngineAdapterResolutionMock.mockReset();
    });

    it('routes configured ACP execution runs through the concrete runtimeCore backend id', async () => {
        const runtime = createStubRuntime();
        const createExecutionRunBackend = vi.fn(() => runtime);
        resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
            backendId: 'review-bot',
            agentId: 'review-bot',
            source: 'plugin',
            backend: { id: 'review-bot', agentId: 'review-bot' },
            agent: { id: 'review-bot' },
            engineAdapter: {
                runtimeCore: {
                    createExecutionRunBackend,
                },
            },
            executionSurfaces: {
                terminalRuntime: null,
                externalSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        const { createExecutionRunRuntime } = await import('./create');
        const configuredRuntime = createExecutionRunRuntime({
            cwd: '/tmp/workspace',
            backendId: 'customAcp',
            backendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
                sourceKind: 'configured',
            },
            permissionMode: 'read_only',
        });

        await expect(withFastFailure(configuredRuntime.provisionSession())).resolves.toEqual({ sessionId: 'configured-session-1' });
        expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('review-bot', expect.any(Object));
        expect(createExecutionRunBackend).toHaveBeenCalledWith(expect.objectContaining({
            cwd: '/tmp/workspace',
            backendId: 'review-bot',
            backendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
                sourceKind: 'configured',
            },
            permissionMode: 'read_only',
        }));
    });
});
