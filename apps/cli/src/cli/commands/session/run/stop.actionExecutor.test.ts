import { describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));
const resolveSessionTransportContext = vi.fn(async () => ({ ok: true, sessionId: 'sess-canonical' }));
const printJsonEnvelope = vi.fn(async () => {});

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({ resolveSessionTransportContext }));
vi.mock('@/cli/output/jsonEnvelope', () => ({
  wantsJson: (argv: readonly string[]) => argv.includes('--json'),
  printJsonEnvelope,
}));

describe('happier session run stop (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, stopped: true },
    });

    const { cmdSessionRunStop } = await import('./stop');

    await cmdSessionRunStop(['session', 'run', 'sess-prefix', 'run-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'execution.run.stop',
        { sessionId: 'sess-canonical', runId: 'run-1' },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(printJsonEnvelope).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        kind: 'session_run_stop',
        data: { sessionId: 'sess-canonical', runId: 'run-1', stopped: true },
      }));
  });
});
