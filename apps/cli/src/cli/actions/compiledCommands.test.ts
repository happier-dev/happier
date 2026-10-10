import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ActionSpec } from '@happier-dev/protocol';
import { getActionSpec, listActionCliCommandDeclarations } from '@happier-dev/protocol';

import {
  compileActionCliCommandSet,
  compileActionCliCommands,
  compileActionCliFields,
  findCompiledActionCliCommand,
  listCompiledActionCliCommands,
} from './compiledCommands';
import { buildActionCliHelpModel } from './commandHelp';
import { readActionCliServerId } from './actionServerTarget';
import {
  resolveCompiledActionCliCompletionCandidates,
  resolveCompiledActionCliCompletionCandidatesWithDynamicOptions,
} from './commandCompletion';
import {
  composeActionCliInput,
  describeActionCliCommandFlags,
  listActionCliCommandFlags,
  parseActionCliCommandInput,
  parseActionCliInput,
  stripCliOwnedFlags,
  validateActionCliFlagCollisions,
} from './parseCommandInput';

const CallerSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  run: z.string().min(1).optional(),
  attempts: z.number().int().optional(),
  wait: z.boolean().optional(),
  mode: z.enum(['fast', 'careful']).optional(),
  tags: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  recipient: z.object({ kind: z.literal('execution_run'), runId: z.string() }).optional(),
}).strict();

function fixtureSpec(cli: NonNullable<ActionSpec['cli']>, overrides: Partial<ActionSpec> = {}): ActionSpec {
  return {
    id: 'session.message.send',
    title: 'Send a message',
    description: 'Send a message to a session.',
    safety: 'safe',
    placements: [],
    surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    inputSchema: CallerSchema,
    outputSchema: z.unknown(),
    cli,
    ...overrides,
  } as unknown as ActionSpec;
}

const SEND_CLI: NonNullable<ActionSpec['cli']> = {
  commands: [
    { path: ['session', 'send'], positionals: ['sessionId', 'message'], visibility: 'canonical' },
    { path: ['send'], positionals: ['sessionId', 'message'], visibility: 'alias' },
  ],
  flagAliases: [{ path: 'message', aliases: ['--prompt'] }],
} as NonNullable<ActionSpec['cli']>;

function compileFixture(cli: NonNullable<ActionSpec['cli']> = SEND_CLI, overrides: Partial<ActionSpec> = {}) {
  const spec = fixtureSpec(cli, overrides);
  return compileActionCliCommands(
    (spec.cli?.commands ?? []).map((binding) => ({ spec, binding })),
  );
}

describe('compileActionCliCommands', () => {
  it('projects the declared detached Machine selector through the shared help, completion and argv policy', () => {
    const commands = listCompiledActionCliCommands();
    const command = findCompiledActionCliCommand(['session', 'run', 'start'], commands)!;
    expect(command.transportMachineIdFlags).toEqual(['--machine-id', '--machine']);
    expect(buildActionCliHelpModel(command).cliOptions.some(row => /--machine(?:\s|,|$)/.test(row.label))).toBe(true);
    expect(resolveCompiledActionCliCompletionCandidates({ commands, committed: ['session', 'run', 'start'], prefix: '--mach' }))
      .toEqual(expect.arrayContaining(['--machine', '--machine-id']));
    expect(() => compileFixture({ ...SEND_CLI, transportMachineIdAliases: ['--prompt'] }))
      .toThrow(/collides/);
    expect(() => compileFixture({ ...SEND_CLI, transportMachineIdAliases: ['--machine'] }, {
      inputSchema: CallerSchema.extend({ machineId: z.string() }),
    })).toThrow(/semantic machineId/);
  });
  it('derives one descriptor per declared path with the declared positionals in argv order', () => {
    const [nested, root] = compileFixture();
    expect(nested?.path).toEqual(['session', 'send']);
    expect(nested?.visibility).toBe('canonical');
    expect(nested?.positionals.map((field) => field.path)).toEqual(['sessionId', 'message']);
    expect(root?.path).toEqual(['send']);
    expect(root?.visibility).toBe('alias');
  });

  it('spells fields from the caller schema and refines them with hints, not a CLI table', () => {
    const [command] = compileFixture(SEND_CLI, {
      inputHints: {
        fields: [
          { path: 'mode', title: 'Delivery mode', widget: 'select', optionsSourceId: 'delivery-modes' },
        ],
      },
    } as Partial<ActionSpec>);
    const byPath = new Map(command!.fields.map((field) => [field.path, field]));
    expect(byPath.get('sessionId')?.flag).toBe('--session-id');
    expect(byPath.get('sessionId')?.kind).toBe('string');
    expect(byPath.get('sessionId')?.required).toBe(true);
    expect(byPath.get('attempts')?.kind).toBe('integer');
    expect(byPath.get('wait')?.kind).toBe('boolean');
    expect(byPath.get('mode')?.kind).toBe('enum');
    expect(byPath.get('mode')?.choices).toEqual(['fast', 'careful']);
    expect(byPath.get('mode')?.title).toBe('Delivery mode');
    expect(byPath.get('mode')?.optionsSourceId).toBe('delivery-modes');
    expect(byPath.get('tags')?.kind).toBe('string_list');
    expect(byPath.get('recipient')?.kind).toBe('json');
    expect(byPath.get('message')?.aliases).toEqual(['--prompt']);
  });

  it('resolves the longest declared path that prefixes the typed words', () => {
    const commands = compileFixture();
    expect(findCompiledActionCliCommand(['session', 'send', 'sess-1'], commands)?.path)
      .toEqual(['session', 'send']);
    expect(findCompiledActionCliCommand(['send', 'sess-1'], commands)?.path).toEqual(['send']);
    expect(findCompiledActionCliCommand(['session', 'history'], commands)).toBeNull();
  });

  it('skips only the spec whose input schema has no JSON Schema projection and keeps every other command', () => {
    // One Action whose schema the JSON Schema projection cannot represent must
    // not take down the whole compiled CLI surface: an unrelated command a user
    // types has nothing to do with it.
    const unrepresentable = fixtureSpec(
      { commands: [{ path: ['workflow', 'run'], positionals: [], visibility: 'canonical' }] } as NonNullable<ActionSpec['cli']>,
      {
        id: 'workflow.run' as ActionSpec['id'],
        inputSchema: z.object({ recipe: z.custom<{ kind: string }>(() => true) }).strict(),
      } as Partial<ActionSpec>,
    );
    const healthy = fixtureSpec(SEND_CLI);
    const declarations = [
      { spec: unrepresentable, binding: unrepresentable.cli!.commands[0]! },
      ...healthy.cli!.commands.map((binding) => ({ spec: healthy, binding })),
    ] as ReturnType<typeof listActionCliCommandDeclarations>;

    const compiled = compileActionCliCommandSet(declarations);
    expect(compiled.commands.map((command) => command.path.join(' ')))
      .toEqual(['session send', 'send']);
    expect(compiled.diagnostics).toEqual([{
      code: 'action_cli_command_uncompilable',
      actionId: 'workflow.run',
      path: ['workflow', 'run'],
      reason: expect.stringContaining('Custom types cannot be represented in JSON Schema'),
    }]);
    expect(compileActionCliCommands(declarations).map((command) => command.actionId))
      .toEqual(['session.message.send', 'session.message.send']);
  });

  it('still fails loudly when the declaration itself is mis-authored', () => {
    const spec = fixtureSpec({
      commands: [{
        path: ['session', 'send'],
        positionals: ['sessionId'],
        variadicPositional: 'absent',
        visibility: 'canonical',
      }],
    } as NonNullable<ActionSpec['cli']>);
    expect(() => compileActionCliCommands(
      (spec.cli?.commands ?? []).map((binding) => ({ spec, binding })) as ReturnType<typeof listActionCliCommandDeclarations>,
    )).toThrow(/variadic positional absent/);
  });

  it('gives an Action without a friendly path its ordinary fields but no command', () => {
    const spec = getActionSpec('action.options.resolve');
    expect(spec).toBeTruthy();
    expect(spec?.cli).toBeUndefined();
    const compiled = compileActionCliFields(spec!);
    expect(compiled.fields.length).toBeGreaterThan(0);
    expect(compileActionCliCommands([]).length).toBe(0);
  });

  it('projects a caller field away from a declared CLI transport selector', () => {
    const serverCli = {
      ...SEND_CLI,
      acceptsServerId: true as const,
    };
    const [command] = compileFixture(serverCli, {
      inputSchema: CallerSchema.extend({ serverId: z.string().optional() }),
    });
    expect(command?.fields.find((field) => field.path === 'serverId')?.flag)
      .toBe('--action-server-id');
    expect(command?.acceptsServerId).toBe(true);
  });

  it('projects canonical fields away from every compiler-owned flag before registration', () => {
    for (const [field, schema, expectedFlag] of [
      ['input', z.record(z.string(), z.unknown()), '--action-input'],
      ['json', z.string(), '--action-json'],
      ['help', z.string(), '--action-help'],
    ] as const) {
      const [command] = compileFixture(SEND_CLI, {
        inputSchema: CallerSchema.extend({ [field]: schema.optional() }),
      });
      expect(command?.fields.find((candidate) => candidate.path === field)?.flag, field)
        .toBe(expectedFlag);
    }

    const [neighboring] = compileFixture(SEND_CLI, {
      inputSchema: CallerSchema.extend({
        input: z.record(z.string(), z.unknown()).optional(),
        inputJson: z.string().optional(),
      }),
    });
    expect(neighboring?.fields.find((field) => field.path === 'input')?.flag)
      .toBe('--action-input');
    expect(neighboring?.fields.find((field) => field.path === 'inputJson')?.flag)
      .toBe('--action-input-json-field');
    expect(parseActionCliCommandInput(neighboring!, [
      'session', 'send', 'sess-1', 'Hello',
      '--action-input-json', '{"nested":true}',
      '--action-input-json-field', 'literal',
    ])).toEqual({
      ok: true,
      canonicalBase: null,
      callerOverlay: {
        sessionId: 'sess-1',
        message: 'Hello',
        input: { nested: true },
        inputJson: 'literal',
      },
    });

    const [base] = compileFixture();
    const message = base!.fields.find((field) => field.path === 'message')!;
    expect(validateActionCliFlagCollisions({
      fields: [{ ...message, aliases: ['-h'] }],
      positionals: [],
    })).toMatchObject({
      ok: false,
      flag: '-h',
      fieldPath: 'message',
      conflictingFieldPath: null,
    });
  });

  it('reserves active exact-Machine routing without rejecting a semantic machine field', () => {
    expect(() => compileFixture({
      ...SEND_CLI,
      flagAliases: [{ path: 'message', aliases: ['--machine-id'] }],
    })).toThrow(/--machine-id.*CLI-owned flag/u);

    const [semanticMachine] = compileFixture(SEND_CLI, {
      inputSchema: CallerSchema.extend({ machineId: z.string().min(1) }),
    });
    expect(semanticMachine?.routesByTransportMachineId).toBe(false);
    expect(semanticMachine?.fields.find((field) => field.path === 'machineId')?.flag)
      .toBe('--machine-id');
  });

  it('publishes session.list exact-Home selection through compiled help and completion', () => {
    const command = findCompiledActionCliCommand(['session', 'list']);
    expect(command).not.toBeNull();
    expect(command?.acceptsServerId).toBe(true);
    expect(buildActionCliHelpModel(command!).cliOptions.map((row) => row.label))
      .toContain('--server-id <serverId>');
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'list'],
      prefix: '--server',
    })).toContain('--server-id');
  });

  it('compiles the shared send --wait help as message completion, never Session idle', () => {
    // One compiled command serves the main send and the targeted `--run` send,
    // so its --wait help cannot claim parent-Session idle semantics (Lane 05
    // plan 04 §10.2: wait settles the admitted message's own turn).
    const command = findCompiledActionCliCommand(['session', 'send']);
    expect(command).not.toBeNull();
    const wait = buildActionCliHelpModel(command!).options.find((row) => row.label.startsWith('--wait'));
    expect(wait?.description).toContain('Wait for message completion (optional)');
    expect(wait?.description.toLowerCase()).not.toContain('idle');
  });

  it('compiles every Machine Pool command with exact-Home routing and projected payload input', () => {
    const commands = compileActionCliCommands(
      listActionCliCommandDeclarations().filter(({ spec }) => spec.id.startsWith('machines.pools.')),
    );
    expect(commands.map((command) => command.path)).toEqual([
      ['machines', 'pools', 'list'],
      ['machines', 'pools', 'get'],
      ['machines', 'pools', 'create'],
      ['machines', 'pools', 'update'],
      ['machines', 'pools', 'delete'],
      ['machines', 'pools', 'resolve'],
    ]);
    expect(commands.every((command) => command.acceptsServerId)).toBe(true);
    const create = commands.find((command) => command.actionId === 'machines.pools.create');
    expect(create?.fields.map((field) => [field.path, field.flag, field.kind])).toEqual([
      ['poolId', '--pool-id', 'string'],
      ['name', '--name', 'string'],
      ['description', '--description', 'string'],
      ['members', '--members', 'json'],
    ]);
  });

  it('requires an exact Home for every Team identity and directory command', () => {
    const commands = listCompiledActionCliCommands().filter((command) => (
      command.actionId.startsWith('teams.identity.')
      || command.actionId.startsWith('teams.directory.')
      || command.actionId.startsWith('teams.externalGroupBindings.')
    ));

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.acceptsServerId)).toBe(true);
    expect(commands.every((command) => command.requiresServerId)).toBe(true);
    expect(buildActionCliHelpModel(commands[0]!).cliOptions).toContainEqual({
      label: '--server-id <serverId>',
      description: 'Use credentials and endpoint for an exact saved Home [required]',
    });
  });
});

describe('Project worker exact-Home CLI projection', () => {
  it.each([
    ['projects.worker.preferences.get', { workspace: { serverId: 'home-b', refId: 'checkout' } }],
    ['machines.worker.policy.get', { serverId: 'home-b', machineId: 'worker-a' }],
  ] as const)('accepts an inactive Home selector for %s without changing the qualified Action input', (id, input) => {
    const spec = getActionSpec(id);
    const binding = spec.cli!.commands[0]!;
    const [command] = compileActionCliCommands([{ spec, binding }]);
    expect(command).toBeDefined();
    const argv = [...binding.path, '--server-id', 'home-b', '--input-json', JSON.stringify(input)];
    expect(parseActionCliCommandInput(command!, argv)).toMatchObject({ ok: true, canonicalBase: input });
    expect(readActionCliServerId(argv, command!.acceptsServerId)).toBe('home-b');
  });
});

describe('parseActionCliCommandInput', () => {
  const [command] = compileFixture();

  function parse(argv: readonly string[]) {
    return parseActionCliCommandInput(command!, argv);
  }

  function friendly(callerOverlay: Readonly<Record<string, unknown>>) {
    return { ok: true, canonicalBase: null, callerOverlay };
  }

  it('maps positionals and flags to the caller shape exactly once', () => {
    const result = parse(['session', 'send', 'sess-1', 'Hello', '--run', 'run-9', '--attempts', '3', '--wait']);
    expect(result).toEqual(friendly({
      sessionId: 'sess-1', message: 'Hello', run: 'run-9', attempts: 3, wait: true,
    }));
  });

  it('accepts inline values, negated booleans, repeated lists and field JSON', () => {
    const result = parse([
      'session', 'send', 'sess-1', 'Hello',
      '--mode=careful', '--no-wait', '--tags', 'a', '--tags', 'b',
      '--recipient-json', '{"kind":"execution_run","runId":"run-1"}',
    ]);
    expect(result).toEqual(friendly({
        sessionId: 'sess-1', message: 'Hello', mode: 'careful', wait: false,
        tags: ['a', 'b'], recipient: { kind: 'execution_run', runId: 'run-1' },
    }));
  });

  it('applies declared list separators and selection ceilings without retaining delimiter text', () => {
    const [hinted] = compileFixture(SEND_CLI, {
      inputHints: {
        fields: [
          { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
          {
            path: 'labels', title: 'Labels', widget: 'multiselect', maxSelections: 3,
            options: [
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
            { value: 'three', label: 'Three' },
            ],
          },
        ],
      },
    });
    expect(parseActionCliCommandInput(hinted!, [
      'session', 'send', 'sess-1', 'Hello', '--tags', 'one,two', '--tags', 'three',
    ])).toEqual({
      ok: true,
      canonicalBase: null,
      callerOverlay: { sessionId: 'sess-1', message: 'Hello', tags: ['one', 'two', 'three'] },
    });
    expect(parseActionCliCommandInput(hinted!, [
      'session', 'send', 'sess-1', 'Hello',
      '--labels', 'one', '--labels', 'two', '--labels', 'three', '--labels', 'one',
    ])).toMatchObject({ ok: false, message: expect.stringContaining('at most 3') });
  });

  it('enforces declared conditional visibility, requiredness and disabled state from the final draft', () => {
    const [hinted] = compileFixture(SEND_CLI, {
      inputHints: {
        fields: [
          { path: 'run', title: 'Run', widget: 'text', visibleWhen: { op: 'eq', path: 'mode', value: 'careful' } },
          { path: 'attempts', title: 'Attempts', widget: 'integer', requiredWhen: { op: 'eq', path: 'mode', value: 'careful' } },
          { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma', disabledWhen: { op: 'eq', path: 'mode', value: 'fast' } },
        ],
      },
    });
    expect(parseActionCliCommandInput(hinted!, [
      'session', 'send', 'sess-1', 'Hello', '--mode', 'fast', '--run', 'run-1',
    ])).toMatchObject({ ok: false, message: expect.stringContaining('--run is not available') });
    expect(parseActionCliCommandInput(hinted!, [
      'session', 'send', 'sess-1', 'Hello', '--mode', 'fast', '--tags', 'one',
    ])).toMatchObject({ ok: false, message: expect.stringContaining('--tags is disabled') });
    expect(parseActionCliCommandInput(hinted!, [
      'session', 'send', 'sess-1', 'Hello', '--mode', 'careful',
    ])).toMatchObject({ ok: false, message: expect.stringContaining('--attempts is required') });
    expect(parseActionCliCommandInput(hinted!, [
      'session', 'send', 'sess-1', 'Hello', '--mode', 'careful', '--attempts', '2', '--run', 'run-1',
    ])).toMatchObject({ ok: true });
  });

  it('enforces numeric ranges projected from the caller schema', () => {
    const [ranged] = compileFixture(SEND_CLI, {
      inputSchema: CallerSchema.extend({ attempts: z.number().int().min(1).max(5).optional() }),
    });
    expect(parseActionCliCommandInput(ranged!, ['session', 'send', 'sess-1', 'Hello', '--attempts', '0']))
      .toMatchObject({ ok: false, message: expect.stringContaining('at least 1') });
    expect(parseActionCliCommandInput(ranged!, ['session', 'send', 'sess-1', 'Hello', '--attempts', '6']))
      .toMatchObject({ ok: false, message: expect.stringContaining('at most 5') });
    expect(parseActionCliCommandInput(ranged!, ['session', 'send', 'sess-1', 'Hello', '--attempts-json', '0']))
      .toMatchObject({ ok: false, message: expect.stringContaining('at least 1') });
  });

  it('accepts an established alias for the same field', () => {
    expect(parse(['session', 'send', 'sess-1', '--prompt', 'Hello']))
      .toEqual(friendly({ sessionId: 'sess-1', message: 'Hello' }));
  });

  it('overlays distinct fields onto whole-input JSON', () => {
    expect(parse(['session', 'send', '--input-json', '{"sessionId":"sess-1"}', '--message', 'Hello']))
      .toEqual({
        ok: true,
        canonicalBase: { sessionId: 'sess-1' },
        callerOverlay: { message: 'Hello' },
      });
  });

  it('does not apply friendly required-field hints to a canonical whole input', () => {
    expect(parse(['session', 'send', '--input-json', JSON.stringify({
      sessionId: 'sess-1',
      canonicalMessage: { parts: [{ t: 'text', text: 'Hello' }] },
    })])).toEqual({
      ok: true,
      canonicalBase: {
        sessionId: 'sess-1',
        canonicalMessage: { parts: [{ t: 'text', text: 'Hello' }] },
      },
      callerOverlay: {},
    });
  });

  it('rejects a duplicate source in either order rather than choosing a winner', () => {
    for (const argv of [
      ['session', 'send', 'sess-1', 'Hello', '--message', 'other'],
      ['session', 'send', '--input-json', '{"message":"a"}', '--message', 'b'],
      ['session', 'send', '--message', 'b', '--input-json', '{"message":"a"}'],
      ['session', 'send', '--input-json', '{"tags":["a"]}', '--tags', 'b'],
      ['session', 'send', '--prompt', 'a', '--message', 'b'],
    ]) {
      const result = parse(argv);
      expect(result.ok, argv.join(' ')).toBe(false);
      expect(result.ok ? '' : result.message).toMatch(/not both/u);
    }
  });

  it('fails on unknown flags, missing values, extra positionals and malformed JSON', () => {
    expect(parse(['session', 'send', 'sess-1', 'Hello', '--nope', 'x']))
      .toMatchObject({ ok: false, message: 'Unknown option: --nope' });
    expect(parse(['session', 'send', 'sess-1', 'Hello', '--run']))
      .toMatchObject({ ok: false, message: 'Option --run requires a value.' });
    expect(parse(['session', 'send', 'sess-1', 'Hello', 'surplus']))
      .toMatchObject({ ok: false, message: 'Unexpected argument: surplus' });
    expect(parse(['session', 'send', 'sess-1', 'Hello', '--recipient-json', '{']))
      .toMatchObject({ ok: false, message: 'Invalid --recipient-json: expected JSON.' });
    expect(parse(['session', 'send', 'sess-1', 'Hello', '--wait=yes']))
      .toMatchObject({ ok: false, message: 'Option --wait does not accept a value.' });
    expect(parse(['session', 'send', 'sess-1', 'Hello', '--attempts', 'many']))
      .toMatchObject({ ok: false, message: 'Invalid --attempts: expected an integer.' });
  });

  it('preserves message bytes and lets `--` protect flag-looking literals', () => {
    const literal = '  spaced $(touch x); rm & | < > "q" \\ 🙂 中文 \n ';
    expect(parse(['session', 'send', 'sess-1', literal]))
      .toEqual(friendly({ sessionId: 'sess-1', message: literal }));
    expect(parse(['session', 'send', 'sess-1', '--', '--not-a-flag']))
      .toEqual(friendly({ sessionId: 'sess-1', message: '--not-a-flag' }));
  });

  it('reads a negative number as the flag value, not as a new flag', () => {
    expect(parse(['session', 'send', 'sess-1', 'Hello', '--attempts', '-3']))
      .toEqual(friendly({ sessionId: 'sess-1', message: 'Hello', attempts: -3 }));
  });

  it('collects every trailing word for one declared variadic positional', () => {
    const [variadic] = compileFixture({
      commands: [{
        path: ['actions', 'search'],
        positionals: ['sessionId'],
        variadicPositional: 'tags',
        visibility: 'canonical',
      }],
    } as NonNullable<ActionSpec['cli']>);
    expect(parseActionCliCommandInput(
      variadic!,
      ['actions', 'search', 'catalog', 'machine', 'actions'],
    )).toEqual({
      ok: true,
      canonicalBase: null,
      callerOverlay: { sessionId: 'catalog', tags: ['machine', 'actions'] },
    });
    expect(buildActionCliHelpModel(variadic!).usage).toContain('<tags...>');
  });
});

describe('one descriptor feeds parsing, help and completion', () => {
  const [command] = compileFixture();

  it('documents exactly the flags the parser accepts', () => {
    const help = buildActionCliHelpModel(command!);
    const accepted = new Set(listActionCliCommandFlags(command!));
    const documented = help.options.flatMap((row) => (
      row.label.split(', ').map((entry) => entry.split(' ')[0]!)
    ));
    expect(documented.length).toBeGreaterThan(0);
    for (const flag of documented) expect(accepted.has(flag), flag).toBe(true);
    // A positional also documents its flag spellings, so nothing the parser
    // accepts is invisible in help.
    expect(help.positionals.map((row) => row.label)).toEqual([
      '<sessionId>, --session-id',
      '<message>, --message, --prompt',
    ]);
    for (const row of help.positionals) {
      for (const entry of row.label.split(', ').filter((value) => value.startsWith('--'))) {
        expect(accepted.has(entry), entry).toBe(true);
      }
    }
    expect(help.usage).toBe('happier session send <sessionId> <message> [options]');
  });

  it('changes help and completion when the Action declaration changes, with no CLI edit', () => {
    const [renamed] = compileFixture(SEND_CLI, {
      inputHints: {
        fields: [{
          path: 'mode', title: 'Delivery mode', widget: 'select',
          options: [{ value: 'urgent', label: 'Urgent' }],
        }],
      },
    });
    expect(buildActionCliHelpModel(renamed!).options.some((row) => row.description.includes('Delivery mode')))
      .toBe(true);
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', '--mode'], prefix: '', commands: [renamed!],
    })).toEqual(['urgent']);
  });

  it('delegates dynamic choices to the canonical option resolver with parsed draft input', async () => {
    const [command] = compileFixture(SEND_CLI, {
      inputHints: {
        fields: [{
          path: 'mode', title: 'Delivery mode', widget: 'select',
          optionsSourceId: 'delivery-modes',
        }],
      },
    });
    const calls: unknown[] = [];
    expect(await resolveCompiledActionCliCompletionCandidatesWithDynamicOptions({
      committed: ['session', 'send', 'sess-1', '--tags', 'release', '--mode'],
      prefix: 'c',
      commands: [command!],
      resolveDynamicOptions: async (request) => {
        calls.push(request);
        return ['careful', 'fast'];
      },
    })).toEqual(['careful']);
    expect(calls).toEqual([expect.objectContaining({
      actionId: 'session.message.send',
      fieldPath: 'mode',
      optionsSourceId: 'delivery-modes',
      draftInput: { sessionId: 'sess-1', tags: ['release'] },
      committedArgv: ['sess-1', '--tags', 'release', '--mode'],
      acceptsServerId: false,
    })]);

    expect(await resolveCompiledActionCliCompletionCandidatesWithDynamicOptions({
      committed: ['session', 'send', 'sess-1'],
      prefix: '--mode=ca',
      commands: [command!],
      resolveDynamicOptions: async () => ['careful', 'fast'],
    })).toEqual(['--mode=careful']);
  });

  it('completes path segments, then flags, then static enum values', () => {
    const commands = compileFixture();
    expect(resolveCompiledActionCliCompletionCandidates({ committed: ['session'], prefix: 's', commands }))
      .toEqual(['send']);
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', '--mode'], prefix: 'c', commands,
    })).toEqual(['careful']);
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send'], prefix: '--mode=ca', commands,
    })).toEqual(['--mode=careful']);
    const flags = resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send'], prefix: '--r', commands,
    });
    expect(flags).toContain('--run');
    expect(flags).toContain('--recipient-json');
  });

  it('stops suggesting a scalar flag once supplied but keeps a repeatable one', () => {
    const commands = compileFixture();
    const candidates = resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', '--run', 'run-1', '--tags', 'a'], prefix: '--', commands,
    });
    expect(candidates).not.toContain('--run');
    expect(candidates).toContain('--tags');

    const afterListJson = resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', '--tags-json', '["a"]'], prefix: '--', commands,
    });
    expect(afterListJson).not.toContain('--tags');
    expect(afterListJson).not.toContain('--tags-json');
  });

  it('does not suggest a scalar flag already supplied positionally or by whole-input JSON', () => {
    const commands = listCompiledActionCliCommands();
    expect(resolveCompiledActionCliCompletionCandidates({
      commands, committed: ['send', 'session_1', 'Hello'], prefix: '--mess',
    })).not.toContain('--message');
    expect(resolveCompiledActionCliCompletionCandidates({
      commands, committed: ['send', '--input-json', '{"sessionId":"session_1","message":"Hello"}'], prefix: '--mess',
    })).not.toContain('--message');
    // Neighbor: a field nobody supplied yet is still offered.
    expect(resolveCompiledActionCliCompletionCandidates({
      commands, committed: ['send', 'session_1'], prefix: '--mess',
    })).toContain('--message');
  });

  it('suppresses conditionally unavailable fields and list flags at their declared selection ceiling', () => {
    const [hinted] = compileFixture(SEND_CLI, {
      inputSchema: CallerSchema.extend({ attempts: z.number().int().min(1).max(5).optional() }),
      inputHints: {
        fields: [
          { path: 'run', title: 'Run', widget: 'text', visibleWhen: { op: 'eq', path: 'mode', value: 'careful' } },
          { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
          {
            path: 'labels', title: 'Labels', widget: 'multiselect', maxSelections: 2,
            options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }],
          },
        ],
      },
    });
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', 'sess-1', 'Hello', '--mode', 'fast'], prefix: '--r', commands: [hinted!],
    })).not.toContain('--run');
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', 'sess-1', 'Hello', '--mode', 'careful'], prefix: '--r', commands: [hinted!],
    })).toContain('--run');
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', 'sess-1', 'Hello', '--labels', 'one', '--labels', 'two'], prefix: '--', commands: [hinted!],
    })).not.toContain('--labels');
  });

  it('completes the current separated list value through the canonical dynamic option resolver', async () => {
    const [hinted] = compileFixture(SEND_CLI, {
      inputHints: {
        fields: [{
          path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma',
          optionsSourceId: 'delivery-tags',
        }],
      },
    });
    const calls: unknown[] = [];
    expect(await resolveCompiledActionCliCompletionCandidatesWithDynamicOptions({
      committed: ['session', 'send', 'sess-1', 'Hello', '--tags'],
      prefix: 'one,t',
      commands: [hinted!],
      resolveDynamicOptions: async (request) => {
        calls.push(request);
        return ['two', 'three'];
      },
    })).toEqual(['one,three', 'one,two']);
    expect(calls).toEqual([expect.objectContaining({
      fieldPath: 'tags', optionsSourceId: 'delivery-tags', query: 't',
    })]);
  });

  it('documents declared list, conditional and numeric constraints from the compiled fields', () => {
    const [hinted] = compileFixture(SEND_CLI, {
      inputSchema: CallerSchema.extend({ attempts: z.number().int().min(1).max(5).optional() }),
      inputHints: {
        fields: [
          { path: 'run', title: 'Run', widget: 'text', visibleWhen: { op: 'eq', path: 'mode', value: 'careful' } },
          { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
          {
            path: 'labels', title: 'Labels', widget: 'multiselect', maxSelections: 2,
            options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }],
          },
        ],
      },
    });
    const help = buildActionCliHelpModel(hinted!);
    expect(help.options.find((row) => row.label.startsWith('--attempts'))?.description)
      .toContain('1–5');
    expect(help.options.find((row) => row.label.startsWith('--tags'))?.description)
      .toContain('comma-separated');
    expect(help.options.find((row) => row.label.startsWith('--labels'))?.description)
      .toContain('at most 2');
    expect(help.options.find((row) => row.label.startsWith('--run'))?.description)
      .toContain('conditionally available');
  });

  it('treats every spelling of one scalar field as used and stops at the argv terminator', () => {
    const commands = compileFixture();
    const afterAlias = resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', '--prompt', 'Hello'], prefix: '--', commands,
    });
    expect(afterAlias).not.toContain('--prompt');
    expect(afterAlias).not.toContain('--message');
    expect(afterAlias).not.toContain('--message-json');

    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', 'sess-1', '--'], prefix: '--h', commands,
    })).toEqual([]);

    const [exactHome] = compileFixture({ ...SEND_CLI, acceptsServerId: true });
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['session', 'send', 'sess-1', '--', '--literal'],
      prefix: '--server',
      commands: [exactHome!],
    })).toEqual([]);
  });
});

describe('Action CLI aliases of JSON fields', () => {
  function compileWithJsonAlias() {
    const spec = fixtureSpec({
      ...SEND_CLI,
      flagAliases: [
        { path: 'message', aliases: ['--prompt'] },
        { path: 'recipient', aliases: ['--recipient'] },
      ],
    });
    return compileActionCliCommands((spec.cli?.commands ?? []).map((binding) => ({ spec, binding })))[0]!;
  }

  it('parses a declared alias of a JSON field as the same JSON form', () => {
    const command = compileWithJsonAlias();
    const recipient = command.fields.find((field) => field.path === 'recipient');
    expect(recipient?.kind).toBe('json');

    const parsed = parseActionCliCommandInput(command, [
      ...command.path,
      '--session-id', 'sess-1',
      '--message', 'hi',
      '--recipient', '{"kind":"execution_run","runId":"run-1"}',
    ]);
    expect(parsed).toMatchObject({
      ok: true,
      callerOverlay: {
        sessionId: 'sess-1',
        message: 'hi',
        recipient: { kind: 'execution_run', runId: 'run-1' },
      },
    });
    expect(listActionCliCommandFlags(command)).toContain('--recipient');
  });

  it('derives JSON field aliases into help and completion as well as parsing', () => {
    const command = compileWithJsonAlias();

    expect(buildActionCliHelpModel(command).options).toContainEqual(expect.objectContaining({
      label: expect.stringContaining('--recipient <json>'),
    }));
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: [...command.path],
      prefix: '--rec',
      commands: [command],
    })).toContain('--recipient');
  });

  it('collision-checks the aliases of a JSON field like any other spelling', () => {
    const [command] = compileFixture();
    const recipient = command!.fields.find((field) => field.path === 'recipient');
    expect(recipient?.kind).toBe('json');
    const others = command!.fields.filter((field) => field.path !== 'recipient');

    expect(validateActionCliFlagCollisions({
      fields: [...others, { ...recipient!, aliases: ['--wait'] }],
      positionals: [],
    })).toMatchObject({
      ok: false,
      code: 'action_cli_flag_collision',
      flag: '--wait',
      fieldPath: 'recipient',
    });
  });
});

describe('stripCliOwnedFlags', () => {
  it('removes CLI-owned help, output and transport flags without touching Action tokens', () => {
    expect(stripCliOwnedFlags(
      ['session.list', '--json', '--machine-id', 'm1', '--limit', '5', '--help'],
      { valueFlags: ['--machine-id'] },
    )).toEqual(['session.list', '--limit', '5']);
  });

  it('keeps everything after `--` verbatim', () => {
    expect(stripCliOwnedFlags(['--json', '--', '--json'], {})).toEqual(['--', '--json']);
  });
});

describe('describeActionCliCommandFlags', () => {
  it('splits the one flag index by arity so an argv policy is derived, not restated', () => {
    const [command] = compileFixture();
    const { booleanFlags, valueFlags } = describeActionCliCommandFlags(command!);
    expect(booleanFlags).toEqual(expect.arrayContaining(['--wait', '--no-wait']));
    expect(valueFlags).toEqual(expect.arrayContaining(['--session-id', '--message', '--prompt', '--tags']));
    expect(valueFlags).not.toContain('--wait');
  });

  it('rejects fields that shadow CLI-owned flags or another field spelling', () => {
    const fields = compileFixture()[0]!.fields;
    const message = fields.find((field) => field.path === 'message')!;
    const wait = fields.find((field) => field.path === 'wait')!;
    expect(validateActionCliFlagCollisions({
      fields: [{ ...message, flag: '--input' }],
      positionals: [],
    })).toMatchObject({ ok: false, code: 'action_cli_flag_collision', flag: '--input-json' });
    expect(validateActionCliFlagCollisions({
      fields: [message, { ...wait, flag: '--message' }],
      positionals: [],
    })).toMatchObject({ ok: false, code: 'action_cli_flag_collision', flag: '--message' });
  });
});

describe('parseActionCliInput without a declared command path', () => {
  it('parses the fields of a dynamically selected Action and rejects a stray positional', () => {
    const spec = fixtureSpec(SEND_CLI);
    const compiled = compileActionCliFields(spec);
    const target = { fields: compiled.fields, positionals: [] as const };
    expect(parseActionCliInput(target, ['--session-id', 'sess-1', '--message', 'Hello']))
      .toEqual({
        ok: true,
        canonicalBase: null,
        callerOverlay: { sessionId: 'sess-1', message: 'Hello' },
      });
    expect(parseActionCliInput(target, ['sess-1']))
      .toMatchObject({ ok: false, message: 'Unexpected argument: sess-1' });
  });

  function composeCompiled(path: readonly string[], tokens: readonly string[]) {
    const command = findCompiledActionCliCommand([...path], listCompiledActionCliCommands())!;
    const parsed = parseActionCliInput(command, tokens);
    if (!parsed.ok) return parsed;
    return composeActionCliInput({
      parsed,
      canonicalSchema: command.spec.inputSchema,
      wholeInputSchema: command.wholeInputSchema,
      callerSchema: command.callerSchema,
      bindInput: command.spec.cli?.bindInput,
      context: { actionId: command.actionId, invocationId: 'invocation_1', output: 'json' },
    });
  }

  it('preserves declared settings scalar types and the optional page filter through the real parser', () => {
    for (const value of [true, 1.1, 'compact', null]) {
      expect(composeCompiled(['settings', 'set'], [
        '--anchor', 'appearance.density', '--value-json', JSON.stringify(value),
      ])).toMatchObject({ ok: true, input: { anchor: 'appearance.density', value } });
    }
    expect(composeCompiled(['settings', 'set'], [
      '--anchor', 'appearance.density', '--value-json', '{"nested":true}',
    ])).toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(composeCompiled(['settings', 'set'], ['--anchor', 'appearance.density']))
      .toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(composeCompiled(['settings', 'list'], ['--page-id', 'appearance']))
      .toMatchObject({ ok: true, input: { pageId: 'appearance' } });
    expect(composeCompiled(['settings', 'list'], []))
      .toMatchObject({ ok: true, input: {} });
  });

  it('keeps the friendly cross-field rules when a canonical JSON base is composed with flags', () => {
    // Without JSON the real list caller schema refuses the combination.
    expect(composeCompiled(['session', 'list'], ['--active', '--team', 'team1']))
      .toMatchObject({ ok: false, code: 'invalid_arguments' });
    // An empty JSON base must not switch that rule off: the list binder drops
    // `activeOnly` once it builds the Team query, so no later check could see it.
    expect(composeCompiled(['session', 'list'], ['--input-json', '{}', '--active', '--team', 'team1']))
      .toMatchObject({ ok: false, code: 'invalid_arguments' });
    // A valid partial composition still completes from both sources.
    expect(composeCompiled(['session', 'send'], ['--input-json', '{"sessionId":"sess-1"}', '--message', 'Hello']))
      .toMatchObject({ ok: true, input: { sessionId: 'sess-1', message: 'Hello' } });
  });

  it('preserves a canonical field a binder would only have defaulted, and refuses one the caller typed', () => {
    // `--intent` derives run-shape defaults; they yield to the canonical JSON value.
    expect(composeCompiled(['session', 'run', 'start'], [
      '--input-json', JSON.stringify({ sessionId: 'session_1', retentionPolicy: 'resumable', runClass: 'long_lived' }),
      '--intent', 'delegate', '--agent', 'codex',
    ])).toMatchObject({
      ok: true,
      input: { retentionPolicy: 'resumable', runClass: 'long_lived', intent: 'delegate', permissionMode: 'workspace_write' },
    });
    // An explicitly typed `--retention` is a second source for the same canonical field.
    expect(composeCompiled(['session', 'run', 'start'], [
      '--input-json', JSON.stringify({ sessionId: 'session_1', retentionPolicy: 'resumable' }),
      '--intent', 'delegate', '--agent', 'codex', '--retention', 'ephemeral',
    ])).toMatchObject({ ok: false, code: 'invalid_arguments', message: expect.stringContaining('either with friendly arguments or with --input-json') });
    // Without JSON the intent defaults and explicit overrides are unchanged.
    expect(composeCompiled(['session', 'run', 'start'], ['session_1', '--intent', 'review', '--agent', 'codex']))
      .toMatchObject({ ok: true, input: { retentionPolicy: 'ephemeral', permissionMode: 'read_only', runClass: 'bounded' } });
    expect(composeCompiled(['session', 'run', 'start'], [
      'session_1', '--intent', 'review', '--agent', 'codex', '--retention', 'resumable',
    ])).toMatchObject({ ok: true, input: { retentionPolicy: 'resumable' } });
    // A generated identity is a default too; a canonical one in JSON survives.
    expect(composeCompiled(['session', 'send'], [
      '--input-json', JSON.stringify({ sessionId: 'sess-1', localId: 'retry-1' }), '--message', 'Hello',
    ])).toMatchObject({ ok: true, input: { localId: 'retry-1', message: 'Hello' } });
  });

  it('validates canonical JSON before binding and rejects transformed canonical overlap', () => {
    const canonicalSchema = z.object({
      target: z.object({ id: z.string().min(1) }),
      note: z.string().optional(),
    }).strict();
    const callerSchema = z.object({ selector: z.string().min(1) }).strict();
    const bindInput = (value: unknown) => ({
      target: { id: (value as { selector: string }).selector },
    });
    const context = { actionId: 'session.message.send' as const, invocationId: 'invocation_1' };

    const invalidBase = composeActionCliInput({
      parsed: { ok: true, canonicalBase: { target: { id: '' } }, callerOverlay: {} },
      canonicalSchema,
      callerSchema,
      bindInput,
      context,
    });
    expect(invalidBase).toMatchObject({ ok: false, code: 'invalid_arguments' });

    const collision = composeActionCliInput({
      parsed: {
        ok: true,
        canonicalBase: { target: { id: 'canonical' } },
        callerOverlay: { selector: 'friendly' },
      },
      canonicalSchema,
      callerSchema,
      bindInput,
      context,
    });
    expect(collision).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      message: expect.stringContaining('target'),
    });

    const composed = composeActionCliInput({
      parsed: {
        ok: true,
        canonicalBase: { target: { id: 'canonical' } },
        callerOverlay: { note: 'friendly' },
      },
      canonicalSchema,
      callerSchema: z.object({ note: z.string().min(1) }).strict(),
      bindInput: (value) => value,
      context,
    });
    expect(composed).toEqual({
      ok: true,
      input: { target: { id: 'canonical' }, note: 'friendly' },
      callerInput: { note: 'friendly' },
    });
  });
});
