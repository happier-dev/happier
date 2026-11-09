import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/mini';
import { resolveCanonicalAgentIdFromFlavor } from '@happier-dev/agents';
import { DaemonAgentInstallStartResponseSchema, DaemonAgentInstallReadResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import type {
  AgentInstallJobOutcome,
  DaemonAgentInstallReadResponse,
  DaemonAgentInstallStartResponse,
} from '@happier-dev/protocol/daemon/agent-install-jobs';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistryItemV1 } from '@happier-dev/protocol/registries';
import { resolveAcpPlatformFitV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { AgentsAcpBackendsGetOutputV1Schema } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { MachinesAgentsListOutputSchema } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { AgentsBackendsListOutputSchema } from '@happier-dev/protocol/actions/agentBackendInventory';
import { readRegistryAgentCliLocatorV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { readSettings, readStoredCredentials, readStoredCredentialsForServerId, sameStoredCredentials } from '@/persistence';
import { getServerProfile } from '@/server/serverProfiles';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { findCatalogEntry } from '@/agent/catalog/registry';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '../compiledCommands';
import { parseActionCliInput, composeActionCliInput } from '../parseCommandInput';
import { readActionCliServerId, resolveActionCliCredentialTarget } from '../actionServerTarget';
import { runCompiledActionCliCommand, stripTransportTokens, type ActionCliExecutionDeps } from '../executeCommand';

export type AgentCliInstallOutcome = Readonly<{ agentId: string; jobId: string; outcome: AgentInstallJobOutcome }>;
type AgentCliOptions = Readonly<{ argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
  consumeInstallOutcome?: (receipt: AgentCliInstallOutcome) => boolean | Promise<boolean> }>;
type InstallStartPayload = Omit<Extract<DaemonAgentInstallStartResponse, { ok: true }>, 'ok'>;
type InstallReadPayload = Omit<Extract<DaemonAgentInstallReadResponse, { ok: true }>, 'ok'>;

// The compiled CLI success adapter removes the transport's ok:true envelope.
// Restore it before parsing so the protocol schema remains the single owner of
// the response contract; lazy Mini schemas do not expose union internals.
function parseInstallStartPayload(value: unknown): InstallStartPayload {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const response = DaemonAgentInstallStartResponseSchema.parse({ ...record, ok: true });
  if (!response.ok) throw new Error(response.error);
  const { ok: _ok, ...payload } = response;
  return payload;
}

function parseInstallReadPayload(value: unknown): InstallReadPayload {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const response = DaemonAgentInstallReadResponseSchema.parse({ ...record, ok: true });
  if (!response.ok) throw new Error(response.error);
  const { ok: _ok, ...payload } = response;
  return payload;
}

// This reads the existing Machine list projection; extra presentation fields
// carry no targeting authority and never enter install inputs.
const InstallMachineListSchema = z.looseObject({ items: z.array(z.looseObject({ id: z.string().check(z.minLength(1)),
  active: z.boolean(), activeAt: z.optional(z.nullable(z.number())), revokedAt: z.nullable(z.number()),
  replacedByMachineId: z.nullable(z.string()), kind: z.enum(['persistent', 'ephemeral_session_runner']),
  access: z.optional(z.looseObject({ accessState: z.string() })),
  platform: z.optional(z.nullable(z.string())), arch: z.optional(z.nullable(z.string())),
})) });

/** Names, local-machine defaults and job observation are terminal adaptation only. */
export async function tryHandleAgentCliCommand(params: AgentCliOptions): Promise<boolean> {
  const argv = params.argv[0] === 'agent' ? ['agents', ...params.argv.slice(1)]
    : params.argv[0] === 'install' && params.argv[1] === 'provider' ? ['agents', 'install', ...params.argv.slice(2)] : params.argv;
  if (argv[0] !== 'agents') return false;
  const commands = listCompiledActionCliCommands();
  let command = findCompiledActionCliCommand(argv, commands);
  if (!command) return false;
  const machineAction = command.actionId.startsWith('machines.agents.install') || command.actionId === 'machines.agents.uninstall';
  const registryInstall = command.actionId === 'agents.acp.backends.installFromRegistry';
  const definitionDelete = command.actionId === 'agents.acp.backends.delete';
  if (!machineAction && !registryInstall && !definitionDelete) return false;
  const options = argvBeforeOptionTerminator(argv);
  if (options.includes('--help') || options.includes('-h')) {
    await runCompiledActionCliCommand({ command, argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  const parsed = parseActionCliInput(command, stripTransportTokens(command, argv.slice(command.path.length)));
  if (!parsed.ok) {
    await runCompiledActionCliCommand({ command, argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  if (parsed.callerOverlay.dryRun === true && !registryInstall) {
    const { handleAgentsCommand } = await import('@/cli/commands/agents');
    await handleAgentsCommand(argv.slice(1), { signal: params.signal, actionExecutionDeps: params.actionExecutionDeps });
    return true;
  }
  const validated = parsed.canonicalBase ? command.wholeInputSchema.safeParse(parsed.canonicalBase)
    : command.callerSchema.safeParse(parsed.callerOverlay);
  if (!validated.success) {
    await runCompiledActionCliCommand({ command, argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  const requestedServerId = readActionCliServerId(argv, command.acceptsServerId);
  const deps = params.actionExecutionDeps;
  const captured = await resolveActionCliCredentialTarget({ requestedServerId, deps: {
    readCredentialsFn: deps?.readCredentialsFn ?? readStoredCredentials,
    readCredentialsForServerIdFn: deps?.readCredentialsForServerIdFn ?? readStoredCredentialsForServerId,
    getServerProfileFn: deps?.getServerProfileFn ?? getServerProfile,
  } });
  const capturedCredentials = captured.credentials;
  if (!capturedCredentials) {
    await runCompiledActionCliCommand({ command, argv, signal: params.signal, deps });
    return true;
  }
  const capturedHomeId = captured.fixedServer?.serverId ?? configuration.activeServerId;
  const capturedHomeUrl = normalizeServerHttpBaseUrl(captured.fixedServer?.serverApiUrl ?? resolveServerHttpBaseUrl());
  const createExecutor = deps?.createExecutorFn ?? (async input => (
    await import('@/session/actions/createCliActionExecutorFromCredentials')).createCliActionExecutorFromCredentials(input));
  const scopedDeps: Partial<ActionCliExecutionDeps> = { ...deps, createExecutorFn: input => {
    if (!sameStoredCredentials(capturedCredentials, input.credentials)
      || (input.serverId ?? configuration.activeServerId) !== capturedHomeId
      || normalizeServerHttpBaseUrl(input.serverApiUrl ?? resolveServerHttpBaseUrl()) !== capturedHomeUrl
      || input.serverIdentityId !== captured.serverIdentityId) {
      throw Object.assign(new Error('Agent Account or Home is no longer current.'), { code: 'client_refused' });
    }
    return createExecutor(input);
  } };
  const json = options.includes('--json');
  const transport = [...(requestedServerId ? ['--server-id', requestedServerId] : [])];
  const runRead = async (path: readonly string[], input: unknown, consume: (value: unknown) => void) => {
    const leaf = findCompiledActionCliCommand(path, commands);
    if (!leaf) throw new Error(`Agent Action command unavailable: ${path.join(' ')}`);
    await runCompiledActionCliCommand({ command: leaf, argv: [...leaf.path, '--input-json', JSON.stringify(input), ...transport],
      signal: params.signal, deps: scopedDeps, consumeSuccess: payload => { consume(payload); return true; } });
  };
  let caller = parsed.callerOverlay;
  const canonicalAgentId = typeof caller.agentId === 'string' ? resolveCanonicalAgentIdFromFlavor(caller.agentId) : null;
  if (!parsed.canonicalBase && machineAction && typeof caller.agentId === 'string' && !caller.definitionId
    && canonicalAgentId && !findCatalogEntry(caller.agentId)) caller = { ...caller, agentId: canonicalAgentId };
  if (!parsed.canonicalBase && (definitionDelete || machineAction && typeof caller.agentId === 'string'
    && !caller.definitionId && !canonicalAgentId && !findCatalogEntry(caller.agentId))) {
    let inventory: ReturnType<typeof AgentsBackendsListOutputSchema.parse> | undefined;
    await runRead(['agents', 'backends', 'list'], { includeDisabled: true }, value => { inventory = AgentsBackendsListOutputSchema.parse(value); });
    if (!inventory) return true;
    const requested = definitionDelete ? caller.backendId : caller.agentId;
    const direct = inventory.items.find(row => row.targetKey === requested || row.backendId === requested)
      ?? inventory.items.find(row => row.agentId === requested && !row.backendId);
    const named = direct ? [] : inventory.items.filter(row => row.label === requested);
    if (named.length > 1) throw Object.assign(new Error('Agent name is ambiguous; supply its id.'), { code: 'ambiguous_agent_name' });
    const target = direct ?? named[0];
    if (target?.backendId) caller = definitionDelete ? { ...caller, backendId: target.backendId }
      : { ...caller, agentId: target.agentId ?? 'custom-acp', definitionId: target.backendId };
    else if (target?.agentId) caller = { ...caller, agentId: target.agentId };
  }
  const readInstallNowMachines = async (item: RegistryItemV1, requested: readonly unknown[] | undefined): Promise<string[] | null> => {
    if (item.payload.kind !== 'agent') throw new Error('The registry item is not an Agent.');
    const distributions = item.payload.agent.distributions;
    let inventory: ReturnType<typeof InstallMachineListSchema.parse> | undefined;
    await runRead(['machines', 'list'], {}, value => { inventory = InstallMachineListSchema.parse(value); });
    if (!inventory) return null;
    const selected = requested ? new Set(requested) : null;
    return inventory.items.filter(machine => (!selected || selected.has(machine.id))
      && machine.kind === 'persistent' && !machine.replacedByMachineId
      && (!machine.access || machine.access.accessState === 'ready')
      && isMachineReachableV1({ machine, nowMs: Date.now() })
      && resolveAcpPlatformFitV1(distributions, { platform: machine.platform ?? null, arch: machine.arch ?? null }).kind === 'can_run')
      .map(machine => machine.id);
  };
  let input: Readonly<Record<string, unknown>>;
  if (definitionDelete) {
    const composed = composeActionCliInput({ parsed: { ...parsed, callerOverlay: caller }, canonicalSchema: command.spec.inputSchema,
      wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
      context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path, output: json ? 'json' : 'human' } });
    if (!composed.ok) throw Object.assign(new Error(composed.message), { code: composed.code });
    input = composed.input;
  } else if (command.path[1] === 'update' && typeof caller.version === 'string') {
    let existing: ReturnType<typeof AgentsAcpBackendsGetOutputV1Schema.parse> | undefined;
    await runRead(['agents', 'acp', 'backends', 'get'], { backendId: caller.definitionId ?? caller.agentId },
      value => { existing = AgentsAcpBackendsGetOutputV1Schema.parse(value); });
    if (!existing) return true;
    const definition = existing.backend, provenance = definition.origin?.provenance;
    if (!provenance) throw Object.assign(new Error('This Agent did not come from a registry.'), { code: 'not_registry_agent' });
    let item: RegistryItemV1 | undefined;
    await runRead(['registries', 'items', 'read'], { kind: 'agent', sourceId: provenance.sourceId, itemId: provenance.itemId,
      version: caller.version }, value => { item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(value).item; });
    if (!item) return true;
    const machines = await readInstallNowMachines(item, typeof caller.machineId === 'string' ? [caller.machineId] : undefined);
    if (!machines) return true;
    const installOn: string[] = [];
    for (const machineId of machines) {
      let observed: ReturnType<typeof MachinesAgentsListOutputSchema.parse> | undefined;
      await runRead(['machines', 'agents', 'list'], { machineId, agentId: 'custom-acp', definitionId: definition.id },
        value => { observed = MachinesAgentsListOutputSchema.parse(value); });
      if (!observed) return true;
      if (observed.items.some(agent => agent.definitionId === definition.id && agent.installed)) installOn.push(machineId);
    }
    const leaf = findCompiledActionCliCommand(['agents', 'acp', 'backends', 'install-from-registry'], commands);
    if (!leaf) throw new Error('Registry Agent install Action is unavailable.');
    command = leaf;
    input = { fromRegistry: { sourceId: item.summary.sourceId, itemId: item.summary.itemId, version: item.summary.version }, installOn };
  } else if (registryInstall) {
    if (typeof caller.command === 'string') {
      const leaf = findCompiledActionCliCommand(['agents', 'acp', 'backends', 'upsert'], commands);
      if (!leaf) throw new Error('Configured Agent Action is unavailable.');
      const name = typeof caller.name === 'string' ? caller.name : `agent-${randomUUID()}`;
      await runCompiledActionCliCommand({ command: leaf, argv: [...leaf.path, '--input-json', JSON.stringify({
        backend: { id: name, name, title: caller.title ?? caller.command, launch: { kind: 'command', command: caller.command, args: caller.args ?? [] } },
        ...(caller.dryRun === true ? { dryRun: true } : {}),
      }), ...transport, ...(json ? ['--json'] : [])], signal: params.signal, deps: scopedDeps });
      return true;
    }
    if (parsed.canonicalBase) input = parsed.canonicalBase;
    else if (caller.fromRegistry) {
      const composed = composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema, wholeInputSchema: command.wholeInputSchema,
        callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
        context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path, output: json ? 'json' : 'human' } });
      if (!composed.ok) throw Object.assign(new Error(composed.message), { code: composed.code });
      input = composed.input;
    }
    else {
      if (caller.dryRun === true) throw Object.assign(new Error('--dry-run is available for command Agents. Choose --install first-use to add a registry Agent without downloading it.'), { code: 'invalid_arguments' });
      const locator = typeof caller.registryItem === 'string' ? caller.registryItem : '';
      const pointer = readRegistryAgentCliLocatorV1(locator);
      let item: RegistryItemV1 | undefined;
      await runRead(['registries', 'items', 'read'], { kind: 'agent', ...pointer,
        ...(caller.version ? { version: caller.version } : {}) }, value => { item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(value).item; });
      if (!item) return true;
      if (item.payload.kind !== 'agent' || !item.summary.version) throw Object.assign(new Error('The registry did not return a pinned Agent.'), { code: 'registry_item_unavailable' });
      const pinned = item;
      let installOn: string[] = [];
      if (caller.install !== 'first-use') {
        const selected = await readInstallNowMachines(pinned, Array.isArray(caller.machine) ? caller.machine : undefined);
        if (!selected) return true;
        installOn = selected;
      }
      input = { fromRegistry: { sourceId: pinned.summary.sourceId, itemId: pinned.summary.itemId, version: pinned.summary.version },
        ...(installOn.length ? { installOn } : {}) };
    }
  } else {
    const machineId = parsed.canonicalBase?.machineId ?? caller.machineId
      ?? resolveMachineIdForServerFromSettings(await readSettings(), capturedHomeId, readAccountIdFromToken(captured.credentials.token));
    if (typeof machineId !== 'string' || !machineId) throw Object.assign(new Error('This computer has no registered Machine for this Account. Supply --machine.'), { code: 'machine_not_registered' });
    const composed = parsed.canonicalBase ? { ok: true as const, input: parsed.canonicalBase }
      : composeActionCliInput({ parsed: { ...parsed, callerOverlay: { ...caller, machineId } },
      canonicalSchema: command.spec.inputSchema, wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema,
      bindInput: command.spec.cli?.bindInput, context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path, output: json ? 'json' : 'human' } });
    if (!composed.ok) throw Object.assign(new Error(composed.message), { code: composed.code });
    input = composed.input;
  }
  const finalCommand = command;
  const isStart = finalCommand.actionId === 'machines.agents.install' || finalCommand.actionId === 'machines.agents.uninstall';
  await runCompiledActionCliCommand({ command: finalCommand, argv: [...finalCommand.path, '--input-json', JSON.stringify(input), ...transport, ...(json ? ['--json'] : [])],
    signal: params.signal, deps: scopedDeps,
    ...(isStart ? { consumeSuccess: async (payload: unknown) => {
      const started = parseInstallStartPayload(payload);
      const status = findCompiledActionCliCommand(['agents', 'install', 'status'], commands);
      const cancel = findCompiledActionCliCommand(['agents', 'install', 'cancel'], commands);
      if (!status || !cancel) throw new Error('Agent install observation Actions are unavailable.');
      const controller = new AbortController();
      const onInterrupt = () => controller.abort();
      process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
      params.signal?.addEventListener('abort', onInterrupt, { once: true });
      let cancelSent = false, cursor = 0;
      try {
        if (params.signal?.aborted) onInterrupt();
        for (;;) {
          if (controller.signal.aborted && !cancelSent) {
            cancelSent = true;
            let acknowledged = false;
            await runCompiledActionCliCommand({ command: cancel, argv: [...cancel.path, '--input-json', JSON.stringify({ machineId: input.machineId, jobId: started.jobId }), ...transport],
              deps: scopedDeps, consumeSuccess: () => { acknowledged = true; return true; } });
            if (!acknowledged) return true;
          }
          let read: InstallReadPayload | undefined;
          await runCompiledActionCliCommand({ command: status, argv: [...status.path, '--input-json', JSON.stringify({ machineId: input.machineId, jobId: started.jobId, cursor }), ...transport, ...(json ? ['--json'] : [])],
            deps: scopedDeps, consumeSuccess: value => { read = parseInstallReadPayload(value); return true; } });
          if (!read) return true;
          cursor = read.nextCursor;
          if (!json) for (const event of read.events) process.stderr.write(event.t === 'step' ? `${event.label}: ${event.state}\n`
            : event.t === 'log' ? `${event.line}\n` : `${event.stepId}: ${event.bytesDone}${event.bytesTotal === null ? '' : `/${event.bytesTotal}`} bytes\n`);
          if (read.done) {
            if (!read.outcome) throw new Error('Agent install completed without an outcome.');
            if (await params.consumeInstallOutcome?.({ agentId: String(input.agentId), jobId: started.jobId, outcome: read.outcome })) return true;
            const kind = finalCommand.path.join('_');
            if (read.outcome.kind === 'failed') {
              if (json) await printJsonEnvelope({ ok: false, kind, error: { code: read.outcome.code, message: read.outcome.message, jobId: started.jobId,
                stepId: read.outcome.stepId, ...(read.outcome.guideUrl ? { guideUrl: read.outcome.guideUrl } : {}) } }, { exitCode: 1 });
              else { console.error(read.outcome.message); process.exitCode = 1; }
            } else if (json) await printJsonEnvelope({ ok: true, kind, data: { agentId: input.agentId, jobId: started.jobId, version: read.outcome.version, plan: null, logPath: null } });
            else console.log(`${String(input.agentId)} job completed successfully${read.outcome.version ? ` (${read.outcome.version})` : ''}.`);
            return true;
          }
          if (!controller.signal.aborted) await delay(1_000, undefined, { signal: controller.signal }).catch(error => { if (!controller.signal.aborted) throw error; });
        }
      } finally {
        process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
        params.signal?.removeEventListener('abort', onInterrupt);
      }
    } } : {}),
  });
  return true;
}
