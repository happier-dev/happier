import { describe, expect, it, vi } from 'vitest';

type AgentBackendLike = Readonly<{
    provisionSession: (opts?: Readonly<{ initialPrompt?: string; resumeSessionId?: string }>) => Promise<{ sessionId: string }>;
    subscribeMessages: (handler: (msg: unknown) => void) => () => void;
}>;

type RuntimeCoreEnvelopeLike = RuntimeCoreLike | Readonly<{ runtimeCore: RuntimeCoreLike }>;
type RuntimeCoreLike = Readonly<{
    createExecutionRunBackend: (params: unknown) => AgentBackendLike;
}>;

describe('Pi runtimeCore execution runs', () => {
    it('does not rely on execution-run host-runtime type recovery for the Pi leaf', async () => {
        vi.resetModules();
        vi.doMock('@/agent/runtime/bridges/executionRun/executionRunHostRuntime', async (importOriginal) => ({
            ...(await importOriginal<typeof import('@/agent/runtime/bridges/executionRun/executionRunHostRuntime')>()),
            requireExecutionRunHostRuntime: vi.fn(() => {
                throw new Error('Pi runtimeCore should not need execution-run host-runtime recovery');
            }),
        }));

        const { agent } = await import('@/backends/pi');
        const bindingFactoryOrCreator = await agent.getRuntimeCore!();
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
        const runtimeBinding = resolvedBinding as RuntimeCoreEnvelopeLike;
        const runtimeCore = 'runtimeCore' in runtimeBinding ? runtimeBinding.runtimeCore : runtimeBinding;

        const runtime = (runtimeCore as { createExecutionRunBackend: (params: unknown) => AgentBackendLike }).createExecutionRunBackend({
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
