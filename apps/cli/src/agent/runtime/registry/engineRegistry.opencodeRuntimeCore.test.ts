import { beforeEach, describe, expect, it, vi } from 'vitest';

const getExecutionRunBackendDescriptorMock = vi.fn(() => {
  throw new Error('legacy executionRunBackendRegistry must not be used for opencode once runtimeCore exist');
});

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
  getExecutionRunBackendDescriptor: getExecutionRunBackendDescriptorMock,
}));

describe('engineRegistry (opencode runtimeCore)', () => {
  beforeEach(() => {
    getExecutionRunBackendDescriptorMock.mockClear();
  });

  it('creates an execution-run backend through engine runtimeCore without consulting the legacy execution-run registry', async () => {
    const { resolveBackendEngineAdapterResolution } = await import('./engineRegistry');

    const resolution = await resolveBackendEngineAdapterResolution('opencode');
    expect(resolution?.backendId).toBe('opencode');

    const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
      cwd: process.cwd(),
      backendId: 'opencode',
      permissionMode: 'read_only',
    });

    expect(runtime).toEqual(expect.objectContaining({
      provisionSession: expect.any(Function),
      readResumeSupport: expect.any(Function),
      sendPrompt: expect.any(Function),
      cancel: expect.any(Function),
      subscribeMessages: expect.any(Function),
      dispose: expect.any(Function),
    }));
    expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
  });
});
