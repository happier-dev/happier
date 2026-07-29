import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';
import { handleSessionCommand } from './handleSessionCommand';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

beforeEach(() => {
  execute.mockReset();
  createCliActionExecutorFromCredentials.mockClear();
});

describe('happier session create (action executor)', () => {
  it('prints usage and does not execute any action when --help is requested', async () => {
      const output = captureConsoleText();
    try {
      await handleSessionCommand(['create', '--help'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).not.toHaveBeenCalled();
      expect(output.text()).toContain(SESSION_HELP_LINES.create);
    } finally {
      output.restore();
    }
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-1',
        created: true,
        session: { id: 'sess-1' },
      },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--backend', 'agent:claude', '--title', 'My title', '--tag', 'tag-1', '--prompt', 'Hello', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.spawn_new',
        {
          path: '/tmp',
          backendTargetKey: 'agent:claude',
          agentId: 'claude',
          title: 'My title',
          tag: 'tag-1',
          initialMessage: 'Hello',
        },
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_create',
        data: expect.objectContaining({
          created: true,
          session: { id: 'sess-1' },
        }),
      }));
    } finally {
      output.restore();
    }
  });

  it('accepts --backend as an agent id alias and forwards a normalized backendTargetKey', async () => {
    execute.mockClear();
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-2',
        created: true,
        session: { id: 'sess-2' },
      },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--backend', 'claude', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenLastCalledWith(
        'session.spawn_new',
        expect.objectContaining({
          path: '/tmp',
          backendTargetKey: 'agent:claude',
        }),
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
    } finally {
      output.restore();
    }
  });

  it('accepts --agent as a single-target alias and forwards a normalized backendTargetKey', async () => {
    execute.mockClear();
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-3',
        created: true,
        session: { id: 'sess-3' },
      },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--agent', 'codex', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenLastCalledWith(
        'session.spawn_new',
        expect.objectContaining({
          path: '/tmp',
          backendTargetKey: 'agent:codex',
        }),
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
    } finally {
      output.restore();
    }
  });

  it('resolves concise auth through the canonical spawn inventory', async () => {
    execute.mockClear();
    execute
      .mockResolvedValueOnce({
        ok: true,
        result: {
          supportedServiceIds: ['openai-codex'],
          profileOptionsByServiceId: { 'openai-codex': [] },
          groupOptionsByServiceId: { 'openai-codex': [{ groupId: 'team' }] },
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          type: 'success',
          sessionId: 'sess-auth',
          created: true,
          session: { id: 'sess-auth' },
        },
      });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--backend', 'codex', '--auth', 'cs:team', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(execute).toHaveBeenNthCalledWith(
        1,
        'sessions.spawn.connected_services.list',
        { agentId: 'codex', includeUnavailable: false },
        { surface: 'cli', defaultSessionId: null },
      );
      expect(execute).toHaveBeenNthCalledWith(
        2,
        'session.spawn_new',
        expect.objectContaining({
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
              openai: { source: 'native' },
            },
          },
        }),
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
    } finally {
      output.restore();
    }
  });

  it('leaves backend target resolution to the action executor when --backend is omitted', async () => {
    execute.mockClear();
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-3',
        created: true,
        session: { id: 'sess-3' },
      },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--title', 'My title', '--tag', 'tag-1', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenLastCalledWith(
        'session.spawn_new',
        {
          path: '/tmp',
          title: 'My title',
          tag: 'tag-1',
        },
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
    } finally {
      output.restore();
    }
  });

  it('rejects --backend customAcp because a concrete configured ACP backend is required', async () => {
    execute.mockClear();

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--backend', 'customAcp', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_create',
        error: {
          code: 'invalid_arguments',
          message: `Usage: ${SESSION_HELP_LINES.create}`,
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

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_create',
        data: { kind: 'approval_request_created', artifactId: 'approval-1' },
      }));
    } finally {
      output.restore();
    }
  });

  it('defaults the spawn path from the stack-invoked cwd when --path is omitted', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-2',
        created: true,
        session: { id: 'sess-2' },
      },
    });

    const previous = process.env.HAPPIER_STACK_INVOKED_CWD;
    process.env.HAPPIER_STACK_INVOKED_CWD = '/tmp/hstack-invoked-cwd';

    const output = captureConsoleJsonOutput();
    try {
      execute.mockClear();
      await handleSessionCommand(
        ['create', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(execute).toHaveBeenLastCalledWith(
        'session.spawn_new',
        expect.objectContaining({
          path: '/tmp/hstack-invoked-cwd',
        }),
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
    } finally {
      output.restore();
      if (previous === undefined) {
        delete process.env.HAPPIER_STACK_INVOKED_CWD;
      } else {
        process.env.HAPPIER_STACK_INVOKED_CWD = previous;
      }
    }
  });

  it('returns the stable attempt id needed for a resolve-only retry after ambiguity', async () => {
    execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'action_failed',
      error: 'session_spawn_resolve_unsupported',
      details: { spawnNonce: 'session.spawn_new:root:attempt-1', accepted: true },
    });
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([
        'create', '--path', '/tmp', '--spawn-attempt-id', 'attempt-1', '--json',
      ], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.spawn_new',
        expect.anything(),
        expect.objectContaining({ actionRequestId: 'attempt-1' }),
      );
      expect(output.json()).toMatchObject({
        ok: false,
        error: { spawnAttemptId: 'attempt-1' },
      });
    } finally {
      output.restore();
    }
  });
});
