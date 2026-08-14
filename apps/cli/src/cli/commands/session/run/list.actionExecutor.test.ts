import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  writeJsonStdout: vi.fn(async () => {}),
}));

describe('happier session run list (action executor)', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutorFromCredentials.mockClear();
    resolveSessionTransportContext.mockClear();
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, runs: [] },
    });

    const { cmdSessionRunList } = await import('./list');

    await cmdSessionRunList(
        ['session', 'run', 'sess-prefix', '--backend', 'agent:claude', '--status', 'running', '--limit', '5', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'execution.run.list',
        {
          sessionId: 'sess-canonical',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          status: 'running',
          limit: 5,
        },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(printJsonEnvelope).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        kind: 'session_run_list',
        data: expect.objectContaining({ sessionId: 'sess-canonical' }),
      }));
  });

  it('rejects an out-of-range limit before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionRunList } = await import('./list');
    await expect(cmdSessionRunList(['session', 'run', 'sess-prefix', '--limit', '201'], { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
  });
});
