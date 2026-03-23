import { buildBackendTargetKey } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createStubBackend = () => ({
  startSession: vi.fn(async () => ({ sessionId: 'pi-session-1' })),
  sendPrompt: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  onMessage: vi.fn(),
  dispose: vi.fn(async () => undefined),
  waitForResponseComplete: vi.fn(async () => undefined),
});

const getExecutionRunBackendDescriptorMock = vi.fn();

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
  getExecutionRunBackendDescriptor: getExecutionRunBackendDescriptorMock,
}));

describe('createExecutionRunBackend (pi)', () => {
  beforeEach(() => {
    getExecutionRunBackendDescriptorMock.mockReset();
    getExecutionRunBackendDescriptorMock.mockImplementation((backendId: string) => {
      if (backendId !== 'pi') return null;
      return {
        factory: vi.fn(() => createStubBackend()),
      };
    });
  });

  it('does not throw when backendId is pi', async () => {
    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');

    expect(() =>
      createExecutionRunBackend({ cwd: process.cwd(), backendId: 'pi', permissionMode: 'read_only' }),
    ).not.toThrow();
  });

  it('throws when the built-in backend target is disabled in account settings', async () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'pi' });
    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');

    expect(() =>
      createExecutionRunBackend({
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
