import { describe, expect, it, vi } from 'vitest';

type AgentBackendLike = Readonly<{
    provisionSession: (opts?: Readonly<{ initialPrompt?: string; resumeSessionId?: string }>) => Promise<{ sessionId: string }>;
    subscribeMessages: (handler: (msg: unknown) => void) => () => void;
}>;

type RuntimeBindingLike = RuntimeBindingsLike | Readonly<{ bindings: RuntimeBindingsLike }>;
type RuntimeBindingsLike = Readonly<{
    createExecutionRunBackend: (params: unknown) => AgentBackendLike;
}>;

describe('Pi bindings execution runs', () => {
    it('does not rely on execution-run host-runtime type recovery for the Pi leaf', async () => {
        vi.resetModules();
        vi.doMock('@/agent/runtime/bridges/executionRun/executionRunHostRuntime', async (importOriginal) => ({
            ...(await importOriginal<typeof import('@/agent/runtime/bridges/executionRun/executionRunHostRuntime')>()),
            requireExecutionRunHostRuntime: vi.fn(() => {
                throw new Error('Pi bindings should not need execution-run host-runtime recovery');
            }),
        }));

        const { agent } = await import('@/backends/pi');
        const bindingFactoryOrCreator = await agent.getBindings!();
        const bindingParams = {
            backend: {
                id: 'pi',
                providerId: 'pi',
                source: 'built_in',
                definition: { kindVersion: 1, id: 'pi', providerId: 'pi' },
            },
            provider: {
                id: 'pi',
                source: 'built_in',
                definition: { kindVersion: 1, id: 'pi', ownedBackendIds: ['pi'] },
            },
            executionSurfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
        };
        const maybeResolved = await (bindingFactoryOrCreator as (params?: unknown) => unknown)();
        const bindingFactory =
            typeof maybeResolved === 'function'
                ? maybeResolved as (params: unknown) => unknown
                : bindingFactoryOrCreator as (params: unknown) => unknown;
        const resolvedBinding =
            typeof maybeResolved === 'function'
                ? await bindingFactory(bindingParams)
                : maybeResolved;
        const runtimeBinding = resolvedBinding as RuntimeBindingLike;
        const bindings = 'bindings' in runtimeBinding ? runtimeBinding.bindings : runtimeBinding;

        const runtime = (bindings as { createExecutionRunBackend: (params: unknown) => AgentBackendLike }).createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'pi',
            permissionMode: 'read_only',
            accountSettings: null,
            start: { intent: 'review', retentionPolicy: 'ephemeral' },
        });

        expect(runtime.provisionSession).toBeTypeOf('function');
        expect((runtime as unknown as { startSession?: unknown }).startSession).toBeUndefined();
        expect((runtime as unknown as { onMessage?: unknown }).onMessage).toBeUndefined();

        vi.doUnmock('@/agent/runtime/bridges/executionRun/executionRunHostRuntime');
        vi.resetModules();
    });
});
