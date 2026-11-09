import { randomUUID } from 'node:crypto';
import { sameStoredCredentials } from '@/persistence';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 as outputs, SkillFoundListResultV1Schema, SkillInstallSourceV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';
import { isShellBridgeAgentMarkerV1, resolveShellBridgeActionSurfaceV1 } from './shellBridgeActionSurface';
import { readSkillDirectoryInputV1 } from './skillsDirectoryInputAdapter';
import { readSkillSourceArgV1 } from './skillsSourceArgAdapter';
import { writeSkillExportOutputV1 } from './skillsExportOutputAdapter';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { parseActionCliInput, composeActionCliInput } from './parseCommandInput';
import { readActionCliServerId } from './actionServerTarget';
import { runCompiledActionCliCommand, stripTransportTokens, readTransportMachineId, type ActionCliExecutionDeps } from './executeCommand';

/** Terminal bytes and names are prepared once, then every mutation runs through its compiled leaf. */
export async function tryHandleSkillsCliCommand(params: Readonly<{ argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps> }>): Promise<boolean> {
  if (params.argv[0] !== 'skills') return false;
  const commands = listCompiledActionCliCommands();
  const command = findCompiledActionCliCommand(params.argv, commands);
  if (!command || !['skills.read', 'skills.create', 'skills.update', 'skills.duplicate', 'skills.delete', 'skills.install', 'skills.export', 'skills.updates.diff', 'skills.updates.apply', 'skills.machine.install', 'skills.machine.uninstall', 'skills.found.read', 'skills.found.adopt', 'registries.updates.check'].includes(command.actionId)) return false;
  const options = argvBeforeOptionTerminator(params.argv);
  const bridge = resolveShellBridgeActionSurfaceV1(options) === 'agent';
  const canonicalJson = options.some(token => token === '--input-json' || token.startsWith('--input-json='));
  if (options.some(token => token === '--help' || token === '-h') || canonicalJson && !bridge) return false;
  let bridgeSessionId: string | undefined;
  const rest: string[] = [];
  const tokens = params.argv.slice(command.path.length);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--') { rest.push(...tokens.slice(index)); break; }
    if (bridge && isShellBridgeAgentMarkerV1(token)) continue;
    if (bridge && (token === '--session-id' || token.startsWith('--session-id='))) {
      if (bridgeSessionId !== undefined) throw new Error('Supply --session-id once.');
      bridgeSessionId = token.startsWith('--session-id=') ? token.slice('--session-id='.length) : tokens[++index];
      continue;
    }
    rest.push(token);
  }
  if (bridge && !bridgeSessionId) throw new Error('--agent-bridge requires --session-id.');
  if (canonicalJson) {
    await runCompiledActionCliCommand({ command, argv: [...command.path, ...rest], signal: params.signal,
      deps: params.actionExecutionDeps, agentBridgeSessionId: bridgeSessionId });
    return true;
  }
  const parsed = parseActionCliInput(command, stripTransportTokens(command, rest));
  if (!parsed.ok) { await runCompiledActionCliCommand({ command, argv: params.argv, signal: params.signal, deps: params.actionExecutionDeps }); return true; }
  const caller = parsed.callerOverlay;
  const serverId = readActionCliServerId(params.argv, true), machineId = readTransportMachineId(command, params.argv);
  const transport = [...(serverId ? ['--server-id', serverId] : []), ...(machineId ? ['--machine-id', machineId] : [])];
  let captured: Parameters<ActionCliExecutionDeps['createExecutorFn']>[0] | undefined;
  const create = params.actionExecutionDeps?.createExecutorFn ?? (async input => (await import('@/session/actions/createCliActionExecutorFromCredentials')).createCliActionExecutorFromCredentials(input));
  const deps: Partial<ActionCliExecutionDeps> = { ...params.actionExecutionDeps, createExecutorFn: async input => {
    if (captured && (!sameStoredCredentials(captured.credentials, input.credentials) || captured.serverId !== input.serverId
      || normalizeServerHttpBaseUrl(captured.serverApiUrl ?? resolveServerHttpBaseUrl()) !== normalizeServerHttpBaseUrl(input.serverApiUrl ?? resolveServerHttpBaseUrl())
      || captured.serverIdentityId !== input.serverIdentityId)) throw Object.assign(new Error('Skill Account or Home retired'), { code: 'client_refused' });
    captured ??= input; return create(input);
  } };
  const runRead = async (path: readonly string[], input: unknown, consume: (value: unknown) => void) => {
    const leaf = findCompiledActionCliCommand(path, commands); if (!leaf) throw new Error('Skill Action command unavailable');
    await runCompiledActionCliCommand({ command: leaf, argv: [...leaf.path, '--input-json', JSON.stringify(input), ...transport],
      signal: params.signal, deps, ...(bridgeSessionId ? { agentBridgeSessionId: bridgeSessionId } : {}), consumeSuccess: value => { consume(value); return true; } });
  };
  let input: unknown;
  if (command.actionId === 'skills.found.read' || command.actionId === 'skills.found.adopt') {
    if (typeof caller.machineId !== 'string') throw new Error('Supply --machine.');
    let found: ReturnType<typeof SkillFoundListResultV1Schema.parse> | undefined;
    await runRead(['skills', 'found', 'list'], { machineId: caller.machineId }, value => { found = SkillFoundListResultV1Schema.parse(value); });
    if (!found) return true;
    const resolveFound = (name: string) => {
      const byPath = found!.items.find(item => item.path === name); if (byPath) return byPath;
      const matches = found!.items.filter(item => item.name === name);
      if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'Skill name is ambiguous; supply its path.' : 'Skill not found.'),
        { code: matches.length ? 'ambiguous_skill_name' : 'not_found' });
      return matches[0]!;
    };
    if (command.actionId === 'skills.found.read') {
      if (typeof caller.itemId !== 'string') throw new Error('Supply a found skill name or path.');
      input = { machineId: caller.machineId, path: resolveFound(caller.itemId).path };
    } else {
      if (!Array.isArray(caller.names) || caller.names.some(name => typeof name !== 'string')) throw new Error('Supply found skill names or paths.');
      input = { machineId: caller.machineId, items: caller.names.map(name => { const item = resolveFound(name); return { name: item.name, path: item.path }; }),
        ...(caller.off ? { where: { kind: 'replace', rules: [] } } : {}) };
    }
  } else if (command.actionId === 'skills.create') {
    if (typeof caller.from !== 'string') throw new Error('--from requires a folder.');
    input = { name: caller.name, files: await readSkillDirectoryInputV1(caller.from), ...(caller.off ? { where: { kind: 'replace', rules: [] } } : {}) };
  } else if (command.actionId === 'skills.install') {
    if (typeof caller.source !== 'string') throw new Error('Supply a source.');
    let source = await readSkillSourceArgV1(caller.source);
    if (caller.refs !== undefined) {
      if (source.kind !== 'link') throw new Error('Reviewed Git refs require a link source.');
      source = SkillInstallSourceV1Schema.parse({ ...source, refs: caller.refs });
    }
    if (source.kind === 'registryUnpinned') {
      const pinned = source;
      let version: string | undefined;
      await runRead(['registries', 'items', 'read'], { kind: 'skill', sourceId: source.sourceId, itemId: source.itemId }, value => {
        const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(value).item; version = item.summary.version;
      });
      if (!version) return true;
      source = { kind: 'registry', sourceId: pinned.sourceId, itemId: pinned.itemId, version };
    }
    input = { source, ...(caller.path ? { selectPaths: caller.path } : {}), ...(caller.dryRun ? { dryRun: true } : {}), ...(caller.off ? { where: { kind: 'replace', rules: [] } } : {}) };
  } else {
    let library: ReturnType<(typeof outputs)['skills.list']['parse']> | undefined;
    await runRead(['skills', 'list'], {}, value => { library = outputs['skills.list'].parse(value); });
    if (!library) return true;
    const resolveName = (name: string) => {
      const byId = library!.items.find(item => item.skillId === name); if (byId) return byId;
      const matches = library!.items.filter(item => item.name === name);
      if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'Skill name is ambiguous; supply its id.' : 'Skill not found.'), { code: matches.length ? 'ambiguous_skill_name' : 'not_found' });
      return matches[0]!;
    };
    if (command.actionId === 'registries.updates.check') {
      const keys = caller.keys;
      if (keys !== undefined && (!Array.isArray(keys) || keys.some(key => typeof key !== 'string'))) throw new Error('Supply skill names or ids.');
      input = { kind: 'skill', ...(Array.isArray(keys) ? { keys: keys.map(key => resolveName(String(key)).skillId) } : {}) };
    } else if (command.actionId === 'skills.export') {
      if (!Array.isArray(caller.names) || caller.names.some(name => typeof name !== 'string')) throw new Error('Supply skill names.');
      input = { skillIds: caller.names.map(name => resolveName(name).skillId) };
    } else {
      if (typeof caller.itemId !== 'string') return false;
      const item = resolveName(caller.itemId);
      const needsRevision = ['skills.update', 'skills.delete', 'skills.updates.apply'].includes(command.actionId);
      const composed = composeActionCliInput({ parsed: { ...parsed, callerOverlay: { ...caller, itemId: item.skillId, ...(needsRevision ? { expectedRevision: item.revision } : {}) } },
        canonicalSchema: command.spec.inputSchema, wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
        context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path, output: options.includes('--json') ? 'json' : 'human' } });
      if (!composed.ok) throw Object.assign(new Error(composed.message), { code: composed.code });
      input = composed.input;
      if (command.actionId === 'skills.update' && typeof caller.from === 'string') {
        let currentFiles: ReturnType<typeof SkillReadResultV1Schema.parse> | undefined;
        await runRead(['skills', 'read'], { skillId: item.skillId }, value => { currentFiles = SkillReadResultV1Schema.parse(value); });
        if (!currentFiles) return true;
        const files = await readSkillDirectoryInputV1(caller.from), paths = new Set(files.map(file => file.path));
        input = { skillId: item.skillId, expectedRevision: currentFiles.revision,
          files: [...currentFiles.files.filter(file => !paths.has(file.path)).map(file => ({ kind: 'remove', path: file.path })), ...files.map(file => ({ kind: 'upsert', file }))] };
      }
    }
  }
  await runCompiledActionCliCommand({ command, argv: [...command.path, '--input-json', JSON.stringify(input), ...transport, ...(options.includes('--json') ? ['--json'] : [])],
    signal: params.signal, deps, ...(bridgeSessionId ? { agentBridgeSessionId: bridgeSessionId } : {}),
    ...(command.actionId === 'skills.export' && typeof caller.out === 'string' ? { consumeSuccess: async value => { await writeSkillExportOutputV1(value, caller.out as string); return true; } } : {}) });
  return true;
}
