import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';

const resolveSessionTransportContext = vi.fn();
const listExecutionRuns = vi.fn();
const execute = vi.fn();
const resolveSessionTarget = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/services/executionRuns', () => ({
  listExecutionRuns,
}));

describe('happier session run list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes list requests through the credential-aware Action executor', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        active: false,
        metadata: {},
      },
      ctx: null,
      mode: 'plain',
    });
    listExecutionRuns.mockResolvedValueOnce({
      ok: true,
      data: {
        runs: [
          {
            runId: 'run-1',
            callId: 'call-1',
            sidechainId: 'call-1',
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            status: 'running',
            startedAtMs: 1,
          },
        ],
      },
    });
    resolveSessionTarget.mockResolvedValueOnce({ ok: true, sessionId: 'sess-1' });
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        runs: [
          {
            runId: 'run-1',
            callId: 'call-1',
            sidechainId: 'call-1',
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            status: 'running',
            startedAtMs: 1,
          },
        ],
      },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'list', 'sess-1', '--agent', 'agent:claude', '--status', 'running', '--limit', '5', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(execute).toHaveBeenCalledWith(
        'execution.run.list',
        {
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          status: 'running',
          limit: 5,
        },
        { surface: 'cli', defaultSessionId: 'sess-1' },
      );
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(listExecutionRuns).not.toHaveBeenCalled();

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_list',
        data: expect.objectContaining({
          sessionId: 'sess-1',
          runs: [expect.objectContaining({ runId: 'run-1' })],
        }),
      }));
    } finally {
      output.restore();
    }
  });

  it('does not resolve an API-token Session through the generic transport', async () => {
    resolveSessionTarget.mockResolvedValueOnce({ ok: true, sessionId: 'sess-1' });
    execute.mockResolvedValueOnce({ ok: true, result: { ok: true, runs: [] } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'list', 'sess-1', '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(listExecutionRuns).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_run_list' }));
    } finally {
      output.restore();
    }
  });

  it('rejects retired --backend before credential checks', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    const readCredentialsFn = vi.fn(async () => null);

    try {
      await handleSessionCommand(
        ['run', 'list', 'sess-1', '--backend', 'agent:claude', '--json'],
        { readCredentialsFn },
      );

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_run_list',
        error: {
          code: 'invalid_arguments',
          message: `Usage: ${SESSION_HELP_LINES.runList}`,
        },
      });
      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('rejects an out-of-range limit before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionRunList } = await import('./list');

    await expect(cmdSessionRunList(['session', 'run', 'sess-prefix', '--limit', '201'], { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it('rejects an unsupported status before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionRunList } = await import('./list');

    await expect(cmdSessionRunList(
      ['session', 'run', 'sess-prefix', '--status', 'queued'],
      { readCredentialsFn },
    )).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: 'Invalid --status "queued". Expected one of: running, succeeded, failed, cancelled, timeout.',
    });

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
  });

  it('rejects a malformed Agent target before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionRunList } = await import('./list');

    await expect(cmdSessionRunList(
      ['session', 'run', 'sess-prefix', '--agent', 'claude,codex'],
      { readCredentialsFn },
    )).rejects.toThrow('Usage: happier session run list');

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
  });

  it.each([
    ['--status', {
      code: 'invalid_arguments',
      message: 'Invalid --status "". Expected one of: running, succeeded, failed, cancelled, timeout.',
    }],
    ['--agent', {
      message: expect.stringContaining('Usage: happier session run list'),
    }],
  ] as const)('rejects %s without a value before reading credentials', async (flag, expectedError) => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionRunList } = await import('./list');

    await expect(cmdSessionRunList(
      ['session', 'run', 'sess-prefix', flag],
      { readCredentialsFn },
    )).rejects.toMatchObject(expectedError);

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
  });
});
