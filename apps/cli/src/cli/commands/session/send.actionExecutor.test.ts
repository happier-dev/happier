import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@happier-dev/cli-common/output';

import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const resolveSessionTarget = vi.fn(async (idOrPrefix: string) => ({
  ok: true as const,
  sessionId: idOrPrefix,
}));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session send (action executor)', () => {
  beforeEach(() => {
    execute.mockReset();
    resolveSessionTarget.mockClear();
    createCliActionExecutorFromCredentials.mockClear();
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--permission-mode', 'read_only', '--model', 'gpt-4o', '--wait', '--timeout', '30', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.message.send',
        expect.objectContaining({
          sessionId: 'sess-1',
          message: 'Hello',
          permissionModeOverride: 'read-only',
          modelOverride: 'gpt-4o',
          wait: true,
          timeoutSeconds: 30,
        }),
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
      );

      const parsed = output.json();
      expect(parsed).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_send',
        data: { sessionId: 'sess-1', localId: 'local-1', waited: true },
      }));
    } finally {
      output.restore();
    }
  });

  it('prints concise human success output without dumping the Action result', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.text()).toBe(ok('Message sent (local id local-1)'));
      expect(output.text()).not.toContain('"sessionId"');
      expect(output.text()).not.toContain('"localId"');
    } finally {
      output.restore();
    }
  });

  it('accepts --message and preserves model and wait flags', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', '--model', 'gpt-x', '--message', 'Hello from a flag', '--wait', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.message.send',
        expect.objectContaining({
          sessionId: 'sess-1',
          message: 'Hello from a flag',
          modelOverride: 'gpt-x',
          wait: true,
        }),
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
      );
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_send',
        data: { sessionId: 'sess-1', localId: 'local-1', waited: true },
      }));
    } finally {
      output.restore();
    }
  });

  it('accepts --prompt as a message alias', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', '--prompt', 'Hello from prompt', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.message.send',
        expect.objectContaining({
          sessionId: 'sess-1',
          message: 'Hello from prompt',
        }),
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
      );
    } finally {
      output.restore();
    }
  });

  it('prints the strict admission result through the session send JSON presentation', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--wait', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_send',
        data: { sessionId: 'sess-1', localId: 'local-1', waited: true },
      }));
    } finally {
      output.restore();
    }
  });

  it('rejects a flag token where the positional message belongs', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', '--model', 'gpt-x', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_send',
        error: {
          code: 'invalid_arguments',
          message: 'message: Invalid input: expected string, received undefined',
        },
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('rejects ambiguous positional and --message inputs', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', 'positional text', '--message', 'flag text', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_send',
        error: {
          code: 'invalid_arguments',
          message: 'Provide message either with --message or with <message>, not both.',
        },
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('rejects a malformed timeout before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--timeout', '10oops', '--json'], { readCredentialsFn });

      expect(output.json()).toMatchObject({
        v: 1,
        ok: false,
        kind: 'session_send',
        error: { code: 'invalid_arguments' },
      });
      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it.each([
    ['uses the default timeout when --timeout is omitted', ['send', 'sess-1', 'Hello', '--json'], 300],
    ['passes an explicit timeout through; the canonical send input has no ceiling', ['send', 'sess-1', 'Hello', '--timeout', '9999', '--json'], 9999],
  ])('%s', async (_label, argv, expectedTimeoutSeconds) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-1' },
    });
    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(argv, {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.message.send',
        expect.objectContaining({ timeoutSeconds: expectedTimeoutSeconds }),
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
      );
    } finally {
      output.restore();
    }
  });

  it('prints approval_request_created as the JSON envelope data', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_send',
        data: { kind: 'approval_request_created', artifactId: 'approval-1' },
      }));
    } finally {
      output.restore();
    }
  });
  it('carries an exact Provider connection, an explicit native source, and a retained local id', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const credentials = {
      readCredentialsFn: async () => ({
        token: 'token_test',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
      }),
    };
    const success = {
      ok: true,
      result: { status: 'accepted', localId: 'local-42' },
    };

    execute.mockResolvedValueOnce(success);
    let output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['send', 'sess-1', 'Hello', '--model', 'provider/model', '--provider-connection', 'pc_work', '--local-id', 'local-42', '--json'],
        credentials,
      );
    } finally {
      output.restore();
    }
    expect(execute).toHaveBeenLastCalledWith(
      'session.message.send',
      expect.objectContaining({
        modelOverride: 'provider/model',
        providerConnectionId: 'pc_work',
        localId: 'local-42',
      }),
      expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
    );

    execute.mockResolvedValueOnce(success);
    output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['send', 'sess-1', 'Hello', '--model', 'sonnet', '--provider-connection', 'native', '--json'],
        credentials,
      );
    } finally {
      output.restore();
    }
    expect(execute).toHaveBeenLastCalledWith(
      'session.message.send',
      expect.objectContaining({ modelOverride: 'sonnet', providerConnectionId: null }),
      expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
    );

    // An exact connection is only meaningful with a concrete model id.
    execute.mockClear();
    let refusal = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--provider-connection', 'pc_work'], credentials);
    } finally {
      refusal.restore();
      process.exitCode = undefined;
    }
    expect(refusal.text()).toMatch(/--provider-connection requires --model/u);
    expect(execute).not.toHaveBeenCalled();

    // `native` is a source selection too: the Action refuses it without a
    // model override because there is no selection to apply it to. Refuse it
    // here with the same named reason instead of shipping an input the Action
    // rejects as an opaque `invalid_parameters`.
    execute.mockClear();
    refusal = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--provider-connection', 'native'], credentials);
    } finally {
      refusal.restore();
      process.exitCode = undefined;
    }
    expect(refusal.text()).toMatch(/--provider-connection requires --model/u);
    expect(execute).not.toHaveBeenCalled();

    // The reset sentinel IS a model override, so native plus `--model default`
    // stays accepted and still reaches the Action.
    execute.mockResolvedValueOnce(success);
    output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['send', 'sess-1', 'Hello', '--model', 'default', '--provider-connection', 'native', '--json'],
        credentials,
      );
    } finally {
      output.restore();
    }
    expect(execute).toHaveBeenLastCalledWith(
      'session.message.send',
      expect.objectContaining({ modelOverride: null, providerConnectionId: null }),
      expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
    );
  });

  it('prints the durable local id so a human retry can rejoin the same input', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'accepted', localId: 'local-42' },
    });
    const { handleSessionCommand } = await import('./handleSessionCommand');

    const text = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
    } finally {
      text.restore();
    }

    expect(text.text()).toContain('local-42');
  });

  it('names the durable retry identity when a send fails ambiguously', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const credentials = {
      readCredentialsFn: async () => ({
        token: 'token_test',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
      }),
    };
    const ambiguous = {
      ok: true,
      result: {
        ok: false,
        code: 'timeout',
        message: 'Could not confirm whether the exact pending Session input remains in custody',
      },
    };

    // Human path: the id the send actually used must be nameable, or the only
    // safe retry is unavailable to a caller who did not pre-supply one.
    execute.mockResolvedValueOnce(ambiguous);
    const guidance = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello'], credentials);
    } finally {
      guidance.restore();
      process.exitCode = undefined;
    }
    const humanInput = execute.mock.calls.at(-1)?.[1] as { localId?: unknown };
    expect(typeof humanInput.localId).toBe('string');
    expect(guidance.text()).toContain(`--local-id ${String(humanInput.localId)}`);

    // JSON path: the same identity is machine-readable on the failure envelope.
    execute.mockReset();
    execute.mockResolvedValueOnce(ambiguous);
    const output = captureConsoleJsonOutput();
    let parsed: unknown;
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--json'], credentials);
      parsed = output.json();
    } finally {
      output.restore();
    }
    const jsonInput = execute.mock.calls.at(-1)?.[1] as { localId?: unknown };
    expect(parsed).toEqual(expect.objectContaining({
      ok: false,
      kind: 'session_send',
      error: expect.objectContaining({ code: 'timeout', localId: jsonInput.localId }),
    }));
  });

});

describe('happier session send truthfulness over the canonical admission status', () => {
  const credentials = {
    readCredentialsFn: async () => ({
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    }),
  };

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('retains the resume refusal cause in public error details', async () => {
    const errorDetail = { kind: 'connected_service_resume_unreachable', continuityErrorCode: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity', agentId: 'gemini', reason: 'gemini_resume_unreachable', uxDiagnostic: { code: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity', source: 'spawn_resume', agentId: 'gemini', retryable: false, suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account', 'open_connected_accounts'], diagnostics: { reason: 'gemini_resume_unreachable' } } };
    execute.mockResolvedValueOnce({ ok: true, result: { status: 'failed', localId: 'local-9', code: 'resume_failed', errorDetail } });
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--json'], credentials);
      expect(output.json()).toMatchObject({ ok: false, error: { details: { status: 'failed', localId: 'local-9', errorDetail } } });
    } finally { output.restore(); }
  });

  it.each([
    {
      status: 'rejected',
      result: { status: 'rejected', code: 'session_input_target_unavailable' },
      code: 'session_input_target_unavailable',
    },
    {
      status: 'failed',
      result: { status: 'failed', localId: 'local-9', code: 'session_input_turn_failed' },
      code: 'session_input_turn_failed',
    },
    {
      status: 'cancelled',
      result: { status: 'cancelled', localId: 'local-9', code: 'session_input_turn_cancelled' },
      code: 'session_input_turn_cancelled',
    },
  ])('reports a $status send as a typed failure instead of "Message sent"', async ({ result, code }) => {
    const { handleSessionCommand } = await import('./handleSessionCommand');

    // Human path: the Action succeeded, the operation did not. Retrying with
    // the same local id cannot help here, so no retry hint may be printed.
    execute.mockResolvedValueOnce({ ok: true, result });
    const text = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--local-id', 'local-9'], credentials);
    } finally {
      text.restore();
    }
    expect(text.text()).not.toContain('Message sent');
    expect(text.text()).toContain(code);
    expect(text.text()).not.toContain('--local-id');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    // JSON path: the envelope is a failure carrying the admission code.
    execute.mockResolvedValueOnce({ ok: true, result });
    const output = captureConsoleJsonOutput();
    let parsed: unknown;
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--local-id', 'local-9', '--json'], credentials);
      parsed = output.json();
    } finally {
      output.restore();
    }
    expect(parsed).toEqual(expect.objectContaining({
      ok: false,
      kind: 'session_send',
      error: expect.objectContaining({ code, localId: 'local-9' }),
    }));
    expect(process.exitCode).toBe(1);
  });

  it('reports an unknown admission outcome explicitly and names the exact retry identity', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const result = { status: 'outcomeUnknown', localId: 'local-7', code: 'timeout' };

    execute.mockResolvedValueOnce({ ok: true, result });
    const text = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--local-id', 'local-7'], credentials);
    } finally {
      text.restore();
    }
    expect(text.text()).not.toContain('Message sent');
    expect(text.text()).toContain('--local-id local-7');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    execute.mockResolvedValueOnce({ ok: true, result });
    const output = captureConsoleJsonOutput();
    let parsed: unknown;
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--local-id', 'local-7', '--json'], credentials);
      parsed = output.json();
    } finally {
      output.restore();
    }
    expect(parsed).toEqual(expect.objectContaining({
      ok: false,
      kind: 'session_send',
      error: expect.objectContaining({ code: 'timeout', localId: 'local-7' }),
    }));
    expect(process.exitCode).toBe(1);
  });

  it('keeps alreadyAccepted as a delivered send', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    execute.mockResolvedValueOnce({ ok: true, result: { status: 'alreadyAccepted', localId: 'local-1' } });
    const text = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello'], credentials);
    } finally {
      text.restore();
    }
    expect(text.text()).toContain('Message sent');
    expect(process.exitCode).toBeUndefined();
  });

  it('derives the session run send `sent` field from the admission status', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');

    execute.mockResolvedValueOnce({ ok: true, result: { status: 'accepted', localId: 'local-1' } });
    let output = captureConsoleJsonOutput();
    let parsed: unknown;
    try {
      await handleSessionCommand(['run', 'send', 'sess-1', 'run-1', 'hello', '--json'], credentials);
      parsed = output.json();
    } finally {
      output.restore();
    }
    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      kind: 'session_run_send',
      data: { sessionId: 'sess-1', runId: 'run-1', sent: true },
    }));

    execute.mockResolvedValueOnce({ ok: true, result: { status: 'rejected', code: 'session_input_target_unavailable' } });
    output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['run', 'send', 'sess-1', 'run-1', 'hello', '--json'], credentials);
      parsed = output.json();
    } finally {
      output.restore();
    }
    expect(parsed).toEqual(expect.objectContaining({
      ok: false,
      kind: 'session_run_send',
      error: expect.objectContaining({ code: 'session_input_target_unavailable', sent: false }),
    }));
    expect(process.exitCode).toBe(1);
  });
});

describe('happier session send --run (targeted execution-run convergence)', () => {
  const credentials = {
    readCredentialsFn: async () => ({
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    }),
  };
  const success = {
    ok: true,
    result: { status: 'accepted', localId: 'local-1' },
  };

  beforeEach(() => {
    execute.mockReset();
    resolveSessionTarget.mockClear();
    createCliActionExecutorFromCredentials.mockClear();
  });

  async function canonicalInputFor(argv: readonly string[]): Promise<Record<string, unknown>> {
    execute.mockResolvedValueOnce(success);
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([...argv, '--json'], credentials);
    } finally {
      output.restore();
    }
    const call = execute.mock.calls.at(-1);
    expect(call?.[0]).toBe('session.message.send');
    return call?.[1] as Record<string, unknown>;
  }

  it('omits the recipient entirely when no run is named', async () => {
    const input = await canonicalInputFor(['send', 'sess-1', 'Hello']);
    expect(input).not.toHaveProperty('recipient');
  });

  it('binds --run to the strict execution_run recipient', async () => {
    const input = await canonicalInputFor(['send', 'sess-1', 'Hello', '--run', 'run-9']);
    expect(input.recipient).toEqual({ kind: 'execution_run', runId: 'run-9' });
    expect(input.sessionId).toBe('sess-1');
    expect(input.message).toBe('Hello');
  });

  it('produces one canonical Action input for the root, nested and compatibility spellings', async () => {
    const root = await canonicalInputFor(['send', 'sess-1', 'Hello', '--run', 'run-9', '--local-id', 'lid-1']);
    const nested = await canonicalInputFor(['send', 'sess-1', 'Hello', '--run', 'run-9', '--local-id', 'lid-1']);
    const compatibility = await canonicalInputFor(['run', 'send', 'sess-1', 'run-9', 'Hello', '--local-id', 'lid-1']);
    expect(nested).toEqual(root);
    expect(compatibility).toEqual(root);
  });

  it('never strips the recipient or retries as a main-Session send when admission refuses the target', async () => {
    execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'session_input_target_update_required',
      error: 'The exact machine cannot accept a targeted input.',
    });
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    let parsed: unknown;
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--run', 'run-9', '--json'], credentials);
      parsed = output.json();
    } finally {
      output.restore();
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(parsed).toEqual(expect.objectContaining({
      ok: false,
      kind: 'session_send',
      error: expect.objectContaining({ code: 'session_input_target_update_required' }),
    }));
  });

  it('waits on the exact targeted turn through the canonical Action, with no CLI-side polling', async () => {
    const input = await canonicalInputFor(['send', 'sess-1', 'Hello', '--run', 'run-9', '--wait', '--timeout', '45']);
    expect(input).toMatchObject({
      recipient: { kind: 'execution_run', runId: 'run-9' }, wait: true, timeoutSeconds: 45,
    });
    // One canonical invocation settles the wait; the CLI never reads run state.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe('session.message.send');
  });

  it('rejects --run without a value before any executor is constructed', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const refusal = captureConsoleText();
    try {
      await handleSessionCommand(['send', 'sess-1', 'Hello', '--run'], credentials);
    } finally {
      refusal.restore();
      process.exitCode = undefined;
    }
    expect(refusal.text()).toMatch(/Option --run requires a value/u);
    expect(createCliActionExecutorFromCredentials).not.toHaveBeenCalled();
  });

  it('preserves the exact message bytes a shell supplied alongside --run', async () => {
    const literal = '  leading and trailing \n$(touch /tmp/sentinel); rm -rf & | < > "quotes" \\ 🙂 中文  ';
    const input = await canonicalInputFor(['send', 'sess-1', literal, '--run', 'run-9']);
    expect(input.message).toBe(literal);
  });
});
