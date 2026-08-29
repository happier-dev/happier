import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput, captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session list (action executor)', () => {
  beforeEach(() => {
    execute.mockReset();
    createCliActionExecutorFromCredentials.mockClear();
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['list', '--active', '--include-system', '--resumable', '--limit', '10', '--cursor', 'cursor-1', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.list',
        {
          activeOnly: true,
          includeSystem: true,
          resumableOnly: true,
          limit: 10,
          cursor: 'cursor-1',
        },
        {
          surface: 'cli',
          defaultSessionId: null,
          // A finite list request must give PAT-backed public Action transport
          // a cancellation lifetime instead of waiting for its daemon relay forever.
          signal: expect.objectContaining({
            aborted: false,
            addEventListener: expect.any(Function),
          }),
        },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_list',
        data: {
          sessions: [],
          nextCursor: null,
          hasNext: false,
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('forwards an explicit machine selector to the shared Action transport owner', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--machine-id', 'machine-remote', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine-remote',
      }));
    } finally {
      output.restore();
    }
  });

  it.each([
    ['an unknown option', ['list', '--definitely-invalid', '--json']],
    ['a non-positive limit', ['list', '--limit', '0', '--json']],
    ['a non-integer limit', ['list', '--limit', '10oops', '--json']],
    ['a missing cursor value', ['list', '--cursor', '--json']],
  ])('rejects %s before listing sessions', async (_label, argv) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const readCredentialsFn = vi.fn(async () => ({
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    }));
    const { cmdSessionList } = await import('./list');

    await expect(cmdSessionList(argv, { readCredentialsFn })).rejects.toThrow();

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('clamps the requested limit to the supported maximum', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const { cmdSessionList } = await import('./list');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionList(['list', '--limit', '999', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.list',
        { limit: 200 },
        {
          surface: 'cli',
          defaultSessionId: null,
          signal: expect.objectContaining({
            aborted: false,
            addEventListener: expect.any(Function),
          }),
        },
      );
    } finally {
      output.restore();
    }
  });

  it('preserves caller cancellation while adding the finite list deadline', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const controller = new AbortController();
    const reason = new Error('list invocation cancelled');
    controller.abort(reason);
    const { cmdSessionList } = await import('./list');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionList(['list', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
        signal: controller.signal,
      });

      const actionContext = execute.mock.calls[0]?.[2] as Readonly<{ signal: AbortSignal }> | undefined;
      expect(actionContext?.signal.aborted).toBe(true);
      expect(actionContext?.signal.reason).toBe(reason);
    } finally {
      output.restore();
    }
  });

  it('requests terminal rows for human-readable output', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        sessions: [{
          id: 'sess_1234567890',
          title: 'Session',
          createdAt: 1,
          updatedAt: 2,
          active: false,
          activeAt: 0,
          encryption: { type: 'legacy' },
        }],
        rows: [{
          id: 'sess_1234567890',
          agentId: 'claude',
          createdAt: 1,
          updatedAt: 2,
          active: false,
          activeAt: 0,
          archivedAt: null,
          tag: null,
          title: 'Session',
          path: null,
          isSystem: false,
          systemPurpose: null,
          vendorResume: { eligible: false, reasonCode: 'vendor_resume_id_missing' },
          encryptionMode: 'e2ee',
        }],
        nextCursor: null,
      },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleSessionCommand(['list'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledWith(
        'session.list',
        { includeRows: true },
        {
          surface: 'cli',
          defaultSessionId: null,
          signal: expect.objectContaining({
            aborted: false,
            addEventListener: expect.any(Function),
          }),
        },
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
      await handleSessionCommand(['list', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_list',
        data: { kind: 'approval_request_created', artifactId: 'approval-1' },
      }));
    } finally {
      output.restore();
    }
  });

  it('rejects a malformed successful Action result instead of treating it as an empty list', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: 'not-a-session-list' },
    });
    const { cmdSessionList } = await import('./list');

    await expect(cmdSessionList(['list', '--json'], {
      readCredentialsFn: async () => ({
        token: 'token_test',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      }),
    })).rejects.toThrow();
  });
});
