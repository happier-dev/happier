import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session create (action executor)', () => {
  it('prints usage and does not execute any action when --help is requested', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleText();
    try {
      await handleSessionCommand(['create', '--help'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).not.toHaveBeenCalled();
      expect(output.text()).toContain('happier session create [--path <path>] [--backend <backend-target>] [--title <title>] [--tag <tag>] [--prompt <text>|--message <text>] [--json]');
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

    const { handleSessionCommand } = await import('./handleSessionCommand');

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
          title: 'My title',
          tag: 'tag-1',
          initialMessage: 'Hello',
        },
        { surface: 'cli', defaultSessionId: null },
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

  it('prints approval_request_created as the JSON envelope data', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

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
});
