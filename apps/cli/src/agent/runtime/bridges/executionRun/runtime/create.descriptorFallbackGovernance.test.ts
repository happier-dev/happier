import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecutionRunHostRuntime,
    ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

const getExecutionRunBackendDescriptorMock = vi.fn();
const resolveBackendEngineAdapterResolutionMock = vi.fn();
const TEST_SECONDARY_BACKEND_ID = `${'secondary'}.${'backend'}` as never;

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
    getExecutionRunBackendDescriptor: (...args: unknown[]) => getExecutionRunBackendDescriptorMock(...args),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
    resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

function createStubBackend(label: string): ExecutionRunHostRuntime {
    let handler: ExecutionRunHostRuntimeMessageHandler | null = null;
    return {
        async readResumeSupport() {
            return false;
        },
        async provisionSession() {
            return { sessionId: `s_${label}` };
        },
        async sendPrompt() {},
        async cancel() {},
        subscribeMessages(next) {
            handler = next;
            return () => {
                if (handler === next) handler = null;
            };
        },
        async dispose() {},
    };
}

function withFastFailure<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
            setTimeout(() => reject(new Error('runtimeCore registry path did not settle')), 1_000);
        }),
    ]);
}

describe('createExecutionRunBackend (descriptor fallback governance)', () => {
    beforeEach(() => {
        vi.resetModules();
        getExecutionRunBackendDescriptorMock.mockReset();
        resolveBackendEngineAdapterResolutionMock.mockReset();
    });

    it('fails closed for non-review backends when engine registry resolution is missing (even if a descriptor is present)', async () => {
        const descriptorFactory = vi.fn(() => createStubBackend('descriptor'));
        getExecutionRunBackendDescriptorMock.mockReturnValue({ factory: descriptorFactory });
        resolveBackendEngineAdapterResolutionMock.mockResolvedValue(null);

        const { createExecutionRunRuntime } = await import('./create');
        const backend = createExecutionRunRuntime({
            cwd: '/tmp',
            backendId: TEST_SECONDARY_BACKEND_ID,
            backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID as never },
            permissionMode: 'read_only',
        });

        await expect(withFastFailure(backend.provisionSession({ initialPrompt: 'boot' }))).rejects.toThrow('Unsupported execution-run backend');
        expect(descriptorFactory).not.toHaveBeenCalled();
    });

    it('fails closed for review engines when runtimeCore is missing instead of using descriptor fallback', async () => {
        const reviewId = 'acme.review.backend';
        const { MissingBoundCliRuntimeCoreError } = await import('@/agent/runtime/registry/createCliRuntimeCore');

        const descriptorFactory = vi.fn(() => createStubBackend('review'));
        getExecutionRunBackendDescriptorMock.mockReturnValue({ factory: descriptorFactory });
        resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
            backendId: reviewId,
            agentId: 'review-provider',
            source: 'built_in',
            backend: { id: reviewId, agentId: 'review-provider' },
            agent: { id: 'review-provider' },
            engineAdapter: {
                runtimeCore: {
                    createExecutionRunBackend() {
                        throw new MissingBoundCliRuntimeCoreError(reviewId as string, 'execution runs');
                    },
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
        const backend = createExecutionRunRuntime({
            cwd: '/tmp',
            backendId: reviewId,
            permissionMode: 'read_only',
        });

        await expect(withFastFailure(backend.provisionSession({ initialPrompt: 'boot' }))).rejects.toThrow(/bound host runtimeCore|Unsupported execution-run backend/i);
        expect(descriptorFactory).not.toHaveBeenCalled();
    });
});
