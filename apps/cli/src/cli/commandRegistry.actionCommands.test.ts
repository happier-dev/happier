import { describe, expect, it, vi } from 'vitest';
import {
  SHARED_SAVED_SECRET_ACTION_IDS_V1,
  TEAM_CREDENTIAL_ACTION_IDS_V1,
} from '@happier-dev/protocol';

import {
  findCommandDispatchDescriptor,
  resolveAdmittedActionCliCommand,
  resolveCommandCompletionCandidates,
} from './commandRegistry';
import { listCompiledActionCliCommands } from './actions/compiledCommands';

describe('compiled Action commands in the one command registry', () => {
  it('resolves an exact compiled leaf under an existing static root', async () => {
    const command = await resolveAdmittedActionCliCommand(['session', 'send', 'session_1', 'Hello']);
    expect(command?.path.join(' ')).toBe('session send');
    expect(command?.actionId).toBe('session.message.send');
  });

  it('leaves an unmigrated spelling to its dedicated owner', async () => {
    // `session history` is a streaming workflow, not one Action invocation, so
    // the registry must not claim it for the compiler.
    expect(await resolveAdmittedActionCliCommand(['session', 'history', 'session_1'])).toBeNull();
    expect(await resolveAdmittedActionCliCommand(['session', 'create'])).toBeNull();
    expect(await resolveAdmittedActionCliCommand(['session'])).toBeNull();
    expect(await resolveAdmittedActionCliCommand(['session', '--help'])).toBeNull();
  });

  it('resolves the root alias and the compatibility spelling to the same Action', async () => {
    const root = await resolveAdmittedActionCliCommand(['send', 'session_1', 'Hello']);
    const compatibility = await resolveAdmittedActionCliCommand(['session', 'run', 'send', 'session_1', 'run_1', 'Hi']);
    expect(root?.actionId).toBe('session.message.send');
    expect(compatibility?.actionId).toBe('session.message.send');
    expect(compatibility?.path.join(' ')).toBe('session run send');
    expect(compatibility?.deprecated?.replacement).toBe('happier send <session> <message> --run <run>');
  });

  it('registers a root the Action catalog owns end to end and dispatches its leaves', async () => {
    const identityCommands = listCompiledActionCliCommands()
      .filter((command) => command.path[0] === 'identity');
    expect(identityCommands.length).toBeGreaterThan(0);

    const leaf = identityCommands.find((command) => command.actionId.startsWith('identity.githubApps.'));
    expect(leaf, 'identity.githubApps.* declares friendly CLI paths').toBeDefined();
    expect(await resolveAdmittedActionCliCommand([...leaf!.path])).toMatchObject({
      actionId: leaf!.actionId,
    });
    // The generic Action owner supplies the handler; there is no id-specific
    // host branch and no parallel executor for these paths.
    expect(findCommandDispatchDescriptor('identity')).toMatchObject({
      command: 'identity',
      handler: expect.any(Function),
    });
  });

  it('makes the credential Action family reachable and discoverable from its generated root', async () => {
    const credentialCommands = listCompiledActionCliCommands()
      .filter((command) => command.path[0] === 'credentials');
    expect(credentialCommands.length).toBeGreaterThan(0);

    const leaf = credentialCommands.find((command) => command.actionId === 'teams.credentials.list');
    expect(leaf).toBeDefined();
    expect(await resolveAdmittedActionCliCommand([...leaf!.path])).toMatchObject({
      actionId: 'teams.credentials.list',
    });
    expect(findCommandDispatchDescriptor('credentials')).toMatchObject({
      command: 'credentials',
      handler: expect.any(Function),
    });
  });

  it('makes every Lane 10 administration intent exact-Home reachable from a discoverable root', async () => {
    const lane10ActionIds = new Set<string>([
      ...TEAM_CREDENTIAL_ACTION_IDS_V1,
      ...SHARED_SAVED_SECRET_ACTION_IDS_V1,
    ]);
    const commands = listCompiledActionCliCommands().filter((command) => (
      lane10ActionIds.has(command.actionId)
    ));

    expect(new Set(commands.map((command) => command.actionId))).toEqual(new Set([
      ...TEAM_CREDENTIAL_ACTION_IDS_V1,
      ...SHARED_SAVED_SECRET_ACTION_IDS_V1,
    ]));
    expect(commands.every((command) => command.acceptsServerId && command.requiresServerId)).toBe(true);
    expect(commands.filter((command) => command.actionId.startsWith('teams.credentials.'))
      .every((command) => command.path[0] === 'credentials')).toBe(true);
    expect(commands.filter((command) => command.actionId.startsWith('secrets.shared.'))
      .every((command) => command.path[0] === 'secrets' && command.path[1] === 'shared')).toBe(true);

    for (const command of commands) {
      expect(await resolveAdmittedActionCliCommand([...command.path])).toMatchObject({
        actionId: command.actionId,
      });
    }
    expect(findCommandDispatchDescriptor('secrets')).toMatchObject({
      command: 'secrets',
      handler: expect.any(Function),
    });
    expect(await resolveCommandCompletionCandidates(['credentials', ''])).toEqual(
      expect.arrayContaining(['list', 'create', 'update', 'delete', 'test', 'activity', 'limits', 'usage', 'external-keys']),
    );
    expect(await resolveCommandCompletionCandidates(['secrets', 'shared', ''])).toEqual(
      expect.arrayContaining(['list', 'create', 'promote', 'grants', 'update', 'delete']),
    );
  });

  it('makes every Machine Pool intent reachable from the generated exact-Home command tree', async () => {
    const expected = new Map([
      ['machines pools list', 'machines.pools.list'],
      ['machines pools get', 'machines.pools.get'],
      ['machines pools create', 'machines.pools.create'],
      ['machines pools update', 'machines.pools.update'],
      ['machines pools delete', 'machines.pools.delete'],
      ['machines pools resolve', 'machines.pools.resolve'],
    ]);
    const commands = listCompiledActionCliCommands()
      .filter((command) => command.path[0] === 'machines' && command.path[1] === 'pools');

    expect(new Map(commands.map((command) => [command.path.join(' '), command.actionId])))
      .toEqual(expected);
    for (const [path, actionId] of expected) {
      expect(await resolveAdmittedActionCliCommand(path.split(' '))).toMatchObject({ actionId });
    }
    expect(findCommandDispatchDescriptor('machines')).toMatchObject({
      command: 'machines',
      handler: expect.any(Function),
    });
    expect(await resolveCommandCompletionCandidates(['machines', 'pools', ''])).toEqual(
      expect.arrayContaining(['list', 'get', 'create', 'update', 'delete', 'resolve']),
    );
  });

  it('routes actions search/get through compiled declarations while retaining invoke on the host', async () => {
    expect(await resolveAdmittedActionCliCommand(['actions', 'search', 'machine', 'actions']))
      .toMatchObject({ actionId: 'action.spec.search' });
    expect(await resolveAdmittedActionCliCommand(['actions', 'get', 'machines.list']))
      .toMatchObject({ actionId: 'action.spec.get' });
    expect(await resolveAdmittedActionCliCommand(['actions', 'invoke', 'machines.list']))
      .toBeNull();
    expect(await resolveCommandCompletionCandidates(['actions', ''])).toEqual(
      expect.arrayContaining(['get', 'search']),
    );
    expect(await resolveCommandCompletionCandidates(['actions', 'search', '--'])).toEqual(
      expect.arrayContaining(['--limit', '--query', '--server-id']),
    );
  });

  it('routes memory document commands through the generated Account Action leaves', async () => {
    for (const leaf of ['remember', 'update', 'forget', 'read', 'list']) {
      expect(await resolveAdmittedActionCliCommand(['memory', leaf])).toMatchObject({
        actionId: `memory.${leaf}`,
        path: ['memory', leaf],
      });
    }
    expect(findCommandDispatchDescriptor('memory')).toMatchObject({
      command: 'memory',
      handler: expect.any(Function),
    });
    expect(await resolveCommandCompletionCandidates(['memory', ''])).toEqual(
      expect.arrayContaining(['remember', 'update', 'forget', 'read', 'list']),
    );
  });

  it('completes compiled command paths, flags and enum values from the same descriptor', async () => {
    expect(await resolveCommandCompletionCandidates(['session', 'se'])).toContain('send');
    expect(await resolveCommandCompletionCandidates(['identity', ''])).toContain('github-apps');
    const sendFlags = await resolveCommandCompletionCandidates(['session', 'send', 'session_1', 'Hello', '--']);
    expect(sendFlags).toContain('--run');
    expect(sendFlags).toContain('--timeout');
    expect(sendFlags).toContain('--input-json');
  });

  it('does not suggest a scalar flag that was already supplied', async () => {
    const candidates = await resolveCommandCompletionCandidates([
      'session', 'send', 'session_1', 'Hello', '--run', 'run_1', '--',
    ]);
    expect(candidates).not.toContain('--run');
    expect(candidates).toContain('--timeout');
  });

  it('resolves dynamic Action field choices through the injected canonical options resolver', async () => {
    const resolveDynamicOptions = vi.fn(async () => ['codex', 'claude']);
    const candidates = await resolveCommandCompletionCandidates(
      ['session', 'run', 'start', 'session_1', '--agent', 'co'],
      { resolveDynamicOptions },
    );

    expect(candidates).toContain('codex');
    expect(candidates).not.toContain('claude');
    expect(resolveDynamicOptions).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'execution.run.start',
      fieldPath: 'agent',
      optionsSourceId: 'execution.backends.enabled',
      query: 'co',
      draftInput: expect.objectContaining({ sessionId: 'session_1' }),
    }));
  });

  it('completes generic invoke fields from the discovered contributed Action definition', async () => {
    const resolveDynamicActionDefinition = vi.fn(async () => ({
      kindVersion: 1 as const,
      id: 'example.plugin/actions/do-work',
      title: 'Do work',
      description: null,
      safety: 'safe' as const,
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, api: true, plugin: true },
      inputHints: {
        title: 'Do work',
        fields: [{
          path: 'mode',
          title: 'Mode',
          widget: 'select' as const,
          options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }],
        }],
      },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { mode: { type: 'string', enum: ['safe', 'fast'] } },
      },
    }));

    const flags = await resolveCommandCompletionCandidates(
      ['actions', 'invoke', 'example.plugin/actions/do-work', '--'],
      { resolveDynamicActionDefinition },
    );
    expect(flags).toContain('--mode');
    expect(flags).toContain('--server-id');
    const afterTerminator = await resolveCommandCompletionCandidates(
      ['actions', 'invoke', 'example.plugin/actions/do-work', '--', '--server'],
      { resolveDynamicActionDefinition },
    );
    expect(afterTerminator).not.toContain('--server-id');
    expect(afterTerminator).not.toContain('--machine-id');
    expect(afterTerminator).not.toContain('--request-id');
    await expect(resolveCommandCompletionCandidates(
      ['actions', 'invoke', 'example.plugin/actions/do-work', '--mode', 'sa'],
      { resolveDynamicActionDefinition },
    )).resolves.toContain('safe');
    expect(resolveDynamicActionDefinition).toHaveBeenCalledWith(
      'example.plugin/actions/do-work',
      expect.arrayContaining(['actions', 'invoke', 'example.plugin/actions/do-work']),
    );
  });
});
