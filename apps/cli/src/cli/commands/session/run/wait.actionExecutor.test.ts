import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { findCompiledActionCliCommand } from '@/cli/actions/compiledCommands';
import { EXECUTION_RUN_WAIT_PRESENTATION } from './executionRunPresentation';

const execute = vi.fn();
const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-canonical' }));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));
const resolveSessionTransportContext = vi.fn(async () => ({ ok: true, sessionId: 'sess-canonical' }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({ resolveSessionTransportContext }));

// Strict public run state as produced by the canonical execution-run get owner:
// the completed wait result validates `result` against ExecutionRunGetResponseSchema,
// so presentation fixtures must exercise the real public schema, not a stub.
const succeededRunState = {
  runId: 'run-1',
  callId: 'call-1',
  sidechainId: 'call-1',
  intent: 'review',
  backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
  permissionMode: 'read_only',
  retentionPolicy: 'ephemeral',
  runClass: 'bounded',
  ioMode: 'request_response',
  status: 'succeeded',
  startedAtMs: 1,
} as const;

const succeededExecuteResult = {
  ok: true,
  result: {
    ok: true,
    status: 'succeeded',
    result: { run: succeededRunState },
  },
} as const;

const observationTimeoutExecuteResult = {
  ok: true,
  result: {
    ok: true,
    status: 'running',
    disposition: 'observation_timeout',
    runId: 'run-1',
    timeoutMs: 1_000,
    observedAtMs: 1_050,
    deadlineAtMs: 1_000,
  },
} as const;

describe('execution run wait result presentation', () => {
  const runningRun = { ...succeededRunState, status: 'running' } as const;
  const observedCases = [
    {
      name: 'permission attention',
      condition: 'needs_attention',
      payload: {
        ok: true, status: 'running', disposition: 'needs_attention',
        result: { run: { ...runningRun, attention: { kind: 'permission_required', requestIds: ['permission-1'] } } },
      },
      facts: ['permission_required', 'permission-1'],
    },
    {
      name: 'running snapshot',
      condition: 'change',
      payload: { ok: true, status: 'running', disposition: 'snapshot', result: { run: runningRun } },
      facts: ['running'],
    },
    {
      name: 'terminal snapshot',
      condition: 'change',
      payload: { ok: true, status: 'succeeded', disposition: 'snapshot', result: { run: succeededRunState } },
      facts: ['succeeded'],
    },
  ] as const;

  async function present(payload: unknown, json: boolean, condition: 'needs_attention' | 'change') {
    const command = findCompiledActionCliCommand(['session', 'run', 'wait']);
    if (!command || !EXECUTION_RUN_WAIT_PRESENTATION.presentSuccess) throw new Error('The friendly wait presenter must exist');
    const input = { sessionId: 'sess-canonical', runId: 'run-1', condition };
    command.callerSchema.parse(input);
    command.spec.inputSchema.parse(input);
    await EXECUTION_RUN_WAIT_PRESENTATION.presentSuccess(payload, {
      command, json, input, callerInput: input,
    });
  }

  it.each(observedCases)('preserves $name facts without claiming timeout or completion', async ({ payload, facts, condition }) => {
    const jsonOutput = captureConsoleJsonOutput();
    try {
      await present(payload, true, condition);
      expect(jsonOutput.json()).toEqual({
        v: 1, ok: true, kind: 'session_run_wait',
        data: { sessionId: 'sess-canonical', runId: 'run-1', status: payload.status,
          disposition: payload.disposition, result: payload.result },
      });
    } finally { jsonOutput.restore(); }

    const humanOutput = captureConsoleJsonOutput();
    try {
      await present(payload, false, condition);
      const text = humanOutput.logs.join('\n');
      expect(text).toContain('run-1');
      for (const fact of facts) expect(text).toContain(fact);
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('observation ended');
      expect(text).not.toContain('run finished');
    } finally { humanOutput.restore(); }
  });

  it('preserves an unmet-condition timeout with a terminal observed state without claiming completion', async () => {
    const payload = { ...observationTimeoutExecuteResult.result, status: 'succeeded', result: { run: succeededRunState } } as const;
    const jsonOutput = captureConsoleJsonOutput();
    try {
      await present(payload, true, 'needs_attention');
      expect(jsonOutput.json()).toEqual({
        v: 1, ok: true, kind: 'session_run_wait',
        data: {
          sessionId: 'sess-canonical', runId: 'run-1', status: 'succeeded', disposition: 'observation_timeout',
          timeoutMs: 1_000, observedAtMs: 1_050, deadlineAtMs: 1_000, result: payload.result,
        },
      });
    } finally { jsonOutput.restore(); }

    const humanOutput = captureConsoleJsonOutput();
    try {
      await present(payload, false, 'needs_attention');
      const text = humanOutput.logs.join('\n');
      expect(text).toContain('observation ended');
      expect(text).toContain('1000ms');
      expect(text).toContain('run-1');
      expect(text).toContain('succeeded');
      expect(text).not.toContain('still running');
      expect(text).not.toContain('run finished');
    } finally { humanOutput.restore(); }
  });
});

describe('happier session run wait (action executor)', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutorFromCredentials.mockClear();
    resolveSessionTarget.mockClear();
    resolveSessionTransportContext.mockClear();
  });

  it('does not add a default timeout when --timeout is omitted', async () => {
    execute.mockResolvedValueOnce(succeededExecuteResult);

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'wait', 'sess-1', 'run-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledWith(
        'execution.run.wait',
        { sessionId: 'sess-canonical', runId: 'run-1' },
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-canonical' }),
      );
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce(succeededExecuteResult);

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'wait', 'sess-1', 'run-1', '--timeout', '42', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.wait',
        { sessionId: 'sess-canonical', runId: 'run-1', timeoutSeconds: 42 },
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-canonical' }),
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_wait',
        data: { sessionId: 'sess-canonical', runId: 'run-1', status: 'succeeded' },
      }));
    } finally {
      output.restore();
    }
  });

  it('rejects an explicit invalid timeout before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'wait', 'sess-prefix', 'run-1', '--timeout', '0', '--json'], { readCredentialsFn });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('does not resolve an API-token Session through the generic transport', async () => {
    execute.mockResolvedValueOnce(succeededExecuteResult);
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'wait', 'sess-1', 'run-1', '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_run_wait' }));
    } finally {
      output.restore();
    }
  });

  it('reports an observation timeout without claiming the run finished', async () => {
    execute.mockResolvedValueOnce(observationTimeoutExecuteResult);

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'wait', 'sess-1', 'run-1', '--timeout', '1'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledWith(
        'execution.run.wait',
        { sessionId: 'sess-canonical', runId: 'run-1', timeoutSeconds: 1 },
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-canonical' }),
      );
      const text = output.logs.join('\n');
      expect(text).not.toContain('run finished');
      expect(text).toContain('observation ended');
      expect(text).toContain('still running');
    } finally {
      output.restore();
    }
  });

  it('preserves observation-timeout facts in the JSON envelope', async () => {
    execute.mockResolvedValueOnce(observationTimeoutExecuteResult);

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'wait', 'sess-1', 'run-1', '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual({
        v: 1,
        ok: true,
        kind: 'session_run_wait',
        data: {
          sessionId: 'sess-canonical',
          runId: 'run-1',
          status: 'running',
          disposition: 'observation_timeout',
          timeoutMs: 1_000,
          observedAtMs: 1_050,
          deadlineAtMs: 1_000,
        },
      });
    } finally {
      output.restore();
    }
  });

  it('preserves the canonical cancelled disposition as a stable failure envelope', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { ok: false, code: 'cancelled' } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'wait', 'sess-1', 'run-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledWith(
        'execution.run.wait',
        { sessionId: 'sess-canonical', runId: 'run-1' },
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-canonical' }),
      );
      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_run_wait',
        error: { code: 'cancelled' },
      });
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });
});
