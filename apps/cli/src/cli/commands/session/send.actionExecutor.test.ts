import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@happier-dev/cli-common/output';

import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session send (action executor)', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutorFromCredentials.mockClear();
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
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
        { surface: 'cli', defaultSessionId: null },
      );

      const parsed = output.json();
      expect(parsed).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_send',
        data: { sessionId: 'sess-1', localId: 'local-1', waited: false },
      }));
    } finally {
      output.restore();
    }
  });

  it('prints concise human success output without dumping the Action result', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
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
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: true },
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
        { surface: 'cli', defaultSessionId: null },
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
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
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
        { surface: 'cli', defaultSessionId: null },
      );
    } finally {
      output.restore();
    }
  });

  it('unwraps nested success action payloads before printing the JSON envelope', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        data: { sessionId: 'sess-1', localId: 'local-1', waited: true },
      },
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
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
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
          message: `Usage: ${SESSION_HELP_LINES.send}`,
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
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
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
          message: 'Provide the message either positionally or with --message/--prompt, not both.',
        },
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('rejects a malformed timeout before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionSend } = await import('./send');

    await expect(cmdSessionSend(['send', 'sess-1', 'Hello', '--timeout', '10oops'], { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it.each([
    ['uses the default timeout when --timeout is omitted', ['send', 'sess-1', 'Hello', '--json'], 300],
    ['clamps an explicit timeout to the supported maximum', ['send', 'sess-1', 'Hello', '--timeout', '9999', '--json'], 3600],
  ])('%s', async (_label, argv, expectedTimeoutSeconds) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
    });
    const { cmdSessionSend } = await import('./send');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionSend(argv, {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.message.send',
        expect.objectContaining({ timeoutSeconds: expectedTimeoutSeconds }),
        { surface: 'cli', defaultSessionId: null },
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
      result: { ok: true, sessionId: 'sess-1', localId: 'local-42', waited: false },
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
      { surface: 'cli', defaultSessionId: null },
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
      { surface: 'cli', defaultSessionId: null },
    );

    // An exact connection is only meaningful with a concrete model id.
    await expect(handleSessionCommand(
      ['send', 'sess-1', 'Hello', '--provider-connection', 'pc_work'],
      credentials,
    )).rejects.toThrow(/--provider-connection requires --model/u);

    // `native` is a source selection too: the Action refuses it without a
    // model override because there is no selection to apply it to. Refuse it
    // here with the same named reason instead of shipping an input the Action
    // rejects as an opaque `invalid_parameters`.
    execute.mockClear();
    await expect(handleSessionCommand(
      ['send', 'sess-1', 'Hello', '--provider-connection', 'native'],
      credentials,
    )).rejects.toThrow(/--provider-connection requires --model/u);
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
      { surface: 'cli', defaultSessionId: null },
    );
  });

  it('prints the durable local id so a human retry can rejoin the same input', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', localId: 'local-42', waited: false },
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
    const thrown = await handleSessionCommand(['send', 'sess-1', 'Hello'], credentials)
      .then(() => null, (error: unknown) => error);
    const humanInput = execute.mock.calls.at(-1)?.[1] as { localId?: unknown };
    expect(typeof humanInput.localId).toBe('string');
    expect(String((thrown as Error | null)?.message))
      .toContain(`--local-id ${String(humanInput.localId)}`);

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
