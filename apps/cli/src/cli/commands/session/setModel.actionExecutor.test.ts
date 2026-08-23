import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session set-model (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        status: 'intent_updated',
        sessionId: 'sess-1',
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'gpt-4o',
        },
        updatedAt: 123,
      },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['set-model', 'sess-1', 'gpt-4o', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.model.set',
        { sessionId: 'sess-1', modelId: 'gpt-4o' },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_set_model',
        data: {
          status: 'intent_updated',
          sessionId: 'sess-1',
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'gpt-4o',
          },
          modelId: 'gpt-4o',
          updatedAt: 123,
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('carries an exact Provider connection and an explicit native selection', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const credentials = {
      readCredentialsFn: async () => ({
        token: 'token_test',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
      }),
    };
    const success = {
      ok: true,
      result: { ok: true, status: 'applied', sessionId: 'sess-1' },
    };

    execute.mockResolvedValueOnce(success);
    let output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['set-model', 'sess-1', 'provider/model', '--provider-connection', 'pc_work', '--json'],
        credentials,
      );
    } finally {
      output.restore();
    }
    expect(execute).toHaveBeenLastCalledWith(
      'session.model.set',
      { sessionId: 'sess-1', modelId: 'provider/model', providerConnectionId: 'pc_work' },
      { surface: 'cli', defaultSessionId: null },
    );

    execute.mockResolvedValueOnce(success);
    output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['set-model', 'sess-1', 'sonnet', '--provider-connection', 'native', '--json'],
        credentials,
      );
    } finally {
      output.restore();
    }
    expect(execute).toHaveBeenLastCalledWith(
      'session.model.set',
      { sessionId: 'sess-1', modelId: 'sonnet', providerConnectionId: null },
      { surface: 'cli', defaultSessionId: null },
    );

    await expect(handleSessionCommand(
      ['set-model', 'sess-1', 'sonnet', '--provider-connection', ''],
      credentials,
    )).rejects.toThrow(/--provider-connection requires a Provider connection id or 'native'/u);
  });

  it('preserves active transition status and selection in JSON output', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        status: 'applied',
        sessionId: 'sess-1',
        activeSelection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'provider/model',
        },
      },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['set-model', 'sess-1', 'provider/model', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: {
              type: 'legacy',
              secret: new Uint8Array(32).fill(1),
            },
          }),
        },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_set_model',
        data: {
          status: 'applied',
          sessionId: 'sess-1',
          activeSelection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider/model',
          },
          modelId: 'provider/model',
          updatedAt: null,
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('preserves typed transition failure details in JSON output', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: false,
        errorCode: 'restart_required',
        error: 'restart_required',
        details: {
          status: 'restart_required',
          activeSelection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'old',
          },
          requestedSelection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_other',
            modelId: 'next',
          },
          reason: 'provider_source_change_requires_restart',
        },
      },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['set-model', 'sess-1', 'next', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'legacy',
            secret: new Uint8Array(32).fill(1),
          },
        }),
      });

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_set_model',
        error: {
          code: 'restart_required',
          details: {
            status: 'restart_required',
            activeSelection: { modelId: 'old' },
            requestedSelection: { modelId: 'next' },
            reason: 'provider_source_change_requires_restart',
          },
        },
      });
    } finally {
      output.restore();
    }
  });
});
