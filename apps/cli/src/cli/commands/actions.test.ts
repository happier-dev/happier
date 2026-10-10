import { afterEach, describe, expect, it, vi } from 'vitest';

const credentialBoundary = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: credentialBoundary.readStoredCredentials,
}));
import { handleActionsCommand } from './actions';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

function credentials(provenance: 'api_token' | 'stored_session'): any {
  return { token: 'token', credentialProvenance: provenance };
}

function contributedActionDefinition() {
  return {
    kindVersion: 1,
    id: 'example.plugin/actions/do-work',
    title: 'Do work',
    description: 'Runs the contributed operation.',
    safety: 'danger',
    placements: [],
    slash: null,
    bindings: null,
    examples: { mcp: { argsExample: '{"note":"Review this","mode":"safe"}' } },
    surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, api: true, plugin: true },
    inputHints: {
      title: 'Do work',
      fields: [
        { path: 'note', title: 'Note', widget: 'text', required: true },
        {
          path: 'mode',
          title: 'Mode',
          widget: 'select',
          options: [
            { value: 'safe', label: 'Safe' },
            { value: 'fast', label: 'Fast' },
          ],
        },
        {
          path: 'attempts',
          title: 'Attempts',
          widget: 'integer',
          requiredWhen: { op: 'eq', path: 'mode', value: 'fast' },
        },
      ],
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['safe', 'fast'] },
        attempts: { type: 'integer', minimum: 1, maximum: 5 },
        config: { type: 'object' },
      },
      required: ['note'],
    },
  } as const;
}

describe('actions root command', () => {
  it('refuses a filesystem byte transfer without local custody before reading credentials', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const readCredentialsFn = vi.fn(async () => credentials('stored_session'));
    await handleActionsCommand(['invoke', 'daemon.filesystem.upload', '--machine-id', 'machine-1', '--input-json', JSON.stringify({
      rootPath: '/repo', path: 'literal \n ', source: { sourceId: 'source-1', sizeBytes: 4 }, overwrite: false,
    }), '--json'], { readCredentialsFn });
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });
  it('dispatches mixed-corpus memory search through the real Action executor', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find((argument) => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const result = { v: 1 as const, ok: true as const, hits: [], documents: { state: 'unavailable' as const } };
    // The daemon RPC is the system boundary; CLI parsing and Action admission remain real.
    const daemonMemorySearch = vi.fn(async () => result);
    const query = { v: 1, query: 'decision', scope: { type: 'global' }, mode: 'deep', corpora: ['sessions', 'documents'] };
    await handleActionsCommand(['invoke', 'memory.search', '--input-json', JSON.stringify({ machineId: 'machine_1', query }), '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: () => createCliActionExecutorHarness({ token: 'token', sessionId: '' }, { daemonMemorySearch }).executor,
    });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: result });
    expect(daemonMemorySearch).toHaveBeenCalledWith({ machineId: 'machine_1', query, serverId: null });
  });

  it('carries standalone Workflow project selection as target context, never Action input', async () => {
    const execute = vi.fn(async () => ({ ok: true, result: { run: { id: 'run-1' }, admission: 'created' } }));
    await handleActionsCommand([
      'invoke', 'workflow.run.start',
      '--machine-id', 'machine-1',
      '--project-directory', '/repo/packages/app',
      '--workspace-ref-id', 'workspace-1',
      '--input-json', JSON.stringify({
        runId: '11111111-1111-4111-8111-111111111111',
        source: { kind: 'inline', definition: { version: 1, inputs: [], defaults: {}, blocks: ['work'] } },
      }),
      '--json',
    ], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute })) as any,
    });
    expect(execute).toHaveBeenCalledWith(
      'workflow.run.start',
      expect.not.objectContaining({ project: expect.anything() }),
      expect.objectContaining({
        externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo/packages/app', workspaceRefId: 'workspace-1' } },
      }),
    );
  });

  it('describes request ids as correlation unless the Action owns idempotency', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleActionsCommand(['--help']);

    const help = log.mock.calls.map(([value]) => String(value)).join('\n');
    expect(help).toContain('--request-id <id>');
    expect(help).toContain('Request correlation identifier');
    expect(help).not.toContain('Idempotency request identifier');
  });

  it('shows help from a concrete subcommand without reading credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn();

    await handleActionsCommand(['search', '--help'], { readCredentialsFn });

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('happier actions search');
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves canonical Action failure code, candidates, and details as expected exit 1', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk); args.find((value) => typeof value === 'function')?.(); return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: false, errorCode: 'action_disabled', error: 'Disabled by policy', details: { policy: 'deny' } }));
    await handleActionsCommand(['get', 'machines.list', '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute })) as any,
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: 'action_disabled', message: 'Disabled by policy', details: { policy: 'deny' } },
    });
    expect(process.exitCode).toBe(1);
  });

  it('uses the real stored-credential source so a token-only PAT reaches public transport composition', async () => {
    credentialBoundary.readStoredCredentials.mockResolvedValue(credentials('api_token'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true, result: { actionSpecs: [] } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    await handleActionsCommand(['search', 'machine', 'actions'], { createExecutorFn: createExecutorFn as any });
    expect(credentialBoundary.readStoredCredentials).toHaveBeenCalledOnce();
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ credentialProvenance: 'api_token' }),
      externalActionClient: true,
    }));
    expect(execute).toHaveBeenCalledWith(
      'action.spec.search',
      { query: 'machine actions' },
      expect.objectContaining({ surface: 'cli' }),
    );
  });

  it.each(['stored_session', 'api_token'] as const)('uses the same API surface for built-in and contributed invoke with %s credentials', async (provenance) => {
    vi.spyOn(process.stdout, 'write').mockImplementation(((...args: any[]) => { args.find((value) => typeof value === 'function')?.(); return true; }) as any);
    const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { invoked: true } });
    const deps = {
      readCredentialsFn: async () => credentials(provenance),
      createExecutorFn: (() => ({ execute })) as any,
    };
    await handleActionsCommand(['invoke', 'machines.list', '--input-json', '{}'], deps);
    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"hi"}'], deps);
    expect(execute.mock.calls[0]).toEqual(['machines.list', {}, expect.objectContaining({
      surface: 'cli',
    })]);
    expect(execute.mock.calls[1]).toEqual([
      'action.spec.get',
      { id: 'example.plugin/actions/do-work' },
      expect.objectContaining({ surface: 'cli' }),
    ]);
    expect(execute.mock.calls[2]).toEqual(['action.invoke', {
      action: { pluginId: 'example.plugin', localId: 'do-work' }, input: { note: 'hi' },
    }, expect.objectContaining({ surface: 'cli' })]);
  });

  it.each([
    {
      actionId: 'teams.identity.connections.list',
      inputArgs: ['--v', '1', '--team-id', 'team_1'],
    },
    {
      actionId: 'identity.providers.list',
      inputArgs: [],
    },
  ])('does not let generic invoke bypass the exact-Home requirement for $actionId', async ({ actionId, inputArgs }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('stored_session'));
    const createExecutorFn = vi.fn();

    await handleActionsCommand([
      'invoke',
      actionId,
      ...inputArgs,
    ], {
      readCredentialsFn,
      createExecutorFn: createExecutorFn as never,
    });

    expect(error.mock.calls.flat().join('\n')).toContain('--server-id');
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(createExecutorFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { v: 1, ok: true, hits: [] },
    { v: 1, ok: false, errorCode: 'memory_disabled', error: 'Memory is disabled' },
  ])('preserves an admitted Action result unchanged when its own result contains ok=$ok', async (result) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: true as const, result }));

    await handleActionsCommand([
      'invoke',
      'memory.search',
      '--input-json',
      '{"machineId":"machine_1","query":{"v":1,"query":"needle","scope":{"type":"global"},"mode":"hints"}}',
      '--json',
    ], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(JSON.parse(output)).toEqual({
      v: 1,
      ok: true,
      kind: 'actions_invoke',
      data: result,
    });
    expect(process.exitCode).toBe(0);
  });

  it('accepts the Protocol request-id grammar instead of imposing a CLI-only ASCII subset', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(((...args: any[]) => {
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: true as const, result: { invoked: true } }));

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', 'corrélation-☃', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledWith(
      'machines.list',
      { limit: 200 },
      expect.objectContaining({ actionRequestId: 'corrélation-☃' }),
    );
    expect(process.exitCode).toBe(0);
  });

  it('rejects a request id beyond the Protocol-owned limit', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn();

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', 'x'.repeat(129), '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it('rejects request-id outer whitespace instead of silently changing the Protocol identity', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn();

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', ' correlation ', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it('emits a stable invalid_arguments JSON envelope for a missing option value', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      const callback = args.find((value) => typeof value === 'function');
      callback?.();
      return true;
    }) as any);
    await handleActionsCommand(['invoke', 'machines.list', '--input-json', '--json'], {
      readCredentialsFn: vi.fn(), createExecutorFn: vi.fn() as any,
    });
    expect(JSON.parse(output)).toMatchObject({ v: 1, ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it.each(['stored_session', 'api_token'] as const)('binds an exact machine and uses canonical get input for %s credentials', async (provenance) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true, result: { actionSpec: { id: 'machines.list', title: 'Machines', inputSchema: {} } } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    await handleActionsCommand(['get', 'machines.list', '--machine-id', 'machine-1'], {
      readCredentialsFn: async () => credentials(provenance),
      createExecutorFn: createExecutorFn as any,
    });
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({ externalActionClient: true, machineId: 'machine-1' }));
    expect(execute).toHaveBeenCalledWith('action.spec.get', { id: 'machines.list' }, expect.objectContaining({
      surface: 'cli',
    }));
    expect(process.exitCode).toBeUndefined();
  });

  it('binds discovery credentials and endpoint to the same exact saved Home', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true, result: { actionSpecs: [] } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn(async () => credentials('stored_session'));
    const getServerProfileFn = vi.fn(async () => ({
      id: 'home-a',
      name: 'Home A',
      serverUrl: 'https://home-a.example',
      webappUrl: 'https://home-a.example',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    }));

    await handleActionsCommand(
      ['search', 'machines', '--server-id', 'home-a'],
      {
        readCredentialsFn,
        readCredentialsForServerIdFn,
        getServerProfileFn,
        createExecutorFn: createExecutorFn as any,
      },
    );

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('home-a');
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'home-a',
      serverApiUrl: 'https://home-a.example',
      externalActionClient: true,
    }));
    expect(createExecutorFn).not.toHaveBeenCalledWith(expect.objectContaining({
      serverIdentityId: expect.anything(),
    }));
  });

  it('binds contributed discovery and invocation to one exact saved Home', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (actionId: string, _input: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { ok: true } });
    const createExecutorFn = vi.fn(() => ({ execute }));
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn(async () => credentials('stored_session'));
    const getServerProfileFn = vi.fn(async () => ({
      id: 'profile-a',
      name: 'Home A',
      serverUrl: 'https://public-a.example',
      localServerUrl: 'http://127.0.0.1:5353',
      webappUrl: 'https://public-a.example',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact' as const,
      homeConnectionDescriptor: {
        v: 1 as const,
        homeServerIdentityId: 'home-stable-a',
        urls: { public: 'https://public-a.example', local: 'http://127.0.0.1:5353' },
      },
    }));

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--note', 'hi', '--server-id', 'profile-a'],
      {
        readCredentialsFn,
        readCredentialsForServerIdFn,
        getServerProfileFn: getServerProfileFn as any,
        createExecutorFn: createExecutorFn as any,
      },
    );

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('profile-a');
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      serverId: 'profile-a',
      serverIdentityId: 'home-stable-a',
      serverApiUrl: 'http://127.0.0.1:5353',
      externalActionClient: true,
    }));
    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual(['action.spec.get', 'action.invoke']);
  });

  it.each([
    ['missing', ['--server-id']],
    ['duplicate', ['--server-id', 'home-a', '--server-id', 'home-b']],
  ] as const)('rejects a %s exact-Home selector before reading credentials', async (_case, selector) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn();
    await handleActionsCommand(
      ['invoke', 'session.list', ...selector],
      { readCredentialsFn, readCredentialsForServerIdFn, createExecutorFn: vi.fn() as any },
    );
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects unknown options before reading credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('stored_session'));
    await handleActionsCommand(['search', '--bogus'], { readCredentialsFn, createExecutorFn: vi.fn() as any });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('accepts ordinary Action fields without whole-input JSON', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (_actionId: string, _input: unknown) => ({ ok: true, result: { sessions: [] } }));
    await handleActionsCommand(
      ['invoke', 'session.list', '--limit', '5', '--archived-only', '--json'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const [actionId, input] = execute.mock.calls[0]!;
    expect(actionId).toBe('session.list');
    expect(input).toMatchObject({ limit: 5, archivedOnly: true });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('resolves a built-in invoke Session selector exactly once before execution', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true as const, result: { active: true } }));
    const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'session_exact' }));
    await handleActionsCommand(['invoke', 'session.status.get', '--session-id', 'prefix'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute, resolveSessionTarget })) as any,
    });
    expect(resolveSessionTarget).toHaveBeenCalledOnce();
    expect(resolveSessionTarget).toHaveBeenCalledWith('prefix');
    expect(execute).toHaveBeenCalledWith(
      'session.status.get',
      expect.objectContaining({ sessionId: 'session_exact' }),
      expect.objectContaining({ defaultSessionId: 'session_exact' }),
    );
  });

  it('preserves typed ambiguous Session candidates and invokes no built-in effect', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk); args.find((value) => typeof value === 'function')?.(); return true;
    }) as any);
    const execute = vi.fn();
    await handleActionsCommand(['invoke', 'session.status.get', '--session-id', 'ambiguous', '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({
        execute,
        resolveSessionTarget: vi.fn(async () => ({ ok: false as const, code: 'ambiguous_session', candidates: ['a', 'b'] })),
      })) as any,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: 'ambiguous_session', candidates: ['a', 'b'] },
    });
  });

  it('does not reinterpret a contributed input field named sessionId as a host Session selector', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const definition = {
      ...contributedActionDefinition(),
      inputHints: null,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    } as const;
    const execute = vi.fn(async (actionId: string, _input: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: definition } }
      : { ok: true as const, result: { ok: true } });
    const resolveSessionTarget = vi.fn();
    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--session-id', 'opaque-plugin-value'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute, resolveSessionTarget })) as any,
    });
    expect(resolveSessionTarget).not.toHaveBeenCalled();
    expect(execute.mock.calls[1]?.[1]).toMatchObject({ input: { sessionId: 'opaque-plugin-value' } });
  });

  it('keeps whole-input JSON usable and rejects a duplicated field source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (_actionId: string, _input: unknown) => ({ ok: true, result: { sessions: [] } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    await handleActionsCommand(
      ['invoke', 'session.list', '--input-json', '{"limit":7}', '--json'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: createExecutorFn as any,
      },
    );
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ limit: 7 });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('api_token'));
    await handleActionsCommand(
      ['invoke', 'session.list', '--input-json', '{"limit":7}', '--limit', '9'],
      { readCredentialsFn, createExecutorFn: vi.fn() as any },
    );
    expect(process.exitCode).toBe(1);
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it('rejects an unknown Action field before reading credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('api_token'));
    await handleActionsCommand(['invoke', 'session.list', '--not-a-field', 'x'], {
      readCredentialsFn, createExecutorFn: vi.fn() as any,
    });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('discovers a contributed Action and compiles its canonical fields before invocation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (actionId: string, _input: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { ok: true } });
    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--note', 'hi', '--mode', 'safe', '--config-json', '{"retries":2}', '--json'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );
    expect(execute.mock.calls[0]).toEqual([
      'action.spec.get',
      { id: 'example.plugin/actions/do-work' },
      expect.objectContaining({ surface: 'cli' }),
    ]);
    const [actionId, input] = execute.mock.calls[1]!;
    expect(actionId).toBe('action.invoke');
    expect(input).toMatchObject({
      action: { pluginId: 'example.plugin', localId: 'do-work' },
      input: { note: 'hi', mode: 'safe', config: { retries: 2 } },
    });
  });

  it('rejects a contributed unknown field after discovery and before invocation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true as const, result: { actionSpec: contributedActionDefinition() } }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--bogus', 'x'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'action.spec.get',
      { id: 'example.plugin/actions/do-work' },
      expect.objectContaining({ surface: 'cli' }),
    );
    expect(process.exitCode).toBe(1);
  });

  it('validates contributed field input against the discovered canonical schema before invocation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true as const, result: { actionSpec: contributedActionDefinition() } }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--note', 'hello', '--mode', 'unknown'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('rejects a duplicated contributed field source instead of silently overwriting the JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { ok: true } });

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"from-json"}', '--note', 'from-flag'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );
    // Discovery ran; the invocation did not, and neither source silently won.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"from-json"}', '--mode', 'safe'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );
    expect(execute.mock.calls[2]?.[0]).toBe('action.invoke');
    expect(execute.mock.calls[2]?.[1]).toMatchObject({
      input: { note: 'from-json', mode: 'safe' },
    });
  });

  it('rejects a mismatched contributed discovery response before invocation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: {
        actionSpec: { ...contributedActionDefinition(), id: 'example.plugin/actions/different' },
      },
    }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"hello"}'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(2);
  });

  it('uses the JSON-only predecessor fallback only when action discovery is unsupported', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => actionId === 'action.spec.get'
      ? { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action:action.spec.get' }
      : { ok: true as const, result: { ok: true } });

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"legacy"}'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );

    expect(execute.mock.calls[1]).toEqual([
      'action.invoke',
      {
        action: { pluginId: 'example.plugin', localId: 'do-work' },
        input: { note: 'legacy' },
      },
      expect.objectContaining({ surface: 'cli' }),
    ]);
    expect(error.mock.calls.flat().join('\n')).toContain('legacy JSON-only');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not reinterpret a discovery denial as the legacy JSON-only fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: false as const, errorCode: 'action_disabled', error: 'Disabled by policy' }));

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--input-json', '{"note":"blocked"}'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('renders discovered contributed fields for invoke help without invoking the Action', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true as const, result: { actionSpec: contributedActionDefinition() } }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--help'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    const help = log.mock.calls.flat().join('\n');
    expect(help).toContain('happier actions invoke example.plugin/actions/do-work');
    expect(help).toContain('--note');
    expect(help).toContain('--mode');
    expect(help).toContain('safe');
    expect(help).toContain('--attempts');
    expect(help).toContain('(number)');
    expect(help).toContain('[conditionally required]');
    expect(help).toContain('1–5');
    expect(help).toContain('Safety: danger.');
    expect(help).toContain('Example input: {"note":"Review this","mode":"safe"}');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('renders a precise JSON-only help page when the runtime cannot publish the definition', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:action.spec.get',
    }));

    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--help'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    const help = log.mock.calls.flat().join('\n');
    expect(help).toContain('happier actions invoke example.plugin/actions/do-work');
    expect(help).toContain('--input-json <json>');
    expect(help).toContain('Canonical definition unavailable');
    expect(help).not.toContain('Use a query and --limit');
    expect(error.mock.calls.flat().join('\n')).toContain('legacy JSON-only');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation to both contributed discovery and invocation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const controller = new AbortController();
    const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => actionId === 'action.spec.get'
      ? { ok: true as const, result: { actionSpec: contributedActionDefinition() } }
      : { ok: true as const, result: { ok: true } });

    await handleActionsCommand(
      ['invoke', 'example.plugin/actions/do-work', '--note', 'hello'],
      {
        readCredentialsFn: async () => credentials('api_token'),
        createExecutorFn: (() => ({ execute })) as any,
      },
      controller.signal,
    );

    expect(execute.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(execute.mock.calls[1]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('classifies an unexpected dependency exception as exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleActionsCommand(['search', 'machines'], {
      readCredentialsFn: async () => { throw new Error('dependency exploded'); },
      createExecutorFn: vi.fn() as any,
    });
    expect(process.exitCode).toBe(2);
  });
});
