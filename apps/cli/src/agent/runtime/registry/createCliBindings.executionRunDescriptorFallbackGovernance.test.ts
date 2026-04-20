import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecutionRunHostRuntime,
    ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { ResolvedBackendContribution } from '@/extensions/registry/types';
import { listNativeReviewEngines } from '@happier-dev/protocol';

const getExecutionRunBackendDescriptorMock = vi.fn();

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
    getExecutionRunBackendDescriptor: (...args: unknown[]) => getExecutionRunBackendDescriptorMock(...args),
}));

function createStubRuntime(): ExecutionRunHostRuntime {
    let handler: ExecutionRunHostRuntimeMessageHandler | null = null;
    return {
        async readResumeSupport() {
            return false;
        },
        async provisionSession() {
            handler?.({ type: 'model-output', fullText: 'started' });
            return { sessionId: 's1' };
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

function createBuiltInBackendContribution(backendId: string): ResolvedBackendContribution {
    return {
        id: backendId,
        providerId: 'built-in-provider',
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: { kindVersion: 1, id: backendId, providerId: 'built-in-provider' },
        runtimeKind: 'native',
    };
}

describe('resolveCliBindingRuntime (execution-run descriptor fallback governance)', () => {
    beforeEach(() => {
        vi.resetModules();
        getExecutionRunBackendDescriptorMock.mockReset();
    });

    it('fails closed for non-review execution runs when no bound bindings exist even if terminalRuntime launch is available', async () => {
        const descriptorFactory = vi.fn(() => createStubRuntime());
        getExecutionRunBackendDescriptorMock.mockReturnValue({ factory: descriptorFactory });

        const launch = vi.fn(async () => createStubRuntime());

        const { createMissingCliEngineAdapter } = await import('./createCliBindings');
        const bindings = createMissingCliEngineAdapter({
            backend: createBuiltInBackendContribution('codex'),
        }).bindings;

        expect(() => bindings.createExecutionRunBackend({
            cwd: '/tmp',
            backendId: 'codex',
            permissionMode: 'read_only',
        })).toThrow(/bound host bindings/i);

        expect(launch).not.toHaveBeenCalled();
        expect(descriptorFactory).not.toHaveBeenCalled();
    });

    it('fails closed for interactive sessions when no bound bindings exist even if terminalRuntime launch is available', async () => {
        const launch = vi.fn(async () => createStubRuntime());

        const { createMissingCliEngineAdapter } = await import('./createCliBindings');
        const bindings = createMissingCliEngineAdapter({
            backend: createBuiltInBackendContribution('codex'),
        }).bindings;

        await expect(
            bindings.createSessionRuntime({
                cwd: '/tmp',
            }),
        ).rejects.toThrow(/bound host bindings/i);

        expect(launch).not.toHaveBeenCalled();
    });

    it('fails closed for review-engine execution runs when no bound bindings exist in the shared registry layer', async () => {
        const reviewId = listNativeReviewEngines()[0]?.id;
        expect(typeof reviewId).toBe('string');

        const descriptorFactory = vi.fn(() => createStubRuntime());
        getExecutionRunBackendDescriptorMock.mockReturnValue({ factory: descriptorFactory });

        const launch = vi.fn(async () => createStubRuntime());

        const { createMissingCliEngineAdapter } = await import('./createCliBindings');
        const bindings = createMissingCliEngineAdapter({
            backend: createBuiltInBackendContribution(reviewId as string),
        }).bindings;

        expect(() => bindings.createExecutionRunBackend({
            cwd: '/tmp',
            backendId: reviewId as string,
            permissionMode: 'read_only',
        })).toThrow(/bound host bindings/i);
        expect(descriptorFactory).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
    });
});
