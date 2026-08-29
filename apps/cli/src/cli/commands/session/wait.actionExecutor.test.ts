import { describe, expect, it, vi } from 'vitest';
import { ok } from '@happier-dev/cli-common/output';

import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session wait (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', idle: true, observedAt: 123 },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['wait', 'sess-1', '--timeout', '42', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.wait.idle',
        { sessionId: 'sess-1', timeoutSeconds: 42 },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_wait',
        data: { sessionId: 'sess-1', idle: true, observedAt: 123 },
      }));
    } finally {
      output.restore();
    }
  });

  it('prints concise human success output without dumping the Action result', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', idle: true, observedAt: 123 },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleText();
    try {
      await handleSessionCommand(['wait', 'sess-1'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.text()).toBe(ok('Session idle'));
      expect(output.text()).not.toContain('"sessionId"');
      expect(output.text()).not.toContain('"observedAt"');
    } finally {
      output.restore();
    }
  });

  it('rejects an explicit invalid timeout before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionWait } = await import('./wait');

    await expect(cmdSessionWait(['wait', 'sess-1', '--timeout', '0'], { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it('uses the canonical selector wording when a session selector is missing', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionWait } = await import('./wait');

    await expect(cmdSessionWait(['wait'], { readCredentialsFn }))
      .rejects.toThrow(`Usage: ${SESSION_HELP_LINES.wait}`);

    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it.each([
    ['uses the default timeout when --timeout is omitted', ['wait', 'sess-1', '--json'], 300],
    ['clamps an explicit timeout to the supported maximum', ['wait', 'sess-1', '--timeout', '9999', '--json'], 3600],
  ])('%s', async (_label, argv, expectedTimeoutSeconds) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', idle: true, observedAt: 123 },
    });
    const { cmdSessionWait } = await import('./wait');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionWait(argv, {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.wait.idle',
        { sessionId: 'sess-1', timeoutSeconds: expectedTimeoutSeconds },
        { surface: 'cli', defaultSessionId: null },
      );
    } finally {
      output.restore();
    }
  });

  it('rejects a malformed successful Action result instead of reporting idle', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessionId: 'sess-1', idle: false, observedAt: 123 },
    });
    const { cmdSessionWait } = await import('./wait');

    await expect(cmdSessionWait(['wait', 'sess-1', '--json'], {
      readCredentialsFn: async () => ({
        token: 'token_test',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      }),
    })).rejects.toThrow();
  });
});
