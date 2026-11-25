import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-1' }));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));
const resolveSessionTransportContext = vi.fn();

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

describe('happier session run action (action executor)', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([true, false])('preserves Action refusal output with diagnostics supplied: %s', async (withDiagnostics) => {
    const diagnostics = withDiagnostics ? {
      failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'custodian_only', httpStatus: null },
      requestId: 'refusal-request-1125',
      effectAttempted: false,
    } : {};
    const refusal = { ok: false, errorCode: 'target_unavailable', error: 'target refused', ...diagnostics };
    const argv = ['run', 'action', 'sess-1', 'run-1', 'action-1'];
    const deps = { readCredentialsFn: async () => ({ token: 'token_test', encryption: null }) };
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    const previousExitCode = process.exitCode;
    try {
      execute.mockResolvedValueOnce(refusal);
      await handleSessionCommand([...argv, '--json'], deps);
      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_run_action',
        error: { code: 'target_unavailable', message: 'target refused', ...diagnostics },
      });

      execute.mockResolvedValueOnce(refusal);
      await expect(handleSessionCommand(argv, deps)).rejects.toHaveProperty('message', withDiagnostics
        ? 'target refused\nPhase: execution_authorization; requestId: refusal-request-1125'
        : 'target refused');
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, output: {} },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'action', 'sess-1', 'run-1', 'action-1', '--input-json', '{"a":1}', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.action',
        { sessionId: 'sess-1', runId: 'run-1', actionId: 'action-1', input: { a: 1 } },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_action',
        data: expect.objectContaining({
          sessionId: 'sess-1',
          runId: 'run-1',
          actionId: 'action-1',
          output: {},
        }),
      }));
    } finally {
      output.restore();
    }
  });

  it('refuses malformed argv and an invalid run Action request before reading credentials', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const readCredentialsFn = vi.fn(async () => ({ token: 'token_test', encryption: null }));
    const executionsBefore = execute.mock.calls.length;
    for (const argv of [
      ['run', 'action', 'sess-1', 'run-1', 'resume', '--not-an-option', '--json'],
      ['run', 'action', 'sess-1', 'run-1', 'resume', 'surplus', '--json'],
      ['run', 'action', 'sess-1', 'run-1', 'resume', '--input-json', '{', '--json'],
    ]) {
      const output = captureConsoleJsonOutput();
      try {
        await handleSessionCommand(argv, { readCredentialsFn }).catch(() => undefined);
      } finally {
        output.restore();
      }
    }
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(execute.mock.calls.length).toBe(executionsBefore);
  });

  it('does not resolve an API-token Session through the generic transport', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { ok: true, output: {} } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'action', 'sess-1', 'run-1', 'action-1', '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_run_action' }));
    } finally {
      output.restore();
    }
  });
});
