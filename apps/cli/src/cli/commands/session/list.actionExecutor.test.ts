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
        { surface: 'cli', defaultSessionId: null },
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

  it('requests terminal rows for human-readable output', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        sessions: [{ id: 'sess_1234567890', title: 'Session' }],
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
});
