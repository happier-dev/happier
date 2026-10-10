import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput, captureStdout } from '@/testkit/logger/captureOutput';

const { execute, readStoredCredentials, resolveSessionTarget, startHappyHeadlessInTmux } = vi.hoisted(() => ({
  execute: vi.fn(),
  readStoredCredentials: vi.fn(),
  resolveSessionTarget: vi.fn(),
  startHappyHeadlessInTmux: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return { ...actual, readStoredCredentials };
});

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials: vi.fn(() => ({ execute, resolveSessionTarget })),
}));

vi.mock('@/integrations/tmux/startHeadlessSession', () => ({ startHappyHeadlessInTmux }));

import { dispatchCli } from './dispatch';
// Load the real lazy Action root (including its transfer graph) during collection,
// before cases observe command cancellation or input admission.
import '@/cli/commands/actions';

describe('dispatchCli compiled Action entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    readStoredCredentials.mockResolvedValue({ token: 'hap_v1_test' });
    resolveSessionTarget.mockResolvedValue({ ok: true, sessionId: 'session_exact' });
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('discovers contributed Action fields before invoking through the real actions entrypoint', async () => {
    execute.mockImplementation(async (actionId: string) => actionId === 'action.spec.get'
      ? {
          ok: true,
          result: {
            actionSpec: {
              kindVersion: 1,
              id: 'acme.notes/actions/create',
              title: 'Create note',
              description: null,
              safety: 'safe',
              placements: [],
              slash: null,
              bindings: null,
              examples: null,
              surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, api: true, plugin: true },
              inputHints: { title: 'Create note', fields: [{ path: 'title', title: 'Title', widget: 'text', required: true }] },
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { title: { type: 'string', minLength: 1 } },
                required: ['title'],
              },
            },
          },
        }
      : { ok: true, result: { created: true } });

    await dispatchCli({
      args: ['actions', 'invoke', 'acme.notes/actions/create', '--title', 'From CLI'],
      rawArgv: ['happier', 'actions', 'invoke', 'acme.notes/actions/create', '--title', 'From CLI'],
      terminalRuntime: null,
    });

    expect(execute).toHaveBeenNthCalledWith(
      1,
      'action.spec.get',
      { id: 'acme.notes/actions/create' },
      expect.objectContaining({ surface: 'cli' }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'action.invoke',
      { action: { pluginId: 'acme.notes', localId: 'create' }, input: { title: 'From CLI' } },
      expect.objectContaining({ surface: 'cli' }),
    );
  });

  it('resolves an execution-run Session once and dispatches its canonical Action', async () => {
    execute.mockResolvedValue({
      ok: true,
      result: { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' },
    });
    const output = captureConsoleJsonOutput();
    try {
      await dispatchCli({
        args: ['session', 'run', 'start', 'sess', '--intent', 'review', '--agent', 'agent:claude', '--json'],
        rawArgv: ['happier', 'session', 'run', 'start', 'sess', '--intent', 'review', '--agent', 'agent:claude', '--json'],
        terminalRuntime: null,
      });

      expect(resolveSessionTarget).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess');
      expect(execute).toHaveBeenCalledWith(
        'execution.run.start',
        expect.objectContaining({
          sessionId: 'session_exact',
          intent: 'review',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        }),
        expect.objectContaining({
          surface: 'cli',
          defaultSessionId: 'session_exact',
        }),
      );
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'session_run_start',
        data: { sessionId: 'session_exact', runId: 'run_1' },
      });
    } finally {
      output.restore();
    }
  });

  it.each(['--help', '--version', '--tmux', '--json'] as const)(
    'treats %s after the first standalone -- as the exact generated-Action positional',
    async (literal) => {
      execute.mockResolvedValue({
        ok: true,
        result: { sessionId: 'session_exact', localId: 'local_1', waited: false },
      });
      const stdout = captureStdout();
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const args = ['session', 'send', 'sess', '--', literal];
        await dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });

        expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledWith(
          'session.message.send',
          expect.objectContaining({ sessionId: 'session_exact', message: literal }),
          expect.objectContaining({ surface: 'cli' }),
        );
        expect(stdout.text()).toBe('');
        expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Message sent'));
      } finally {
        consoleLog.mockRestore();
        stdout.restore();
      }
    },
  );

  it.each(['idempotencyKey', 'source', 'attachments', 'kind', 'launch'] as const)(
    'rejects plugin-only send field %s from friendly whole-input JSON before credentials or execution',
    async (field) => {
      const args = ['session', 'send', '--input-json', JSON.stringify({
        sessionId: 'sess',
        message: 'Hello',
        [field]: field === 'attachments' ? [] : field === 'launch' ? {} : 'private',
      }), '--json'];
      const output = captureConsoleJsonOutput();
      try {
        await dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
        expect(readStoredCredentials).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      } finally {
        output.restore();
      }
    },
  );

  it('accepts recipient and localId in friendly whole-input JSON', async () => {
    execute.mockResolvedValue({ ok: true, result: { sessionId: 'session_exact', localId: 'local_public', waited: false } });
    const input = {
      sessionId: 'sess', message: 'Hello', localId: 'local_public',
      recipient: { kind: 'execution_run', runId: 'run_1' },
    };
    const args = ['session', 'send', '--input-json', JSON.stringify(input), '--json'];
    const output = captureConsoleJsonOutput();
    try {
      await dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
      expect(execute).toHaveBeenCalledWith('session.message.send', {
        ...input, sessionId: 'session_exact',
      }, expect.any(Object));
    } finally {
      output.restore();
    }
  });

  it('cancels one compiled mutation from SIGINT with the executor signal and durable local id intact', async () => {
    let executorSignal: AbortSignal | undefined;
    execute.mockImplementationOnce(async (_actionId: string, _input: unknown, context: { signal?: AbortSignal }) => {
      executorSignal = context.signal;
      await new Promise<void>((resolve) => context.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: false, errorCode: 'cancelled', error: 'The input was cancelled before admission.' };
    });
    const args = ['send', 'sess', 'Stop here', '--local-id', 'local_cancelled', '--json'];
    const output = captureConsoleJsonOutput();
    try {
      const command = dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(executorSignal).toBeDefined();

      process.emit('SIGINT');
      await command;

      expect(execute).toHaveBeenCalledOnce();
      expect(executorSignal?.aborted).toBe(true);
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_send',
        error: { code: 'cancelled', localId: 'local_cancelled' },
      });
    } finally {
      output.restore();
    }
  });

  it('passes one command-scoped SIGTERM signal to low-level invoke without replaying an outcome-unknown mutation', async () => {
    let executorSignal: AbortSignal | undefined;
    execute.mockImplementationOnce(async (_actionId: string, _input: unknown, context: { signal?: AbortSignal }) => {
      executorSignal = context.signal;
      await new Promise<void>((resolve) => context.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return {
        ok: false,
        errorCode: 'outcome_unknown',
        error: 'The transport ended after dispatch.',
        details: { requestId: 'request_unknown', localId: 'local_unknown' },
      };
    });
    const args = [
      'actions', 'invoke', 'session.message.send',
      '--session-id', 'sess', '--message', 'Maybe sent',
      '--local-id', 'local_unknown', '--request-id', 'request_unknown', '--json',
    ];
    const output = captureConsoleJsonOutput();
    try {
      const command = dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(executorSignal).toBeDefined();

      process.emit('SIGTERM');
      await command;

      expect(execute).toHaveBeenCalledOnce();
      expect(executorSignal?.aborted).toBe(true);
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'actions_invoke',
        error: {
          code: 'outcome_unknown',
          details: { requestId: 'request_unknown', localId: 'local_unknown' },
        },
      });
    } finally {
      output.restore();
    }
  });

  it('applies the same strict send whole-input schema to built-in actions invoke', async () => {
    const args = ['actions', 'invoke', 'session.message.send', '--input-json', JSON.stringify({
      sessionId: 'sess', message: 'Hello', source: 'private',
    }), '--json'];
    const output = captureConsoleJsonOutput();
    try {
      await dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
      expect(readStoredCredentials).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    } finally {
      output.restore();
    }
  });

  it('preserves an ambiguous Session as a typed JSON failure without invoking the Action', async () => {
    resolveSessionTarget.mockResolvedValue({
      ok: false,
      code: 'ambiguous_session',
      candidates: ['session_a', 'session_b'],
    });
    const output = captureConsoleJsonOutput();
    try {
      await dispatchCli({
        args: ['session', 'run', 'list', 'sess', '--json'],
        rawArgv: ['happier', 'session', 'run', 'list', 'sess', '--json'],
        terminalRuntime: null,
      });

      expect(execute).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_run_list',
        error: {
          code: 'ambiguous_session',
          candidates: ['session_a', 'session_b'],
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
    }
  });

  it.each([
    ['canonical nested path', ['session', 'list']],
    ['first-class path', ['list']],
    ['short alias', ['ls']],
  ] as const)('dispatches session.list through the real root entrypoint for the %s', async (_label, path) => {
    execute.mockResolvedValue({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const args = [...path, '--active', '--limit', '5', '--json'];
    const output = captureConsoleJsonOutput();
    try {
      await dispatchCli({
        args,
        rawArgv: ['happier', ...args],
        terminalRuntime: null,
      });

      expect(execute).toHaveBeenCalledWith(
        'session.list',
        { activeOnly: true, limit: 5 },
        expect.objectContaining({ surface: 'cli', defaultSessionId: null }),
      );
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'session_list',
        data: { sessions: [], nextCursor: null, hasNext: false },
      });
    } finally {
      output.restore();
    }
  });
});
