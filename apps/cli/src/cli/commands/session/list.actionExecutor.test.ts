import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { captureConsoleJsonOutput, captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { findCompiledActionCliCommand } from '@/cli/actions/compiledCommands';
import {
  runCompiledActionCliCommand,
  type ActionCliExecutionDeps,
} from '@/cli/actions/executeCommand';
import { handleSessionCommand } from './handleSessionCommand';
import { SESSION_LIST_PRESENTATION } from './sessionListPresentation';

const execute = vi.fn();
const resolveSessionTarget = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session list (action executor)', () => {
  beforeEach(() => {
    execute.mockReset();
    resolveSessionTarget.mockReset();
    createCliActionExecutorFromCredentials.mockClear();
  });

  it.each(['summary', 'awareness'] as const)('retains unavailable Bot metadata coverage in %s output', async (view) => {
    const command = findCompiledActionCliCommand(['session', 'list']);
    if (!command || !SESSION_LIST_PRESENTATION.presentSuccess) throw new Error('Session list presentation unavailable');
    const payload = { ...(view === 'awareness' ? { view, projectionVersion: 1 } : {}),
      sessions: [], nextCursor: null, hasNext: false, botFilterUnavailableCount: 1 };
    const output = captureConsoleJsonOutput();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await SESSION_LIST_PRESENTATION.presentSuccess(payload, { command, json: true, input: { view }, callerInput: {} });
      expect(output.json()).toMatchObject({ data: { botFilterUnavailableCount: 1 } });
      await SESSION_LIST_PRESENTATION.presentSuccess(payload, { command, json: false, input: { view }, callerInput: {} });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/incomplete.*metadata/i));
    } finally { warn.mockRestore(); output.restore(); }
  });

  it.each(['summary', 'awareness'] as const)('preserves metadata omissions in %s JSON and human presentation', async (view) => {
    const command = findCompiledActionCliCommand(['session', 'list']);
    if (!command || !SESSION_LIST_PRESENTATION.presentSuccess) throw new Error('Session list presentation unavailable');
    const payload = {
      ...(view === 'awareness' ? { view, projectionVersion: 1 } : {}),
      sessions: [], nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 2,
    };
    const output = captureConsoleJsonOutput();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Exercise the real presenter directly; the Action executor substitution above is unused.
      await SESSION_LIST_PRESENTATION.presentSuccess(payload, {
        command, json: true, input: { view }, callerInput: {},
      });
      expect(output.json()).toMatchObject({
        ok: true, kind: 'session_list', data: {
          sessions: [], hasNext: false, metadataUpgradeRequiredCount: 2,
        },
      });
      expect(warn).not.toHaveBeenCalled();

      for (const plain of [false, true]) {
        warn.mockClear();
        await SESSION_LIST_PRESENTATION.presentSuccess(payload, {
          command, json: false, input: { view }, callerInput: { plain },
        });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/incomplete.*owner.*upgrade/i));
      }
    } finally {
      warn.mockRestore();
      output.restore();
    }
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });

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
        expect.objectContaining({
          surface: 'cli',
          defaultSessionId: null,
          actionRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          // A finite list request must give PAT-backed public Action transport
          // a cancellation lifetime instead of waiting for its daemon relay forever.
          signal: expect.objectContaining({
            aborted: false,
            addEventListener: expect.any(Function),
          }),
        }),
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

  it('maps the filtered-listing flags into one canonical query and preserves the awareness view', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { view: 'awareness', projectionVersion: 1, sessions: [], nextCursor: null, hasNext: false },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([
        'list',
        '--scope', 'assigned_to_me',
        '--team', 'team-b',
        '--team', 'team-a',
        '--group', 'team-c/group-b',
        '--group', 'team-c/group-a',
        '--outside-teams',
        '--tag', 'tag-b',
        '--tag', 'tag-a',
        '--attention',
        '--include-inactive',
        '--archived',
        '--awareness',
        '--limit', '10',
        '--cursor', 'cursor_v1_session-1',
        '--json',
      ], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledWith(
        'session.list',
        {
          query: {
            v: 1,
            storage: 'archived',
            includeInactive: true,
            scope: 'assigned_to_me',
            attention: 'needs_my_attention',
            audiences: [
              { kind: 'group', teamId: 'team-c', groupId: 'group-a' },
              { kind: 'group', teamId: 'team-c', groupId: 'group-b' },
              { kind: 'outside_teams' },
              { kind: 'team', teamId: 'team-a' },
              { kind: 'team', teamId: 'team-b' },
            ],
            tagIds: ['tag-a', 'tag-b'],
            cursor: 'cursor_v1_session-1',
            limit: 10,
          },
          view: 'awareness',
        },
        expect.objectContaining({
          surface: 'cli',
          defaultSessionId: null,
          actionRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          signal: expect.objectContaining({
            aborted: false,
            addEventListener: expect.any(Function),
          }),
        }),
      );
      expect(output.json()).toMatchObject({ data: {
        view: 'awareness', projectionVersion: 1, sessions: [], nextCursor: null, hasNext: false,
      } });
    } finally {
      output.restore();
    }
  });

  it('defaults an audience query to all_accessible without changing awareness-only or archived-only calls', async () => {
    execute.mockResolvedValue({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const readCredentialsFn = async () => ({
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--team', 'team-a', '--json'], { readCredentialsFn });
      execute.mockResolvedValueOnce({
        ok: true,
        result: { view: 'awareness', projectionVersion: 1, sessions: [], nextCursor: null, hasNext: false },
      });
      await handleSessionCommand(['list', '--awareness', '--json'], { readCredentialsFn });
      await handleSessionCommand(['list', '--archived', '--json'], { readCredentialsFn });

      expect(execute.mock.calls.map((call) => call[1])).toEqual([
        {
          query: {
            v: 1,
            storage: 'active',
            includeInactive: false,
            scope: 'all_accessible',
            attention: 'any',
            audiences: [{ kind: 'team', teamId: 'team-a' }],
            tagIds: [],
          },
        },
        { view: 'awareness' },
        { archivedOnly: true },
      ]);
    } finally {
      output.restore();
    }
  });

  it('forwards an explicit machine selector to the shared Action transport owner', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
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

  it('pins --server-id to that saved Home credential, endpoint, and stable identity', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const readCredentialsFn = vi.fn(async () => ({
      token: 'active-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    }));
    const selectedCredentials = {
      token: 'home-b-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(2) },
    };
    const getServerProfileFn = vi.fn(async () => ({
      id: 'home-b-profile',
      name: 'Home B',
      serverUrl: 'https://home-b.example.test',
      localServerUrl: 'http://127.0.0.1:43100',
      webappUrl: 'https://app.home-b.example.test',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
      homeConnectionDescriptor: {
        v: 1 as const,
        homeServerIdentityId: 'home-b-stable',
        canonicalServerUrl: 'https://home-b.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://home-b.example.test' }],
      },
      homeConnectionDescriptorAuthority: 'exact' as const,
    }));
    const readCredentialsForServerIdFn = vi.fn(async () => selectedCredentials);
    const serverFeaturesSnapshot = {
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true },
          sharing: { session: { enabled: true } },
        },
        capabilities: {},
      }),
    };
    const refresh = vi.fn(async () => serverFeaturesSnapshot);
    const createServerFeaturesSnapshotStoreFn = vi.fn(() => ({
      getSnapshot: () => undefined,
      isRefreshTransitionActive: () => false,
      refresh,
    }));
    let resolveServerFeaturesSnapshot: Parameters<ActionCliExecutionDeps['createExecutorFn']>[0]['resolveServerFeaturesSnapshot'];
    const createExecutorFn: ActionCliExecutionDeps['createExecutorFn'] = vi.fn((executorParams) => {
      resolveServerFeaturesSnapshot = executorParams.resolveServerFeaturesSnapshot;
      return { execute, resolveSessionTarget };
    });
    const output = captureConsoleJsonOutput();
    try {
      const command = findCompiledActionCliCommand(['session', 'list']);
      expect(command).not.toBeNull();
      await runCompiledActionCliCommand({
        command: command!,
        argv: ['session', 'list', '--server-id', 'home-b-profile', '--json'],
        deps: {
          readCredentialsFn,
          getServerProfileFn,
          readCredentialsForServerIdFn,
          createServerFeaturesSnapshotStoreFn,
          createExecutorFn,
        },
      });

      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(getServerProfileFn).toHaveBeenCalledWith('home-b-profile');
      expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('home-b-profile');
      expect(createServerFeaturesSnapshotStoreFn).toHaveBeenCalledWith({
        serverUrl: 'http://127.0.0.1:43100',
        token: 'home-b-token',
      });
      expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
        credentials: selectedCredentials,
        serverId: 'home-b-profile',
        serverIdentityId: 'home-b-stable',
        serverApiUrl: 'http://127.0.0.1:43100',
        resolveServerFeaturesSnapshot: expect.any(Function),
        readCredentials: expect.any(Function),
      }));
      expect(await resolveServerFeaturesSnapshot?.()).toEqual(serverFeaturesSnapshot);
      expect(await resolveServerFeaturesSnapshot?.()).toEqual(serverFeaturesSnapshot);
      expect(refresh).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith('session.list', {}, expect.objectContaining({
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
    ['a missing machine selector', ['list', '--machine-id', '--json']],
    ['duplicate machine selectors', ['list', '--machine-id', 'machine-a', '--machine-id', 'machine-b', '--json']],
    ['a missing Home selector', ['list', '--server-id', '--json']],
    ['duplicate Home selectors', ['list', '--server-id', 'home-a', '--server-id', 'home-b', '--json']],
    ['an unknown scope', ['list', '--scope', 'mine', '--json']],
    ['a malformed group selector', ['list', '--group', 'team-only', '--json']],
    ['a group selector with extra segments', ['list', '--group', 'team/group/extra', '--json']],
    ['duplicate team selectors', ['list', '--team', 'team-a', '--team', 'team-a', '--json']],
    ['duplicate tag selectors', ['list', '--tag', 'tag-a', '--tag', 'tag-a', '--json']],
    ['a query selector combined with resumable-only filtering', ['list', '--scope', 'my_work', '--resumable', '--json']],
  ])('rejects %s before listing sessions', async (_label, argv) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const readCredentialsFn = vi.fn(async () => ({
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    }));
    const output = captureConsoleJsonOutput();
    const priorExitCode = process.exitCode;
    try {
      await handleSessionCommand(argv, { readCredentialsFn });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = priorExitCode;
    }
  });

  it('clamps the requested limit to the supported maximum', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--limit', '999', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.list',
        { limit: 200 },
        expect.objectContaining({
          surface: 'cli',
          defaultSessionId: null,
          actionRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          signal: expect.objectContaining({
            aborted: false,
            addEventListener: expect.any(Function),
          }),
        }),
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
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--json'], {
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
        expect.objectContaining({
          surface: 'cli',
          defaultSessionId: null,
          actionRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          signal: expect.objectContaining({
            aborted: false,
            addEventListener: expect.any(Function),
          }),
        }),
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

  it('preserves a successful canonical Action result when the friendly presenter cannot render it', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { sessions: 'not-a-session-list' },
    });
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'session_list',
        data: { sessions: 'not-a-session-list' },
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
    }
  });
});
