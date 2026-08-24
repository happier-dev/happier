import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-factory' }));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));
const resolveSessionTransportContext = vi.fn(async () => ({
  ok: true as const,
  sessionId: 'sess-generic',
  mode: 'plain' as const,
  ctx: null,
}));
const startExecutionRunStream = vi.fn(async () => ({ ok: true as const, data: { streamId: 'stream-generic' } }));
const readExecutionRunStream = vi.fn(async () => ({ ok: true as const, data: { events: [], nextCursor: 0 } }));
const cancelExecutionRunStream = vi.fn(async () => ({ ok: true as const, data: {} }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));
vi.mock('@/session/services/executionRuns', () => ({
  startExecutionRunStream,
  readExecutionRunStream,
  cancelExecutionRunStream,
}));

const apiTokenCredentials = {
  token: 'hap_v1_token_secret',
  encryption: null,
  credentialProvenance: 'api_token' as const,
};

describe('happier session run streams (credential-aware Action executor)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionTarget.mockResolvedValue({ ok: true, sessionId: 'sess-factory' });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-generic',
      mode: 'plain',
      ctx: null,
    });
  });

  it('routes an API-token stream start through the credential-aware Action executor', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { streamId: 'stream-factory' } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'stream-start', 'sess-prefix', 'run-1', 'continue', '--resume', '--json'],
        { readCredentialsFn: async () => apiTokenCredentials },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledWith({ credentials: apiTokenCredentials });
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-prefix');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(startExecutionRunStream).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.stream.start',
        { sessionId: 'sess-factory', runId: 'run-1', message: 'continue', resume: true },
        { surface: 'cli', defaultSessionId: 'sess-factory' },
      );
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_stream_start',
        data: expect.objectContaining({ sessionId: 'sess-factory', runId: 'run-1', streamId: 'stream-factory' }),
      }));
    } finally {
      output.restore();
    }
  });

  it('routes an API-token stream read through the credential-aware Action executor', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { events: [], nextCursor: 1 } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'stream-read', 'sess-prefix', 'run-1', 'stream-1', '--cursor', '0', '--max-events', '2', '--json'],
        { readCredentialsFn: async () => apiTokenCredentials },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-prefix');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(readExecutionRunStream).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.stream.read',
        { sessionId: 'sess-factory', runId: 'run-1', streamId: 'stream-1', cursor: 0, maxEvents: 2 },
        { surface: 'cli', defaultSessionId: 'sess-factory' },
      );
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_stream_read',
        data: expect.objectContaining({ sessionId: 'sess-factory', runId: 'run-1', events: [], nextCursor: 1 }),
      }));
    } finally {
      output.restore();
    }
  });

  it('routes an API-token stream cancel through the credential-aware Action executor', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'stream-cancel', 'sess-prefix', 'run-1', 'stream-1', '--json'],
        { readCredentialsFn: async () => apiTokenCredentials },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-prefix');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(cancelExecutionRunStream).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.stream.cancel',
        { sessionId: 'sess-factory', runId: 'run-1', streamId: 'stream-1' },
        { surface: 'cli', defaultSessionId: 'sess-factory' },
      );
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_stream_cancel',
        data: { sessionId: 'sess-factory', runId: 'run-1', streamId: 'stream-1', cancelled: true },
      }));
    } finally {
      output.restore();
    }
  });

  it('keeps a credentialed stream start on the Action spec’s RPC surface', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { streamId: 'stream-factory' } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'stream-start', 'sess-prefix', 'run-1', 'continue', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-prefix');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(startExecutionRunStream).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.stream.start',
        { sessionId: 'sess-factory', runId: 'run-1', message: 'continue' },
        { surface: 'rpc', defaultSessionId: 'sess-factory' },
      );
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_run_stream_start' }));
    } finally {
      output.restore();
    }
  });
});
