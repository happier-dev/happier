import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PERMISSION_INTENTS_V1 } from '@happier-dev/protocol';

import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { FIRST_CLASS_SESSION_COMMANDS } from '@/cli/firstClassSessionCommands';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';
import { handleSessionCommand } from './handleSessionCommand';

const execute = vi.fn();
const resolveMachineTarget = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveMachineTarget }));
const { readStoredCredentials, readSettings, readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
  readSettings: vi.fn(),
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return {
    ...actual,
    configuration: {
      ...actual.configuration,
      activeServerId: 'server-1',
    },
  };
});

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readStoredCredentials,
    readSettings,
  };
});

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  execute.mockReset();
  resolveMachineTarget.mockReset();
  createCliActionExecutorFromCredentials.mockClear();
  readStoredCredentials.mockReset();
  readStoredCredentials.mockResolvedValue({
    token: 'token_test',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  });
  readSettings.mockReset();
  readSettings.mockResolvedValue({ machineId: 'machine-1' });
  readAgentCatalogSnapshot.mockReset();
  readAgentCatalogSnapshot.mockReturnValue({
    agentDefinitionsById: new Map([
      ['claude', {
        id: 'claude',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      }],
      ['codex', {
        id: 'codex',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      }],
    ]),
    catalogEntriesById: {
      claude: { id: 'claude', cliSubcommand: 'claude' },
      codex: {
        id: 'codex',
        cliSubcommand: 'codex',
        connectedServiceIds: ['openai-codex', 'openai'],
      },
    },
    executionRunProfiles: [],
  });
});

afterEach(() => {
  process.exitCode = previousExitCode;
});

function sessionSpawnSuccess(sessionId: string) {
  return {
    ok: true,
    result: {
      type: 'success' as const,
      sessionId,
      disposition: 'created' as const,
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' as const },
    },
  };
}

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
      for (const permissionIntent of AGENT_PERMISSION_INTENTS_V1) {
        expect(output.text()).toContain(permissionIntent);
      }
      expect(output.text()).toContain('read_only');
      expect(output.text()).toContain('--agent');
      expect(output.text()).not.toContain('--backend');
      expect(output.text()).not.toContain('--host');
      expect(output.text()).not.toContain('--runtime-descriptor-json');
      expect(output.text()).not.toContain('--tag');
    } finally {
      output.restore();
    }
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce(sessionSpawnSuccess('sess-1'));

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--backend', 'agent:claude', '--title', 'My title', '--prompt', 'Hello', '--json'],
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
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          directory: '/tmp',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
          },
          title: 'My title',
          initialInput: { text: 'Hello' },
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

  it('uses the shared machine selector for a PAT spawn without a daemon-local target', async () => {
    resolveMachineTarget.mockResolvedValueOnce({ ok: true, machineId: 'machine-remote' });
    execute.mockResolvedValueOnce(sessionSpawnSuccess('sess-pat-machine'));

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--json'], {
        readCredentialsFn: async () => ({
          token: 'hap_v1_token_test',
          encryption: null,
          credentialProvenance: 'api_token',
        }),
      });

      expect(resolveMachineTarget).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.spawn_new',
        expect.objectContaining({
          executionTarget: { serverId: 'server-1', machineId: 'machine-remote' },
        }),
        expect.objectContaining({ surface: 'cli' }),
      );
    } finally {
      output.restore();
    }
  });

  it('keeps the creation envelope when --wait delays its JSON serialization', async () => {
    execute
      .mockResolvedValueOnce(sessionSpawnSuccess('sess-wait'))
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, sessionId: 'sess-wait', observedAt: 123 },
      });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--wait', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.wait.idle',
        { sessionId: 'sess-wait', timeoutSeconds: 300 },
        { surface: 'cli', defaultSessionId: null },
      );
      expect(output.json()).toEqual({
        v: 1,
        ok: true,
        kind: 'session_create',
        data: { created: true, session: { id: 'sess-wait' } },
      });
    } finally {
      output.restore();
    }
  });

  it('keeps top-level spawn --wait JSON byte-identical to session create', async () => {
    execute
      .mockResolvedValueOnce(sessionSpawnSuccess('sess-parity'))
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, sessionId: 'sess-parity', observedAt: 123 },
      });

    const nestedOutput = captureConsoleJsonOutput();
    let nestedLogs: string[] = [];
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--wait', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      nestedLogs = [...nestedOutput.logs];
    } finally {
      nestedOutput.restore();
    }

    execute.mockReset();
    execute
      .mockResolvedValueOnce(sessionSpawnSuccess('sess-parity'))
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, sessionId: 'sess-parity', observedAt: 123 },
      });
    const spawn = FIRST_CLASS_SESSION_COMMANDS.find((command) => command.command === 'spawn');
    expect(spawn).toBeDefined();

    const topLevelOutput = captureConsoleJsonOutput();
    try {
      await spawn!.handler({
        args: ['spawn', '--path', '/tmp', '--wait', '--json'],
        rawArgv: ['happier', 'spawn', '--path', '/tmp', '--wait', '--json'],
        terminalRuntime: null,
      });

      expect(topLevelOutput.logs).toEqual(nestedLogs);
    } finally {
      topLevelOutput.restore();
    }
  });

  it('emits the creation envelope before unchanged compact history rows for --follow --jsonl', async () => {
    execute
      .mockResolvedValueOnce(sessionSpawnSuccess('sess-follow'))
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ok: true,
          leaseId: 'lease-follow',
          items: [{
            id: 'row-1',
            seq: 1,
            createdAt: 123,
            role: 'assistant',
            kind: 'assistant_message',
            raw: { role: 'agent', content: { type: 'text', text: 'followed message' } },
          }],
          nextCursor: 'cursor-1',
          truncated: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-follow', items: [], nextCursor: 'cursor-1', truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, session: { id: 'sess-follow', active: false } },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-follow', items: [], nextCursor: 'cursor-1', truncated: false },
      })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, released: true } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--follow', '--jsonl'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.logs.map((line) => JSON.parse(line))).toEqual([
        {
          v: 1,
          ok: true,
          kind: 'session_create',
          data: { created: true, session: { id: 'sess-follow' } },
        },
        {
          id: 'row-1',
          seq: 1,
          createdAt: 123,
          role: 'agent',
          kind: 'text',
          text: 'followed message',
        },
      ]);
      expect(execute).toHaveBeenNthCalledWith(
        2,
        'transcript.follow',
        expect.objectContaining({ sessionId: 'sess-follow', cursor: '0' }),
        { surface: 'cli', defaultSessionId: null },
      );
    } finally {
      output.restore();
    }
  });

  it('emits the creation envelope when --follow --jsonl completes without transcript rows', async () => {
    execute
      .mockResolvedValueOnce(sessionSpawnSuccess('sess-empty'))
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-empty', items: [], nextCursor: 'cursor-0', truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, session: { id: 'sess-empty', active: false } },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-empty', items: [], nextCursor: 'cursor-0', truncated: false },
      })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, released: true } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--follow', '--jsonl'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.logs.map((line) => JSON.parse(line))).toEqual([{
        v: 1,
        ok: true,
        kind: 'session_create',
        data: { created: true, session: { id: 'sess-empty' } },
      }]);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      output.restore();
    }
  });

  it('emits one failure envelope and does not follow when JSONL creation fails', async () => {
    execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'server_unreachable',
      error: 'daemon unavailable',
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--follow', '--jsonl'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(output.logs.map((line) => JSON.parse(line))).toEqual([{
        v: 1,
        ok: false,
        kind: 'session_create',
        error: { code: 'server_unreachable', message: 'daemon unavailable' },
      }]);
    } finally {
      output.restore();
    }
  });

  it('keeps the creation envelope before a terminal follow failure and releases once', async () => {
    execute
      .mockResolvedValueOnce(sessionSpawnSuccess('sess-follow-failure'))
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'server_unreachable',
        error: 'follow daemon unavailable',
      })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, released: true } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--follow', '--jsonl'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute).toHaveBeenNthCalledWith(
        3,
        'transcript.unfollow',
        { sessionId: 'sess-follow-failure', leaseId: expect.any(String) },
        { surface: 'cli', defaultSessionId: null },
      );
      expect(output.logs.map((line) => JSON.parse(line))).toEqual([
        {
          v: 1,
          ok: true,
          kind: 'session_create',
          data: { created: true, session: { id: 'sess-follow-failure' } },
        },
        {
          v: 1,
          ok: false,
          kind: 'session_create',
          error: { code: 'server_unreachable', message: 'follow daemon unavailable' },
        },
      ]);
    } finally {
      output.restore();
    }
  });

  it.each([
    [['--host', 'legacy-host', 'would-be-prompt'], /--machine-id/i],
    [['--host=legacy-host', 'would-be-prompt'], /--machine-id/i],
    [['--tag', 'legacy-label', 'would-be-prompt'], /--title/i],
    [['--tag=legacy-label', 'would-be-prompt'], /--title/i],
    [['--runtime-descriptor-json={"v":1}', 'would-be-prompt'], /--agent.*--model.*--mode/i],
    [['--agent-runtime-descriptor-json={"v":1}', 'would-be-prompt'], /--agent.*--model.*--mode/i],
  ])('returns one typed invalid-argument envelope for retired create flags %o', async (args, guidance) => {
    const readCredentialsFn = vi.fn(async () => ({
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    }));
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', ...args, '--json'], { readCredentialsFn });

      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_create',
        error: { code: 'invalid_arguments', message: expect.stringMatching(guidance) },
      });
    } finally {
      output.restore();
    }
  });

  it('normalizes read_only before executing session.spawn_new', async () => {
    execute.mockResolvedValueOnce(sessionSpawnSuccess('sess-read-only'));

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--permission-mode', 'read_only', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(execute).toHaveBeenCalledWith(
        'session.spawn_new',
        expect.objectContaining({ permissionMode: 'read-only' }),
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
      expect(output.json()).toMatchObject({ ok: true, kind: 'session_create' });
    } finally {
      output.restore();
    }
  });

  it('returns invalid_arguments for an unknown permission mode without executing an action', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--permission-mode', 'surprise-me', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_create',
        error: {
          code: 'invalid_arguments',
          message: expect.stringMatching(/permission mode/i),
        },
      });
    } finally {
      output.restore();
    }
  });

  it('accepts --backend as an Agent id alias and emits its qualified identity', async () => {
    execute.mockClear();
    execute.mockResolvedValueOnce(sessionSpawnSuccess('sess-2'));

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
        {
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          directory: '/tmp',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
          },
        },
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
    } finally {
      output.restore();
    }
  });

  it('accepts --agent as a single-target alias and emits its qualified identity', async () => {
    execute.mockClear();
    execute.mockResolvedValueOnce(sessionSpawnSuccess('sess-3'));

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
        {
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          directory: '/tmp',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
        },
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
      .mockResolvedValueOnce(sessionSpawnSuccess('sess-auth'));

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

  it('resolves the catalog default Agent before invoking the Action', async () => {
    execute.mockClear();
    execute.mockResolvedValueOnce(sessionSpawnSuccess('sess-3'));

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['create', '--path', '/tmp', '--title', 'My title', '--json'],
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
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          directory: '/tmp',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
          },
          title: 'My title',
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

  it('emits one approval-created envelope and does not follow for --follow --jsonl', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-follow' },
    });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--path', '/tmp', '--follow', '--jsonl'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(output.logs.map((line) => JSON.parse(line))).toEqual([{
        v: 1,
        ok: true,
        kind: 'session_create',
        data: { kind: 'approval_request_created', artifactId: 'approval-follow' },
      }]);
    } finally {
      output.restore();
    }
  });

  it('defaults the spawn path from the stack-invoked cwd when --path is omitted', async () => {
    execute.mockResolvedValueOnce(sessionSpawnSuccess('sess-2'));

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
          directory: '/tmp/hstack-invoked-cwd',
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

  it('shows a human run the same stable attempt id when creation stays pending', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { type: 'pending' as const, outcome: 'unknown', retryWithSameCreationKey: true },
    });

    await expect(handleSessionCommand([
      'create', '--path', '/tmp', '--spawn-attempt-id', 'attempt-7',
    ], {
      readCredentialsFn: async () => ({
        token: 'token_test',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      }),
    })).rejects.toThrow(/--spawn-attempt-id attempt-7 --resume-spawn-attempt/u);
  });
});
