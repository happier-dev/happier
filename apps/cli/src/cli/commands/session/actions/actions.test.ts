import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_ACTION_IDS_V1 } from '@happier-dev/protocol/actions';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { handleSessionCommand } from '../handleSessionCommand';

const {
  bootstrapAccountSettingsContext,
  createCliActionExecutor,
  execute,
  resolveSessionTransportContext,
} = vi.hoisted(() => {
  const resolveSessionTransportContext = vi.fn();
  const execute = vi.fn();
  const createCliActionExecutor = vi.fn(() => ({ execute }));
  const bootstrapAccountSettingsContext = vi.fn(async () => ({
    source: 'network' as const,
    settings: { schemaVersion: 6 },
    settingsVersion: 1,
    loadedAtMs: Date.now(),
    settingsSecretsReadKeys: [],
    whenRefreshed: null,
  }));
  return {
    bootstrapAccountSettingsContext,
    createCliActionExecutor,
    execute,
    resolveSessionTransportContext,
  };
});

function mockBootstrapWithCliDisabledReviewStart(): void {
  bootstrapAccountSettingsContext.mockImplementationOnce(async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': {
          disabledSurfaces: ['cli'],
        },
      },
    });
    return {
      source: 'network' as const,
      settings: {
        schemaVersion: 6,
        actionsSettingsV1: {
          v: 1,
          actions: {
            'review.start': {
              disabledSurfaces: ['cli'],
            },
          },
        },
      },
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
  });
}

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

describe('happier session actions (unit)', () => {
  beforeEach(() => {
    resolveSessionTransportContext.mockReset();
    execute.mockReset();
    createCliActionExecutor.mockClear();
    bootstrapAccountSettingsContext.mockClear();
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('prints a JSON envelope for actions execute', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: {},
      },
      ctx: null,
      mode: 'plain' as const,
    });
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'execute', 'sess-1', 'review.start', '--input-json', '{"instructions":"Review."}', '--action-request-id', 'attempt-1', '--resume-action-request', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_execute');
      expect(parsed.data).toEqual({
        sessionId: 'sess-1',
        actionId: 'review.start',
        result: { started: true },
      });
      expect(execute).toHaveBeenCalledWith(
        'review.start',
        { instructions: 'Review.', sessionId: 'sess-1' },
        {
          defaultSessionId: 'sess-1',
          surface: 'cli',
          actionRequestId: 'attempt-1',
          resumeActionRequest: true,
        },
      );
    } finally {
      output.restore();
    }
  });

  it('uses the Protocol request-id grammar for Session Action correlation ids', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1', metadata: {} },
      ctx: null,
      mode: 'plain' as const,
    });
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([
        'actions',
        'execute',
        'sess-1',
        'review.start',
        '--input-json',
        '{"instructions":"Review."}',
        '--action-request-id',
        'corrélation-☃',
        '--json',
      ], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledWith(
        'review.start',
        { instructions: 'Review.', sessionId: 'sess-1' },
        expect.objectContaining({ actionRequestId: 'corrélation-☃' }),
      );
      expect(output.json()).toMatchObject({ ok: true });
    } finally {
      output.restore();
    }
  });

  it('rejects a Session Action request id beyond the Protocol-owned limit before transport resolution', async () => {
    await expect(handleSessionCommand([
      'actions',
      'execute',
      'sess-1',
      'review.start',
      '--action-request-id',
      'x'.repeat(129),
    ], {
      readCredentialsFn: vi.fn(),
    })).rejects.toThrow('Invalid --action-request-id.');

    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('lifts nested action failures into a JSON error envelope for actions execute', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: {},
      },
      ctx: null,
      mode: 'plain' as const,
    });
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: false,
        errorCode: 'session_not_found',
        error: 'Session not found',
        candidates: ['sess-2'],
      },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'execute', 'sess-1', 'session.status.get', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const parsed = output.json();
      expect(parsed).toEqual({
        v: 1,
        ok: false,
        kind: 'session_actions_execute',
        error: {
          code: 'session_not_found',
          message: 'Session not found',
          candidates: ['sess-2'],
        },
      });
    } finally {
      output.restore();
    }
  });

  it('unwraps nested success action payloads before printing the JSON envelope for actions execute', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: {},
      },
      ctx: null,
      mode: 'plain' as const,
    });
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        data: {
          started: true,
          runId: 'run-1',
        },
      },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'execute', 'sess-1', 'review.start', '--input-json', '{"instructions":"Review."}', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      expect(output.json()).toEqual({
        v: 1,
        ok: true,
        kind: 'session_actions_execute',
        data: {
          sessionId: 'sess-1',
          actionId: 'review.start',
          result: {
            started: true,
            runId: 'run-1',
          },
        },
      });
    } finally {
      output.restore();
    }
  });

  it('uses the resolved positional session id for action input sessionId', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: {},
      },
      ctx: null,
      mode: 'plain' as const,
    });
    execute.mockResolvedValueOnce({ ok: true, result: { ok: true } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([
        'actions',
        'execute',
        'sess-1',
        'session.terminalComposer.clear',
        '--input-json',
        '{"sessionId":"other-session","expectedStateAtMs":42}',
        '--json',
      ], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_execute');
      expect(execute).toHaveBeenCalledWith(
        'session.terminalComposer.clear',
        { sessionId: 'sess-1', expectedStateAtMs: 42 },
        { defaultSessionId: 'sess-1', surface: 'cli' },
      );
    } finally {
      output.restore();
    }
  });

  it('does not inject the resolved positional session id into non-session-targeted action input', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: {},
      },
      ctx: null,
      mode: 'plain' as const,
    });
    execute.mockResolvedValueOnce({ ok: true, result: { sessions: [] } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([
        'actions',
        'execute',
        'sess-1',
        'session.list',
        '--input-json',
        '{"limit":10}',
        '--json',
      ], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_execute');
      expect(execute).toHaveBeenCalledWith(
        'session.list',
        { limit: 10 },
        { defaultSessionId: 'sess-1', surface: 'cli' },
      );
    } finally {
      output.restore();
    }
  });

  it('loads account action settings before executing actions for authenticated users', async () => {
    mockBootstrapWithCliDisabledReviewStart();
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: {},
      },
      ctx: null,
      mode: 'plain' as const,
    });
    createCliActionExecutor.mockImplementationOnce(() => {
      expect(process.env.HAPPIER_ACTIONS_SETTINGS_V1).toContain('review.start');
      return { execute };
    });
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'execute', 'sess-1', 'review.start', '--input-json', '{"instructions":"Review."}', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_execute');
      expect(bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
        credentials: expect.objectContaining({ token: 'token_test' }),
        mode: 'fast',
      }));
    } finally {
      output.restore();
    }
  });

  it('prints a JSON envelope for actions list', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'list', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_list');
      expect(Array.isArray(parsed.data?.actionSpecs)).toBe(true);
      expect(parsed.data.actionSpecs.length).toBeGreaterThan(0);
      const listedIds = new Set(parsed.data.actionSpecs.map((spec: { id: string }) => spec.id));
      for (const runtimeActionId of RUNTIME_ACTION_IDS_V1) {
        expect(listedIds.has(runtimeActionId)).toBe(false);
      }
    } finally {
      output.restore();
    }
  });

  it('loads account action settings before listing actions for authenticated users', async () => {
    mockBootstrapWithCliDisabledReviewStart();
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'list', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_list');
      expect(parsed.data.actionSpecs.some((spec: { id: string }) => spec.id === 'review.start')).toBe(false);
      expect(bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
        credentials: expect.objectContaining({ token: 'token_test' }),
        mode: 'fast',
      }));
    } finally {
      output.restore();
    }
  });

  it('prints a JSON envelope for actions describe', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'describe', 'review.start', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_describe');
      expect(parsed.data?.actionSpec?.id).toBe('review.start');
      expect(parsed.data?.actionSpec?.surfaces).toBeTruthy();
    } finally {
      output.restore();
    }
  });

  it('returns a JSON error envelope when actions describe targets a fail-closed runtime action', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'describe', 'browser.navigate', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_actions_describe');
      expect(parsed.error?.code).toBe('unsupported');
    } finally {
      output.restore();
    }
  });

  it('filters disabled actions from actions list on the cli surface', async () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': {
          disabledSurfaces: ['cli'],
        },
      },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'list', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_list');
      expect(parsed.data.actionSpecs.some((spec: { id: string }) => spec.id === 'review.start')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previous;
      output.restore();
    }
  });

  it('returns a JSON error envelope when actions describe targets a cli-disabled action', async () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': {
          disabledSurfaces: ['cli'],
        },
      },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'describe', 'review.start', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_actions_describe');
      expect(parsed.error?.code).toBe('unsupported');
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previous;
      output.restore();
    }
  });
});
