import { buildBackendTargetKey } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

const createStubRuntime = () => {
  const messages: AgentMessage[] = [];
  let handler: ExecutionRunHostRuntimeMessageHandler | null = null;

  const runtime: ExecutionRunHostRuntime = {
    readResumeSupport: vi.fn(async () => false),
    provisionSession: vi.fn(async () => {
      handler?.({ type: 'model-output', fullText: 'pi-runtime-ready' });
      return { sessionId: 'pi-session-1' };
    }),
    sendPrompt: vi.fn(async (_sessionId: string, prompt: string) => {
      handler?.({ type: 'model-output', fullText: `pi:${prompt}` });
    }),
    cancel: vi.fn(async () => undefined),
    subscribeMessages: vi.fn((next: ExecutionRunHostRuntimeMessageHandler) => {
      handler = next;
      return () => {
        if (handler === next) {
          handler = null;
        }
      };
    }),
    waitForTurnCompletion: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };

  return { runtime, messages };
};

const resolveBackendEngineAdapterResolutionMock = vi.fn();
const getExecutionRunBackendDescriptorMock = vi.fn();

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
  getExecutionRunBackendDescriptor: (...args: unknown[]) => getExecutionRunBackendDescriptorMock(...args),
}));

describe('createExecutionRunBackend (pi)', () => {
  beforeEach(() => {
    resolveBackendEngineAdapterResolutionMock.mockReset();
    getExecutionRunBackendDescriptorMock.mockReset();
  });

  it('creates the pi execution-run runtime through runtimeCore without using the legacy execution-run registry directly', async () => {
    const { runtime, messages } = createStubRuntime();
    const createExecutionRunBackendMock = vi.fn(() => runtime);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'pi',
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
    });
    const { createExecutionRunRuntime } = await import('./create');

    const executionRuntime = createExecutionRunRuntime({
      cwd: process.cwd(),
      backendId: 'pi',
      permissionMode: 'read_only',
    });

    const unsubscribe = executionRuntime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(executionRuntime.provisionSession()).resolves.toEqual({ sessionId: 'pi-session-1' });
    await expect(executionRuntime.sendPrompt('pi-session-1', 'hello')).resolves.toBeUndefined();
    await expect(executionRuntime.cancel('pi-session-1')).resolves.toBeUndefined();
    await expect(executionRuntime.waitForTurnCompletion?.()).resolves.toBeUndefined();
    await expect(executionRuntime.dispose()).resolves.toBeUndefined();
    unsubscribe();

    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('pi', expect.any(Object));
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'pi',
      permissionMode: 'read_only',
    }));
    expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    expect(messages).toEqual(expect.arrayContaining([
      { type: 'model-output', fullText: 'pi-runtime-ready' },
      { type: 'model-output', fullText: 'pi:hello' },
      {
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
        },
      },
    ]));
    expect('startSession' in executionRuntime).toBe(false);
    expect('onMessage' in executionRuntime).toBe(false);
  });

  it('keeps the AgentBackend compatibility shell bounded over the runtimeCore-owned runtime', async () => {
    const { runtime } = createStubRuntime();
    const createExecutionRunBackendMock = vi.fn(() => runtime);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'pi',
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
    });
    const { createExecutionRunBackend } = await import('../testkit');

    const backend = createExecutionRunBackend({
      cwd: process.cwd(),
      backendId: 'pi',
      permissionMode: 'read_only',
    });

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'pi-session-1' });
    await expect(backend.sendPrompt('pi-session-1', 'hello')).resolves.toBeUndefined();
    await expect(backend.cancel('pi-session-1')).resolves.toBeUndefined();
    await expect(backend.waitForResponseComplete?.()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();

    expect(createExecutionRunBackendMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the built-in backend target is disabled in account settings before creating the legacy shell', async () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'pi' });
    const { createExecutionRunRuntime } = await import('./create');

    expect(() =>
      createExecutionRunRuntime({
        cwd: process.cwd(),
        backendId: 'pi',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        permissionMode: 'read_only',
        accountSettings: {
          backendEnabledByTargetKey: {
            [targetKey]: false,
          },
        },
      }),
    ).toThrow('pi is disabled in your account settings (enable it in the UI provider settings).');
  });
});
