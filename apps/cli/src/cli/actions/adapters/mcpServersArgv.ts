import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { randomUUID } from 'node:crypto';
import { matchPersonalSavedSecretMetadata } from './savedSecretsInput';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { sameStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveCurrentAccountAdministrationMachine, resolveCurrentAccountMachineTarget } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { createConnectedAccountDaemonClient } from '@/cli/commands/connect/connectedAccountDaemonClient';
import { continueConnectedAccountAuthentication } from '@/cli/commands/connect';
import { parseConnectArgs } from '@/cli/commands/connect/parseConnectArgs';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';
import { findCompiledActionCliCommand, listCompiledActionCliCommands, type CompiledActionCliCommand } from '../compiledCommands';
import { readActionCliServerId } from '../actionServerTarget';
import { composeActionCliInput, parseActionCliInput } from '../parseCommandInput';
import { type ActionCliExecutionDeps, readTransportMachineId, runCompiledActionCliCommand, stripTransportTokens } from '../executeCommand';

function captureMcpAccountActionExecution(dependencies: Partial<ActionCliExecutionDeps> | undefined) {
  const create = dependencies?.createExecutorFn ?? (async input =>
    (await import('@/session/actions/createCliActionExecutorFromCredentials')).createCliActionExecutorFromCredentials(input));
  let captured: { params: Parameters<ActionCliExecutionDeps['createExecutorFn']>[0]; homeId: string; homeUrl: string } | undefined;
  const deps: Partial<ActionCliExecutionDeps> = { ...dependencies, createExecutorFn: async input => {
    const homeId = input.serverId ?? configuration.activeServerId;
    const homeUrl = normalizeServerHttpBaseUrl(input.serverApiUrl ?? resolveServerHttpBaseUrl());
    if (captured && (!sameStoredCredentials(captured.params.credentials, input.credentials)
      || captured.homeId !== homeId || captured.homeUrl !== homeUrl
      || captured.params.serverIdentityId !== input.serverIdentityId)) {
      throw Object.assign(new Error('MCP Account or Home is no longer current'), { code: 'client_refused' });
    }
    captured ??= { params: input, homeId, homeUrl };
    // Each compiled invocation constructs its own executor, as Test already did.
    return create(input);
  } };
  return { deps, readCaptured: () => captured };
}

async function handleMcpServerAddCliCommand(params: Readonly<{
  argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
}>): Promise<boolean> {
  const commands = listCompiledActionCliCommands();
  const command = findCompiledActionCliCommand(['mcp', 'servers', 'add'], commands);
  const list = findCompiledActionCliCommand(['mcp', 'servers', 'list'], commands);
  if (!command || !list) throw new Error('MCP Action command is unavailable');
  // 0.2 consumed the next --arg token literally, even when it looked like a flag.
  const argv: string[] = [];
  let literals = false;
  for (let index = 0; index < params.argv.length; index++) {
    const token = params.argv[index]!;
    if (token === '--') literals = true;
    if (!literals && token === '--arg' && params.argv[index + 1] !== undefined) {
      argv.push(`--arg=${params.argv[++index]}`);
    } else argv.push(token);
  }
  const options = argvBeforeOptionTerminator(argv);
  const parsed = parseActionCliInput(command, stripTransportTokens(command, argv.slice(3)));
  if (!parsed.ok || parsed.canonicalBase || options.includes('--help') || options.includes('-h')
    || !command.callerSchema.safeParse(parsed.callerOverlay).success) {
    await runCompiledActionCliCommand({ command, argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  const serverId = readActionCliServerId(argv, true);
  const transport = serverId ? ['--server-id', serverId] : [];
  const captured = captureMcpAccountActionExecution(params.actionExecutionDeps);
  let revision: number | 'absent' | undefined;
  await runCompiledActionCliCommand({ command: list, argv: [...list.path, ...transport, ...(options.includes('--json') ? ['--json'] : [])], signal: params.signal,
    deps: captured.deps, consumeSuccess: payload => {
      const snapshot = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(payload);
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active') throw Object.assign(new Error('MCP catalog is unavailable'), { code: 'mcp_catalog_unavailable' });
      revision = snapshot.revision;
      return true;
    } });
  if (!captured.readCaptured() || revision === undefined) return true;
  const composed = composeActionCliInput({ parsed: { ...parsed, callerOverlay: { ...parsed.callerOverlay,
    expectedRevision: parsed.callerOverlay.expectedRevision ?? revision,
    entryId: parsed.callerOverlay.entryId ?? randomUUID(), nowMs: parsed.callerOverlay.nowMs ?? Date.now() } },
    canonicalSchema: command.spec.inputSchema, wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema,
    bindInput: command.spec.cli?.bindInput, context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path } });
  if (!composed.ok) throw Object.assign(new Error(composed.message), { code: composed.code });
  const input = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.create'].parse(composed.input);
  if ('entry' in input) {
    const refs = [...Object.values(input.entry.env), ...Object.values(input.entry.remote?.headers ?? {})]
      .filter(ref => ref.t === 'savedSecret');
    if (refs.length) {
      const secrets = findCompiledActionCliCommand(['secrets', 'list'], commands);
      if (!secrets) throw new Error('Saved Secret Action command is unavailable');
      let resolved = false;
      await runCompiledActionCliCommand({ command: secrets, argv: [...secrets.path, ...transport, ...(options.includes('--json') ? ['--json'] : [])], signal: params.signal,
        deps: captured.deps, consumeSuccess: payload => {
          const metadata = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.list'].parse(payload);
          for (const ref of refs) {
            const matches = matchPersonalSavedSecretMetadata(metadata.secrets, ref.secretId);
            if (matches.length !== 1) throw Object.assign(new Error('Saved Secret was not found or is ambiguous. Use its id.'), { code: 'invalid_arguments' });
            ref.secretId = formatSharedSavedSecretRefV1(matches[0]!.secretId);
          }
          resolved = true;
          return true;
        } });
      if (!resolved) return true;
    }
  }
  await runCompiledActionCliCommand({ command, argv: [...command.path, '--input-json', JSON.stringify(input),
    ...transport, ...(options.includes('--json') ? ['--json'] : [])], signal: params.signal, deps: captured.deps });
  return true;
}

async function handleMcpFoundCliCommand(params: Readonly<{
  argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
}>): Promise<boolean> {
  const commands = listCompiledActionCliCommands();
  const command = findCompiledActionCliCommand(params.argv, commands);
  const list = findCompiledActionCliCommand(['mcp', 'servers', 'list'], commands);
  if (!command || !list) throw new Error('MCP Action command is unavailable');
  const parsed = parseActionCliInput(command, stripTransportTokens(command, params.argv.slice(command.path.length)));
  const options = argvBeforeOptionTerminator(params.argv);
  if (!parsed.ok || parsed.canonicalBase || parsed.callerOverlay.machineId
    || options.includes('--help') || options.includes('-h')) {
    await runCompiledActionCliCommand({ command, argv: params.argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  const serverId = readActionCliServerId(params.argv, true);
  const transport = serverId ? ['--server-id', serverId] : [];
  const captured = captureMcpAccountActionExecution(params.actionExecutionDeps);
  await runCompiledActionCliCommand({ command: list, argv: [...list.path, ...transport, ...(options.includes('--json') ? ['--json'] : [])], signal: params.signal,
    deps: captured.deps, consumeSuccess: () => true });
  const scope = captured.readCaptured();
  if (!scope) return true;
  const machineId = await resolveCurrentAccountAdministrationMachine({ token: scope.params.credentials.token,
    serverHttpBaseUrl: scope.homeUrl, signal: params.signal });
  if (!machineId) throw Object.assign(new Error('No machine is online'), { code: 'no_machine_online' });
  const composed = composeActionCliInput({ parsed: { ...parsed, callerOverlay: { ...parsed.callerOverlay, machineId } },
    canonicalSchema: command.spec.inputSchema, wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema,
    bindInput: command.spec.cli?.bindInput, context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path } });
  if (!composed.ok) throw Object.assign(new Error(composed.message), { code: composed.code });
  await runCompiledActionCliCommand({ command, argv: [...command.path, '--input-json', JSON.stringify(composed.input),
    ...transport, ...(options.includes('--json') ? ['--json'] : [])],
    signal: params.signal, deps: captured.deps });
  return true;
}

async function handleMcpServerListCliCommand(params: Readonly<{
  argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
}>): Promise<boolean> {
  const command = findCompiledActionCliCommand(['mcp', 'servers', 'list'], listCompiledActionCliCommands());
  if (!command) throw new Error('MCP Action command is unavailable');
  // The 0.2 list accepted --dir but listed the Account catalog, independent of it.
  const argv: string[] = [];
  let literals = false;
  for (let index = 0; index < params.argv.length; index++) {
    const token = params.argv[index]!;
    if (token === '--') literals = true;
    if (!literals && token === '--dir') { index++; continue; }
    if (!literals && token.startsWith('--dir=')) continue;
    argv.push(token);
  }
  await runCompiledActionCliCommand({ command, argv, signal: params.signal, deps: params.actionExecutionDeps });
  return true;
}

async function handleMcpServerNamedCliCommand(params: Readonly<{
  argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
}>): Promise<boolean> {
  const commands = listCompiledActionCliCommands();
  const list = findCompiledActionCliCommand(['mcp', 'servers', 'list'], commands);
  const toolsList = findCompiledActionCliCommand(['mcp', 'servers', 'tools'], commands);
  const toolsSet = findCompiledActionCliCommand(['mcp', 'servers', 'tools', 'set'], commands);
  const duplicate = findCompiledActionCliCommand(['mcp', 'servers', 'duplicate'], commands);
  if (!list || !toolsList || !toolsSet || !duplicate) throw new Error('MCP Action command is unavailable');
  const isDuplicate = params.argv[2] === 'duplicate';
  const options = argvBeforeOptionTerminator(params.argv);
  const hasWholeInput = options.some(token => token === '--input-json' || token.startsWith('--input-json='));
  if (hasWholeInput && (params.argv[3] === 'list' || params.argv[3] === 'set')) {
    const raw = findCompiledActionCliCommand(params.argv.slice(0, 4), commands);
    if (!raw) throw new Error('MCP Action command is unavailable');
    await runCompiledActionCliCommand({ command: raw, argv: params.argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  const tokens = stripTransportTokens(toolsList, params.argv.slice(3));
  const parse = (command: CompiledActionCliCommand) => {
    const parsed = parseActionCliInput(command, tokens);
    return parsed.ok ? composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
      wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
      context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path,
        output: options.includes('--json') ? 'json' : 'human' } }) : parsed;
  };
  const listed = parse(isDuplicate ? duplicate : toolsList);
  const command = isDuplicate ? duplicate : listed.ok ? toolsList : toolsSet;
  const composed = isDuplicate || listed.ok ? listed : parse(toolsSet);
  // Help, whole-object input and malformed arguments retain the normal compiler
  // path. The adapter does not implement an independent parser or input policy.
  if (!composed.ok || options.includes('--help') || options.includes('-h') || hasWholeInput) {
    await runCompiledActionCliCommand({ command, argv: [...command.path, ...params.argv.slice(3)],
      signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  const requestedName = composed.callerInput.itemId;
  const serverId = readActionCliServerId(params.argv, true);
  const machineId = readTransportMachineId(command, params.argv);
  const transport = [...(serverId ? ['--server-id', serverId] : []), ...(machineId ? ['--machine-id', machineId] : [])];
  const captured = captureMcpAccountActionExecution(params.actionExecutionDeps);
  let resolvedId: string | undefined;
  await runCompiledActionCliCommand({ command: list, argv: [...list.path, ...transport, ...(options.includes('--json') ? ['--json'] : [])], signal: params.signal,
    deps: captured.deps, consumeSuccess: payload => {
      const snapshot = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(payload);
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active') throw Object.assign(new Error('MCP catalog is unavailable'), { code: 'mcp_catalog_unavailable' });
      resolvedId = (snapshot.catalog.servers.find(server => server.id === requestedName)
        ?? snapshot.catalog.servers.find(server => server.name === requestedName))?.id;
      if (!resolvedId) throw Object.assign(new Error('MCP server was not found'), { code: 'mcp_server_not_found' });
      return true;
    } });
  if (!captured.readCaptured() || !resolvedId) return true;
  await runCompiledActionCliCommand({ command, argv: [...command.path, '--input-json', JSON.stringify({ ...composed.input, serverId: resolvedId }),
    ...transport, ...(options.includes('--json') ? ['--json'] : [])], signal: params.signal, deps: captured.deps });
  return true;
}

async function handleMcpServerTestCliCommand(params: Readonly<{
  argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
}>): Promise<boolean> {
  const commands = listCompiledActionCliCommands();
  const command = findCompiledActionCliCommand(['mcp', 'servers', 'test'], commands);
  const list = findCompiledActionCliCommand(['mcp', 'servers', 'list'], commands);
  if (!command || !list) throw new Error('MCP Action command is unavailable');
  const options = argvBeforeOptionTerminator(params.argv);
  if (options.includes('--help') || options.includes('-h') || options.includes('--input-json')) {
    await runCompiledActionCliCommand({ command, argv: params.argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  // Exact 0.2 Test spelling only. Domain decisions stay in the compiled Actions.
  const translated = params.argv.map(token => {
    const equal = token.indexOf('=');
    const name = equal < 0 ? token : token.slice(0, equal);
    const canonical = name === '--mcp-server' || name === '--server' ? '--item-id'
      : name === '--dir' ? '--directory' : name === '--machine' ? '--machine-id' : name;
    return equal < 0 ? canonical : `${canonical}${token.slice(equal)}`;
  });
  const preferredMachineId = readTransportMachineId(list, translated);
  const parsed = parseActionCliInput(command, stripTransportTokens(list, translated.slice(3)));
  if (!parsed.ok) throw Object.assign(new Error(parsed.message), { code: parsed.code });
  const itemId = parsed.callerOverlay.itemId;
  if (typeof itemId !== 'string' || !itemId) throw Object.assign(new Error('Supply an MCP server name or id'), { code: 'invalid_arguments' });
  const serverId = readActionCliServerId(translated, true);
  const scope = captureMcpAccountActionExecution(params.actionExecutionDeps);
  const deps = scope.deps;
  let resolvedId: string | undefined;
  await runCompiledActionCliCommand({ command: list, argv: [...list.path, ...(serverId ? ['--server-id', serverId] : []), ...(options.includes('--json') ? ['--json'] : [])],
    signal: params.signal, deps, consumeSuccess: payload => {
      const snapshot = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(payload);
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active') throw Object.assign(new Error('MCP catalog is unavailable'), { code: 'mcp_catalog_unavailable' });
      resolvedId = (snapshot.catalog.servers.find(server => server.id === itemId)
        ?? snapshot.catalog.servers.find(server => server.name === itemId))?.id;
      if (!resolvedId) throw Object.assign(new Error('MCP server was not found'), { code: 'mcp_server_not_found' });
      return true;
    } });
  const captured = scope.readCaptured();
  if (!captured || !resolvedId) return true;
  const target = preferredMachineId ? await resolveCurrentAccountMachineTarget({ token: captured.params.credentials.token,
    requestedMachineId: preferredMachineId, serverHttpBaseUrl: captured.homeUrl, signal: params.signal }) : null;
  const machineId = target?.kind === 'selected' ? target.target.machineId : target ? null
    : await resolveCurrentAccountAdministrationMachine({ token: captured.params.credentials.token,
      serverHttpBaseUrl: captured.homeUrl, signal: params.signal });
  if (!machineId) throw Object.assign(new Error('No machine is online'), { code: 'no_machine_online' });
  await runCompiledActionCliCommand({ command, argv: [...command.path, '--input-json', JSON.stringify({ t: 'byId',
    serverId: resolvedId, machineId, directory: parsed.callerOverlay.directory ?? process.cwd() }),
    ...(serverId ? ['--server-id', serverId] : []), ...(options.includes('--json') ? ['--json'] : [])],
    signal: params.signal, deps });
  return true;
}

/** Terminal continuation only; the compiler and Connected Accounts own admission and authentication. */
export async function tryHandleMcpServerCliCommand(params: Readonly<{
  argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
}>): Promise<boolean> {
  const { argv } = params;
  if (argv[0] === 'mcp' && argv[1] === 'servers' && argv[2] === 'add') return handleMcpServerAddCliCommand(params);
  if (argv[0] === 'mcp' && argv[1] === 'servers' && argv[2] === 'list') return handleMcpServerListCliCommand(params);
  if (argv[0] === 'mcp' && (argv[1] === 'found' || argv[1] === 'servers' && argv[2] === 'detect')) return handleMcpFoundCliCommand(params);
  if (argv[0] === 'mcp' && argv[1] === 'servers' && (argv[2] === 'tools' || argv[2] === 'duplicate')) return handleMcpServerNamedCliCommand(params);
  if (argv[0] === 'mcp' && argv[1] === 'servers' && argv[2] === 'test') return handleMcpServerTestCliCommand(params);
  if (argv[0] !== 'mcp' || argv[1] !== 'servers' || (argv[2] !== 'sign-in' && argv[2] !== 'sign-out')) return false;
  const path = argv.slice(0, 3);
  const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
  const list = findCompiledActionCliCommand(['mcp', 'servers', 'list'], listCompiledActionCliCommands());
  if (!command || !list) throw new Error('MCP Action command is unavailable');
  const options = argvBeforeOptionTerminator(argv);
  if (options.includes('--help') || options.includes('-h')) {
    await runCompiledActionCliCommand({ command, argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  const noOpen = options.includes('--no-open');
  const callerTokens = stripTransportTokens(list, argv.slice(3)).filter(token => token !== '--no-open');
  const parsed = parseActionCliInput(command, callerTokens);
  if (!parsed.ok) throw Object.assign(new Error(parsed.message), { code: parsed.code });
  const canonicalInput = parsed.canonicalBase !== null;
  const requestedName = parsed.callerOverlay.itemId;
  const resolveName = !canonicalInput || requestedName !== undefined;
  if (resolveName && (typeof requestedName !== 'string' || !requestedName)) throw Object.assign(new Error('Supply an MCP server name or id'), { code: 'invalid_arguments' });
  const serverId = readActionCliServerId(argv, true);
  const preferredMachineId = readTransportMachineId(list, argv);
  const transport = [...(serverId ? ['--server-id', serverId] : []), ...(preferredMachineId ? ['--machine-id', preferredMachineId] : [])];
  let captured: { params: Parameters<ActionCliExecutionDeps['createExecutorFn']>[0]; executor: Awaited<ReturnType<ActionCliExecutionDeps['createExecutorFn']>>;
    homeId: string; homeUrl: string } | undefined;
  const create = params.actionExecutionDeps?.createExecutorFn ?? (async input =>
    (await import('@/session/actions/createCliActionExecutorFromCredentials')).createCliActionExecutorFromCredentials(input));
  const deps: Partial<ActionCliExecutionDeps> = { ...params.actionExecutionDeps,
    createExecutorFn: async input => {
      const homeId = input.serverId ?? configuration.activeServerId;
      const homeUrl = normalizeServerHttpBaseUrl(input.serverApiUrl ?? resolveServerHttpBaseUrl());
      if (captured && (!sameStoredCredentials(captured.params.credentials, input.credentials)
        || captured.homeId !== homeId || captured.homeUrl !== homeUrl
        || captured.params.serverIdentityId !== input.serverIdentityId)) {
        throw Object.assign(new Error('MCP sign-in Account or Home is no longer current'), { code: 'client_refused' });
      }
      const executor = captured?.executor ?? await create(input);
      captured ??= { params: input, executor, homeId, homeUrl };
      return executor;
    } };
  let resolvedId: string | undefined;
  if (resolveName) await runCompiledActionCliCommand({ command: list, argv: [...list.path, ...transport, ...(options.includes('--json') ? ['--json'] : [])], signal: params.signal, deps,
    consumeSuccess: payload => {
      const snapshot = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(payload);
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active') throw Object.assign(new Error('MCP catalog is unavailable'), { code: 'mcp_catalog_unavailable' });
      resolvedId = (snapshot.catalog.servers.find(server => server.id === requestedName)
        ?? snapshot.catalog.servers.find(server => server.name === requestedName))?.id;
      if (!resolvedId) throw Object.assign(new Error('MCP server was not found'), { code: 'mcp_server_not_found' });
      return true;
    } });
  if (resolveName && (!captured || !resolvedId)) return true;
  const composeArgv = (machineId?: string) => {
    // Whole-input JSON and any friendly overlay are composed by the compiler.
    // Do not manufacture itemId: it would replace the canonical server/account.
    if (!resolveName) return [...command.path, ...callerTokens, ...transport, ...(options.includes('--json') ? ['--json'] : [])];
    const composed = composeActionCliInput({ parsed: { ...parsed, callerOverlay: { ...parsed.callerOverlay, itemId: resolvedId,
      ...(argv[2] === 'sign-out' && machineId ? { machineId } : {}) } }, canonicalSchema: command.spec.inputSchema,
      wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
      context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path, output: options.includes('--json') ? 'json' : 'human' } });
    if (!composed.ok) throw Object.assign(new Error(composed.message), { code: composed.code });
    return [...path, '--input-json', JSON.stringify(composed.input), ...(serverId ? ['--server-id', serverId] : []),
      ...(options.includes('--json') ? ['--json'] : []), ...(command.routesByTransportMachineId && machineId ? ['--machine-id', machineId] : [])];
  };
  if (argv[2] === 'sign-out') {
    if (!resolveName) {
      await runCompiledActionCliCommand({ command, argv: composeArgv(), signal: params.signal, deps });
      return true;
    }
    const current = captured!;
    const machineId = await resolveCurrentAccountAdministrationMachine({ token: current.params.credentials.token,
      serverHttpBaseUrl: current.homeUrl, requestedMachineId: preferredMachineId ?? undefined, signal: params.signal });
    if (!machineId) throw Object.assign(new Error('No machine is online'), { code: 'no_machine_online' });
    await runCompiledActionCliCommand({ command, argv: composeArgv(machineId), signal: params.signal, deps });
    return true;
  }
  await runCompiledActionCliCommand({ command, argv: composeArgv(preferredMachineId ?? undefined), signal: params.signal, deps,
    consumeSuccess: async payload => {
      if (options.includes('--json')) return false;
      const current = captured!;
      const started = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.signIn.start'].parse(payload);
      const client = createConnectedAccountDaemonClient({ credentials: current.params.credentials,
        serverId: current.homeId, serverHttpBaseUrl: current.homeUrl,
        machineId: started.machineId, actionExecutor: current.executor, signal: params.signal });
      const described = await client.control({ operation: 'describeService', service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 });
      if (described.status !== 'described') throw new Error('MCP sign-in service is unavailable');
      const mode = described.descriptor.authentication.modes.find(mode => mode.id === 'oauth');
      if (!mode || mode.kind !== 'oauthAuthorizationCode' || !mode.callbackUrl) throw new Error('MCP OAuth mode is unavailable');
      await continueConnectedAccountAuthentication({ client, described,
        intent: { kind: 'connect', service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, modeId: 'oauth' },
        initial: { status: 'awaitingOAuth', attemptId: started.attemptId, authorizationUrl: started.authorizationUrl,
          callbackUrl: mode.callbackUrl, expiresAtMs: started.expiresAtMs },
        options: parseConnectArgs(['--oauth', ...(noOpen ? ['--no-open'] : [])]).options, signal: params.signal });
      return true;
    } });
  return true;
}
