import { describe, expect, it, vi } from 'vitest';

const { mockAxiosGet } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
}));

vi.mock('axios', async () => {
  return {
    default: {
      get: mockAxiosGet,
      post: vi.fn(),
    },
  };
});

describe('happier session --json fail-safe', () => {
  it('prints a session_list error envelope (server_unreachable) on unexpected network errors', async () => {
    mockAxiosGet.mockImplementation(() => {
      const err: any = new Error('connect ECONNREFUSED 127.0.0.1:1');
      err.code = 'ECONNREFUSED';
      throw err;
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleSessionCommand(['list', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'legacy',
            secret: new Uint8Array(32).fill(1),
          },
        }),
      });

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_list');
      expect(parsed.error?.code).toBe('server_unreachable');
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });
});

