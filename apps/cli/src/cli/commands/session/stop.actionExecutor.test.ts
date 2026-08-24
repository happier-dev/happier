import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));
const bootstrapAccountSettingsContext = vi.fn(async () => ({
  source: 'network' as const,
  settings: { schemaVersion: 6 },
  settingsVersion: 1,
  loadedAtMs: Date.now(),
  settingsSecretsReadKeys: [],
  whenRefreshed: null,
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

const { handleSessionCommand } = await import('./handleSessionCommand');

describe('happier session stop (action executor)', () => {
  it('uses the canonical selector wording when a session selector is missing', async () => {
    const readCredentialsFn = vi.fn(async () => null);

    await expect(handleSessionCommand(['stop'], { readCredentialsFn }))
      .rejects.toThrow(`Usage: ${SESSION_HELP_LINES.stop}`);

    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', stopped: true },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['stop', 'sess-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith('session.stop', { sessionId: 'sess-1' }, { surface: 'cli', defaultSessionId: null });

      const parsed = output.json();
      expect(parsed).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_stop',
        data: { sessionId: 'sess-1', stopped: true },
      }));
    } finally {
      output.restore();
    }
  });

  it('reports a proven physical stop without claiming the session is still active', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        stopped: false,
        stopOutcome: {
          status: 'stopped_projection_unconfirmed',
          reason: 'relay_inactive_not_observed',
        },
      },
    });

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await handleSessionCommand(['stop', 'sess-1'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.any(String),
        'session stopped; status update not yet observed',
      );
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.any(String),
        'stop requested but session is still active',
      );
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it.each([
    'terminal_control_serviceability_retirement_failed',
    'terminal_attachment_descriptor_retirement_failed',
  ] as const)('reports %s as a stopped session with incomplete cleanup', async (reason) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        stopped: false,
        stopOutcome: { status: 'stopped_cleanup_incomplete', reason },
      },
    });

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await handleSessionCommand(['stop', 'sess-1'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.any(String),
        'session stopped; local cleanup could not be completed',
      );
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.any(String),
        'stop could not be confirmed',
      );
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it.each([
    'terminal_control_serviceability_retirement_failed',
    'terminal_attachment_descriptor_retirement_failed',
  ] as const)('preserves %s in JSON output', async (reason) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        stopped: false,
        stopOutcome: { status: 'stopped_cleanup_incomplete', reason },
      },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['stop', 'sess-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_stop',
        data: {
          sessionId: 'sess-1',
          stopped: false,
          stopOutcome: { status: 'stopped_cleanup_incomplete', reason },
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('prints approval_request_created as the JSON envelope data', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['stop', 'sess-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_stop',
        data: { kind: 'approval_request_created', artifactId: 'approval-1' },
      }));
    } finally {
      output.restore();
    }
  });
});
