import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

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
          message: 'Usage: happier session send <session-id-or-prefix> <message|--message <text>|--prompt <text>> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]',
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
});
