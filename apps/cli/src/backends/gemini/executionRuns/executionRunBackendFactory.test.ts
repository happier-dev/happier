import { describe, expect, it, vi } from 'vitest';

const createGeminiBackend = vi.fn();

vi.mock('@/backends/gemini/acp/backend', () => ({
  createGeminiBackend: (opts: any) => createGeminiBackend(opts),
}));

describe('gemini executionRunBackendFactory', () => {
  it('propagates permissionMode through the provider backend factory', async () => {
    const backend = { kind: 'fake' } as any;
    createGeminiBackend.mockReturnValue({ backend });

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    const permissionHandler = { kind: 'handler' } as any;
    const result = executionRunBackendFactory({
      cwd: '/repo',
      backendId: 'gemini',
      permissionMode: 'read_only',
      permissionHandler,
      isolation: { env: { PATH: '/bin' } },
    } as any);

    expect(result).toBe(backend);
    expect(createGeminiBackend).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      env: { PATH: '/bin' },
      permissionHandler,
      permissionMode: 'read-only',
    }));
  });
});

