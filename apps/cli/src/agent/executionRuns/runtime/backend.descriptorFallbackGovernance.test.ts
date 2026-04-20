import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecutionRunHostRuntime,
    ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { listNativeReviewEngines } from '@happier-dev/protocol';

const getExecutionRunBackendDescriptorMock = vi.fn();
const resolveBackendEngineAdapterResolutionMock = vi.fn();

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

        const { createExecutionRunBackend } = await import('./backend.testkit');
        const backend = createExecutionRunBackend({
            cwd: '/tmp',
            backendId: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' as never },
            permissionMode: 'read_only',
        });

        await expect(backend.startSession('boot')).rejects.toThrow('Unsupported execution-run backend');
        expect(descriptorFactory).not.toHaveBeenCalled();
    });

    it('allows the legacy descriptor fallback only for native review engines', async () => {
        const reviewId = listNativeReviewEngines()[0]?.id;
        expect(typeof reviewId).toBe('string');
        const { MissingBoundCliBindingsError } = await import('@/agent/runtime/registry/createCliBindings');

        const descriptorFactory = vi.fn(() => createStubBackend('review'));
        getExecutionRunBackendDescriptorMock.mockReturnValue({ factory: descriptorFactory });
        resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
            backendId: reviewId,
            providerId: 'review-provider',
            source: 'built_in',
            backend: { id: reviewId, providerId: 'review-provider' },
            provider: { id: 'review-provider' },
            engineAdapter: {
                bindings: {
                    createExecutionRunBackend() {
                        throw new MissingBoundCliBindingsError(reviewId as string, 'execution runs');
                    },
                },
            },
            executionSurfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        const { createExecutionRunBackend } = await import('./backend.testkit');
        const backend = createExecutionRunBackend({
            cwd: '/tmp',
            backendId: reviewId as string,
            permissionMode: 'read_only',
        });

        await expect(backend.startSession('boot')).resolves.toEqual({ sessionId: 's_review' });
        expect(descriptorFactory).toHaveBeenCalledTimes(1);
    });
});
