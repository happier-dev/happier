import { beforeAll, describe, expect, it } from 'vitest';

import {
  assertComposedCommandPathsAreUnambiguous,
  listCollidingAgentCommandRoots,
  ensureMergedAgentCommandRegistryLoaded,
  resolveAdmittedActionCliCommand,
} from './commandRegistry';
import { composeActionCliInput, parseActionCliCommandInput } from './actions/parseCommandInput';

describe('composed CLI command path ownership', () => {
  beforeAll(async () => {
    await ensureMergedAgentCommandRegistryLoaded();
  }, 120_000);

  it.each([
    { argv: ['workflow', 'definition', 'export'], actionId: 'workflow.definition.export' },
    { argv: ['workflow', 'definition', 'import'], actionId: 'workflow.definition.import' },
    { argv: ['mcp', 'servers', 'tools', 'example-server'], actionId: 'mcp.servers.tools.list' },
    { argv: ['mcp', 'servers', 'tools', 'list', 'example-server'], actionId: 'mcp.servers.tools.list' },
    { argv: ['mcp', 'found'], actionId: 'mcp.found.list' },
    { argv: ['mcp', 'found', 'adopt'], actionId: 'mcp.found.adopt' },
    { argv: ['mcp', 'rules'], actionId: 'mcp.rules.set' },
    { argv: ['mcp', 'rules', 'set'], actionId: 'mcp.rules.set' },
    { argv: ['skills', 'rules'], actionId: 'skills.rules.set' },
    { argv: ['skills', 'rules', 'set'], actionId: 'skills.rules.set' },
    { argv: ['session', 'capabilities', 'example-session'], actionId: 'session.capabilities.get' },
    { argv: ['session', 'capabilities', 'example-session', 'list'], actionId: 'session.capabilities.get' },
    { argv: ['session', 'capabilities', 'example-session', 'add', 'skill', 'example-skill'], actionId: 'session.capabilities.set' },
  ])('keeps the formerly colliding path $argv reachable through $actionId', async ({ argv, actionId }) => {
    await ensureMergedAgentCommandRegistryLoaded();
    expect(await resolveAdmittedActionCliCommand(argv)).toMatchObject({ actionId });
  });

  it('dispatches status reads and source-bound reason edits as separate Session leaves', async () => {
    await ensureMergedAgentCommandRegistryLoaded();
    expect(await resolveAdmittedActionCliCommand(['session', 'status', 'session_1']))
      .toMatchObject({ actionId: 'session.status.get', path: ['session', 'status'] });

    for (const [args, reason] of [
      [['--reason', 'Waiting for the build'], 'Waiting for the build'],
      [['--input-json', '{"reason":null}'], null],
    ] as const) {
      const argv = ['session', 'set-status-reason', ...args];
      const command = await resolveAdmittedActionCliCommand(argv);
      expect(command).toMatchObject({ actionId: 'session.status.set_reason', path: ['session', 'set-status-reason'] });
      if (!command) throw new Error('Status reason command was not admitted');
      const parsed = parseActionCliCommandInput(command, argv);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.message);
      const composed = composeActionCliInput({
        parsed,
        canonicalSchema: command.spec.inputSchema,
        wholeInputSchema: command.wholeInputSchema,
        callerSchema: command.callerSchema,
        bindInput: command.spec.cli?.bindInput,
        context: { actionId: command.actionId, invocationId: 'status-reason-test', commandPath: command.path, output: 'json' },
      });
      expect(composed).toMatchObject({ ok: true, input: { reason } });
      if (!composed.ok) throw new Error(composed.message);
      expect(command.spec.inputSchema.parse(composed.input)).toEqual({ reason });
    }
  });

  it('dispatches the Found list and read leaves from the real Action catalog', async () => {
    await ensureMergedAgentCommandRegistryLoaded();
    expect(await resolveAdmittedActionCliCommand(['skills', 'found', 'list', '--machine', 'machine_1']))
      .toMatchObject({ actionId: 'skills.found.list', path: ['skills', 'found', 'list'] });
    expect(await resolveAdmittedActionCliCommand(['skills', 'found', 'show', 'review', '--machine', 'machine_1']))
      .toMatchObject({ actionId: 'skills.found.read', path: ['skills', 'found', 'show'] });
    expect(await resolveAdmittedActionCliCommand(['skills', 'adopt', 'review', '--machine', 'machine_1']))
      .toMatchObject({ actionId: 'skills.found.adopt', path: ['skills', 'adopt'] });
  });

  it('rejects exact and subtree collisions across Action, static workflow, Agent, and plugin claims', () => {
    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'static', ownerId: 'session history', path: ['session', 'history'] },
      { source: 'action', ownerId: 'session.history.follow', path: ['session', 'history', 'follow'] },
    ])).toThrow(/session history.*session history follow/u);

    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'agent', ownerId: 'acme.agent', path: ['review'] },
      { source: 'plugin', ownerId: 'acme.plugin\/inspect', path: ['review', 'inspect'] },
    ])).toThrow(/review.*review inspect/u);

    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'action', ownerId: 'one', path: ['teams', 'members'] },
      { source: 'plugin', ownerId: 'two', path: ['teams', 'members'] },
    ])).toThrow(/teams members/u);
  });

  it('preserves an intentional namespace root while still rejecting terminal leaves below it', () => {
    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'static', ownerId: 'session', path: ['session'], allowsDescendants: true },
      { source: 'static', ownerId: 'session history', path: ['session', 'history'] },
      { source: 'action', ownerId: 'session.message.send', path: ['session', 'send'] },
    ])).not.toThrow();

    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'static', ownerId: 'session', path: ['session'], allowsDescendants: true },
      { source: 'static', ownerId: 'session history', path: ['session', 'history'] },
      { source: 'action', ownerId: 'session.history.follow', path: ['session', 'history', 'follow'] },
    ])).toThrow(/session history.*session history follow/u);
  });

  it('allows an explicitly composed Action family namespace without weakening unrelated leaves', () => {
    expect(() => assertComposedCommandPathsAreUnambiguous([
      {
        source: 'action',
        ownerId: 'teams.directory.sources.remove',
        path: ['teams', 'directory', 'sources', 'remove'],
        allowsDescendants: true,
      },
      {
        source: 'action',
        ownerId: 'teams.directory.sources.remove.preview',
        path: ['teams', 'directory', 'sources', 'remove', 'preview'],
      },
    ])).not.toThrow();

    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'action', ownerId: 'unrelated.remove', path: ['teams', 'members', 'remove'] },
      { source: 'action', ownerId: 'unrelated.preview', path: ['teams', 'members', 'remove', 'preview'] },
    ])).toThrow(/teams members remove/u);
  });

  it('fences every Agent declaration sharing a root instead of admitting the last one', () => {
    expect(listCollidingAgentCommandRoots([
      { cliSubcommand: 'review' },
      { cliSubcommand: 'codex' },
      { cliSubcommand: 'review' },
      { cliSubcommand: 'review' },
    ])).toEqual(['review']);
  });
});
