import { describe, expect, it } from 'vitest';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';

describe('marketplace spellings compile through registry Actions', () => {
  it('compiles every registry update path with its keys operand and preserves strict app demand', () => {
    const commands = listCompiledActionCliCommands();
    const paths = [
      ['registries', 'updates', 'check'], ['skills', 'updates', 'check'],
      ['mcp', 'servers', 'updates', 'check'], ['agents', 'updates', 'check'],
    ] as const;
    for (const path of paths) {
      const command = findCompiledActionCliCommand(path, commands);
      expect(command?.actionId).toBe('registries.updates.check');
      expect(command?.variadicPositional).toMatchObject({ path: 'keys', kind: 'string_list', required: false });
    }
    const command = findCompiledActionCliCommand(paths[0], commands);
    if (!command) throw new Error('Expected registry update command');
    const environments = [{ environmentId: 'environment', expectedRevision: 3 }];
    for (const [args, expected] of [
      [['--kind', 'app', '--environments-json', JSON.stringify(environments)], { kind: 'app', environments }],
      [['--kind', 'skill', 'first', 'second'], { kind: 'skill', keys: ['first', 'second'] }],
    ] as const) {
      const parsed = parseActionCliCommandInput(command, [...command.path, ...args]);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
        wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
        context: { actionId: command.actionId, invocationId: 'update-test', commandPath: command.path } }))
        .toMatchObject({ ok: true, input: expected });
    }
    const mixed = parseActionCliCommandInput(command, [...command.path, '--kind', 'app', 'invalid-key',
      '--environments-json', JSON.stringify(environments)]);
    if (mixed.ok) {
      expect(composeActionCliInput({ parsed: mixed, canonicalSchema: command.spec.inputSchema,
        wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
        context: { actionId: command.actionId, invocationId: 'invalid-update-test', commandPath: command.path } }).ok).toBe(false);
    } else {
      expect(mixed.code).toBe('invalid_arguments');
    }
  });

  it.each([
    [['plugins', 'install'], ['/workspace/plugin'], 'plugins.install', { path: '/workspace/plugin' }],
    [['plugins', 'uninstall'], ['acme.plugin'], 'plugins.uninstall', { pluginId: 'acme.plugin' }],
    [['plugins', 'enable'], ['acme.plugin', '--machine', 'machine-1'], 'plugins.enable', { pluginId: 'acme.plugin', machineId: 'machine-1' }],
    [['plugins', 'disable'], ['acme.plugin', '--machine', 'machine-1'], 'plugins.disable', { pluginId: 'acme.plugin', machineId: 'machine-1' }],
    [['plugins', 'rollback'], ['acme.plugin', '--machine', 'machine-1'], 'plugins.rollback', { pluginId: 'acme.plugin', machineId: 'machine-1' }],
    [['plugins', 'trust', 'forget'], ['acme.plugin', '--machine', 'machine-1'], 'plugins.trust.forget', { pluginId: 'acme.plugin', machineId: 'machine-1' }],
    [['plugins', 'update-policy', 'set'], ['acme.plugin', '--policy', 'pinned', '--machine', 'machine-1'], 'plugins.update_policy.set', { pluginId: 'acme.plugin', machineId: 'machine-1', policy: 'pinned' }],
    [['plugins', 'marketplace', 'install'], ['marketplace:team', 'acme.plugin', '--version', '1.0.0', '--machine-id', 'machine-1'], 'plugins.install', { machineId: 'machine-1', source: { kind: 'marketplace', sourceId: 'marketplace:team', pluginId: 'acme.plugin', version: '1.0.0' } }],
    [['plugins', 'marketplace', 'sources', 'list'], [], 'registries.sources.list', { kind: 'plugin' }],
    [['registries', 'sources', 'list'], ['--kind', 'agent'], 'registries.sources.list', { kind: 'agent' }],
    [['registries', 'updates', 'check'], ['builtin:agents/example'], 'registries.updates.check', { keys: ['builtin:agents/example'] }],
    [['agents', 'updates', 'check'], ['builtin:agents/example'], 'registries.updates.check', { kind: 'agent', keys: ['builtin:agents/example'] }],
    [['plugins', 'marketplace', 'sources', 'add'], ['https://catalog.example/plugins.json'], 'registries.sources.create', { url: 'https://catalog.example/plugins.json', kinds: ['plugin'] }],
    [['plugins', 'marketplace', 'sources', 'enable'], ['marketplace:team'], 'registries.sources.update', { sourceId: 'marketplace:team', enabled: true }],
    [['plugins', 'marketplace', 'sources', 'disable'], ['marketplace:team'], 'registries.sources.update', { sourceId: 'marketplace:team', enabled: false }],
    [['plugins', 'marketplace', 'sources', 'remove'], ['marketplace:team'], 'registries.sources.delete', { sourceId: 'marketplace:team' }],
    [['plugins', 'marketplace', 'list'], [], 'registries.items.list', { kind: 'plugin' }],
    [['plugins', 'marketplace', 'show'], ['marketplace:team', 'acme.plugin'], 'registries.items.read', { sourceId: 'marketplace:team', itemId: 'acme.plugin', kind: 'plugin' }],
  ] as const)('routes %j to its canonical owner', (path, args, actionId, input) => {
    const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
    expect(command?.actionId).toBe(actionId);
    if (!command) throw new Error('Expected generated marketplace alias');
    expect(command.path).toEqual(path);
    const parsed = parseActionCliCommandInput(command, [...path, ...args]);
    if (!parsed.ok) throw new Error(parsed.message);
    const composed = composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
      wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
      context: { actionId: command.actionId, invocationId: 'alias-test', commandPath: command.path, output: 'json' } });
    expect(composed).toMatchObject({ ok: true, input });
  });
});
