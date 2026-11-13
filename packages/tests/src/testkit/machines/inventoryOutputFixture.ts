import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { vi } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { DaemonTerminalEnsureResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { MachinesAgentsSignInStartOutputSchema } from '@happier-dev/protocol/daemon/agentSignIn';
import { DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agentInstallJobs';
import { RpcHandlerManager } from '../../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import type { ApiMachineClient } from '../../../../../apps/cli/src/api/apiMachine';
import { registerMachineRpcHandlers } from '../../../../../apps/cli/src/api/machine/rpcHandlers';
import { registerMachineTerminalRpcHandlers } from '../../../../../apps/cli/src/api/machine/rpcHandlers.terminal';
import { registerMachineAgentInstallJobRpcHandlers } from '../../../../../apps/cli/src/api/machine/rpcHandlers.agentInstallJobs';
import { registerMachineWorkSummaryRpcHandlers } from '../../../../../apps/cli/src/api/machine/rpcHandlers.machineWorkSummary';
import { registerBashHandler } from '../../../../../apps/cli/src/rpc/handlers/bash';
import { createFilesystemEffectAdmission } from '../../../../../apps/cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerDaemonContributionRegistryProjectionHandler } from '../../../../../apps/cli/src/rpc/handlers/daemonContributionRegistryProjection';
import { createTerminalPtySessionManager } from '../../../../../apps/cli/src/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '../../../../../apps/cli/src/terminal/pty/config';
import type { PtyExitEvent, PtyProcess } from '../../../../../apps/cli/src/terminal/pty/provider';
import { createAgentInstallJobOwner } from '../../../../../apps/cli/src/capabilities/installJobs/agentInstallJobOwner';
import { readCurrentContributionRegistry } from '../../../../../apps/cli/src/agent/catalog/snapshot';
import { createAdmittedPluginRuntimeFixture } from '../../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '../../../../../apps/cli/src/plugins/runtime/reload/singleton';
import { createManagedActivityInventory } from '../../../../../apps/cli/src/daemon/lifecycle/managedActivity';
import { withConfiguredDaemonTestHome } from '../../../../../apps/cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createEnvKeyScope } from '../../../../../apps/cli/src/testkit/env/envScope';
import { createCliMachineActionDeps } from '../../../../../apps/cli/src/session/actions/cliActionDeps/machine';
import { createCliMachineInventoryActionDeps } from '../../../../../apps/cli/src/session/actions/cliActionDeps/machineInventory';
import { createCliActionInventoryDeps } from '../../../../../apps/cli/src/session/actions/cliActionDeps/createCliActionInventoryDeps';
import { createCliMachineActionTransport, type CliMachineActionCall } from '../../../../../apps/cli/src/session/actions/cliActionDeps/machineTransport';
import * as releaseHttpBoundary from '../../../../../apps/cli/src/capabilities/cliUpdate/githubReleaseLookup';
import { createNativeOutputRpcManager, nativeOutputTarget } from './nativeOutputFixture';

type InventoryTarget = typeof nativeOutputTarget;
export type InventoryOutputFixtureOptions = Readonly<{
  /** An already connected real Machine may lend its installed receiving owners. */
  machine?: ApiMachineClient;
  target?: InventoryTarget;
  /** In attached mode this is the real Home/socket transport, including admission. */
  transport?: (method: string, input: unknown) => Promise<unknown>;
  /** Real Home access-list read; a synthetic grant projection is deliberately not supplied. */
  readAccess?: (signal: AbortSignal) => Promise<unknown>;
  directory?: string;
}>;

/** Only the native PTY is substituted. Bytes, stream framing, retained custody,
 * input encoding, restart and close are all produced by the real terminal owner. */
class OutputPty implements PtyProcess {
  readonly pid = 0;
  readonly ownedProcessGroupId = null;
  readonly data = new Set<(data: string) => void>();
  readonly exits = new Set<(event: PtyExitEvent) => void>();
  write(value: string) { for (const listener of this.data) listener(value); }
  resize() {}
  kill() { for (const listener of this.exits) listener({ exitCode: 0 }); }
  onData(listener: (data: string) => void) { this.data.add(listener); return { dispose: () => this.data.delete(listener) }; }
  onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
}

export type InventoryOutputFixture = Awaited<ReturnType<typeof buildInventoryOutputFixture>>;

export async function createInventoryOutputFixture(options: InventoryOutputFixtureOptions = {}): Promise<InventoryOutputFixture> {
  if (options.machine) {
    if (!options.directory || !options.target || !options.transport) throw new Error('Attached inventory fixture needs directory, target and actual Home transport');
    return buildInventoryOutputFixture(options.directory, options);
  }
  let publish!: (fixture: InventoryOutputFixture) => void;
  let fail!: (error: unknown) => void;
  const ready = new Promise<InventoryOutputFixture>((resolve, reject) => { publish = resolve; fail = reject; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let lifetime: Promise<void>;
  lifetime = withConfiguredDaemonTestHome({ prefix: 'machine-output-inventory-',
    env: { HAPPIER_ACTIVE_SERVER_ID: nativeOutputTarget.serverId, HAPPIER_SERVER_URL: undefined } }, async ({ homeDir }) => {
    const fixture = await buildInventoryOutputFixture(homeDir, options);
    publish({ ...fixture, close: async () => { try { await fixture.close(); } finally { release(); } await lifetime; } });
    await released;
  });
  void lifetime.catch(fail);
  return ready;
}

async function buildInventoryOutputFixture(directory: string, options: InventoryOutputFixtureOptions) {
  const target = options.target ?? nativeOutputTarget;
  const inputTarget = { serverId: target.serverId, machineId: target.machineId };
  const managerValue: unknown = options.machine ? Reflect.get(options.machine, 'rpcHandlerManager') : createNativeOutputRpcManager();
  if (!(managerValue instanceof RpcHandlerManager)) throw new Error('Missing actual Machine receiving RPC manager');
  const manager = managerValue;
  const cleanups: Array<() => void | Promise<void>> = [];
  let shutdownRequested = false;
  try {
    const bin = join(directory, 'output-bin');
    await mkdir(bin, { recursive: true });
    const envScope = createEnvKeyScope(['HOME', 'USERPROFILE', 'PATH']);
    envScope.patch({ HOME: directory, USERPROFILE: directory, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` });
    cleanups.push(() => envScope.restore());
    // startDaemon applies plugins before serving their projection. The composed
    // receiver starts its control runtime directly, so supply that real startup
    // prerequisite through the canonical source-admission/publication fixture.
    const pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
      controller: pluginReloadController });
    cleanups.push(() => pluginRuntime.dispose());
    const registry = readCurrentContributionRegistry();
    const loginAgent = registry.agents.find(agent => agent.id === 'codex' && agent.cliMetadata?.auth.support === 'login_terminal')
      ?? registry.agents.find(agent => agent.cliMetadata?.auth.support === 'login_terminal');
    const installAgent = registry.agents.find(agent => agent.runtimeSpec?.managedInstall?.kind === 'github_release_binary');
    if (!loginAgent?.runtimeSpec || !installAgent?.runtimeSpec) throw new Error('Native output fixture requires declared login and GitHub-release Agent runtimes');
    for (const name of new Set(registry.agents.flatMap(agent => agent.runtimeSpec ? [agent.runtimeSpec.binaryName] : []))) {
      await writeFile(join(bin, name), '#!/bin/sh\nprintf "output-fixture 1.0.0\\n"\n', { mode: 0o755 });
    }
    // Keep the real release lookup/cache/parser. Its external HTTP response is
    // unavailable, so installation cannot fetch or replace a host dependency.
    const realLatest = releaseHttpBoundary.fetchGitHubLatestRelease;
    const latest = vi.spyOn(releaseHttpBoundary, 'fetchGitHubLatestRelease').mockImplementation(params => realLatest({
      ...params, fetchImpl: async () => new Response('', { status: 503 }), bypassCache: true,
    }));
    cleanups.push(() => latest.mockRestore());
    if (!options.machine) {
      const lifecycle = registerMachineRpcHandlers({ rpcHandlerManager: manager,
        handlers: { spawnSession: async () => { throw new Error('Unexpected Session launch'); },
          stopSession: async () => true, requestShutdown: () => { shutdownRequested = true; } },
        deps: { currentServerId: target.serverId, currentMachineId: target.machineId,
          workingDirectory: directory, resolveHostHomeServerIdentityId: async () => target.serverId,
          filesystemEffectAdmission: createFilesystemEffectAdmission({
            resolveHostIdentity: async () => target, resolveHomeServerIdentityId: async () => target.serverId,
          }) } });
      cleanups.push(() => lifecycle.dispose());
      registerBashHandler(manager, directory, { resolveHostHomeServerIdentityId: async () => target.serverId });
      registerDaemonContributionRegistryProjectionHandler(manager, {
        resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: target.serverId, machineId: target.machineId }),
      });
    }
    const terminals = createTerminalPtySessionManager({ ptyProvider: { spawn: () => new OutputPty() },
      config: readDaemonTerminalPtyConfig({}).sessionManager, env: { ...process.env, HOME: directory },
      probeProcessGroup: () => 'absent', stopProcessTree: async () => {} });
    const terminalRegistration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: manager, deps: {
      sessionManager: terminals, env: { ...process.env, HOME: directory }, workingDirectory: directory,
      serverId: target.serverId, resolveHostHomeServerIdentityId: async () => target.serverId,
    } });
    cleanups.push(() => terminalRegistration.dispose());
    const jobs = createAgentInstallJobOwner({ accountId: target.custodianAccountId,
      env: { HOME: directory, HAPPIER_HOME_DIR: directory, PATH: bin }, readTrackedSessions: () => [],
      readRegistry: () => ({ agents: [installAgent], managedDependencies: registry.managedDependencies }),
      installerDeps: { fetchGitHubLatestRelease: async () => { throw new Error('Fixture release service is unavailable'); } } });
    cleanups.push(() => jobs.shutdown());
    registerMachineAgentInstallJobRpcHandlers({ rpcHandlerManager: manager, owner: jobs });
    const activity = createManagedActivityInventory({ producers: [terminals.getLiveWorkProducer(), jobs.activity] });
    cleanups.push(() => activity.dispose());
    if (options.readAccess) registerMachineWorkSummaryRpcHandlers({ rpcHandlerManager: manager,
      target: { ...inputTarget, installationId: target.installationId }, custodianAccountId: target.custodianAccountId,
      activity, readAccess: options.readAccess });

    const rpc = options.transport ?? ((method: string, input: unknown) => manager.handleRequest({
      method: `${target.machineId}:${method}`, params: input, requestId: randomUUID(), callerAuthority: 'present_user',
      machineAdmission: { machineId: target.machineId, installationId: target.installationId,
        custodianAccountId: target.custodianAccountId, actorAccountId: target.custodianAccountId, role: 'manage', encryptionMode: 'plain' },
    }));
    const callMachineAction: CliMachineActionCall = request => rpc(request.method, request.request);
    const params = { credentials: { token: 'native-output-transport', encryption: null }, token: 'native-output-transport', serverId: target.serverId,
      serverIdentityId: target.serverId };
    const { isMachineActionServerScopeCurrent } = createCliMachineActionTransport(params);
    const machineDeps = createCliMachineActionDeps(params, { callMachineAction, isMachineActionServerScopeCurrent });
    const inventoryDeps = createCliMachineInventoryActionDeps(params, { callMachineAction,
      inventoryDeps: createCliActionInventoryDeps({ ...params, sessionId: '', mode: 'plain', ctx: null, callMachineAction }) });
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', serverId: target.serverId,
      externalActionTarget: { kind: 'machine', machineId: target.machineId,
        project: { machineId: target.machineId, directory } } };

    const invoke = async (id: ActionId, raw: unknown): Promise<unknown> => {
      // Action schemas are the boundary. The cast below restores the correlated
      // Action/dependency union erased by the aggregate fixture's unknown input.
      const input = getActionSpec(id).inputSchema.parse(raw);
      if (id === 'machines.command.run') return machineDeps.machineCommandRun!(input as Parameters<NonNullable<typeof machineDeps.machineCommandRun>>[0], context);
      if (id === 'machines.work.summary.get') {
        if (!options.readAccess) throw new Error('Work summary output requires a real Home access-list reader');
        return machineDeps.machineWorkSummaryGet!({ input, context } as Parameters<NonNullable<typeof machineDeps.machineWorkSummaryGet>>[0]);
      }
      if (id.startsWith('machines.terminal.')) return machineDeps.machineTerminalAction!({ actionId: id, input, context } as Parameters<NonNullable<typeof machineDeps.machineTerminalAction>>[0]);
      if (id === 'machines.agents.list') return inventoryDeps.machinesAgentsList!(input as Parameters<NonNullable<typeof inventoryDeps.machinesAgentsList>>[0], context);
      if (id === 'machines.agents.signIn.start') return inventoryDeps.machineAgentSignInStart!(input as Parameters<NonNullable<typeof inventoryDeps.machineAgentSignInStart>>[0]);
      if (id === 'machines.agents.signIn.status') return inventoryDeps.machineAgentSignInStatus!(input as Parameters<NonNullable<typeof inventoryDeps.machineAgentSignInStatus>>[0], context);
      if (id === 'machines.agents.signIn.cancel' || id === 'machines.agents.signIn.restart') {
        const operation = id === 'machines.agents.signIn.cancel' ? inventoryDeps.machineAgentSignInCancel! : inventoryDeps.machineAgentSignInRestart!;
        return operation(input as Parameters<typeof operation>[0]);
      }
      if (id === 'machines.agents.install' || id === 'machines.agents.uninstall') {
        const request = input as Parameters<NonNullable<typeof machineDeps.machineAgentInstallStart>>[0];
        return machineDeps.machineAgentInstallStart!({ ...request, consent: request.consent ?? { vendorRecipe: false }, intent: id === 'machines.agents.uninstall' ? 'uninstall' : request.intent,
          context, effectActionId: id });
      }
      if (id === 'machines.agents.install.status') return machineDeps.machineAgentInstallRead!({ ...input as Parameters<NonNullable<typeof machineDeps.machineAgentInstallRead>>[0], context, effectActionId: id });
      if (id === 'machines.agents.install.cancel') return machineDeps.machineAgentInstallCancel!({ ...input as Parameters<NonNullable<typeof machineDeps.machineAgentInstallCancel>>[0], context, effectActionId: id });
      return machineDeps.machinePageAction!({ actionId: id, input, context } as Parameters<NonNullable<typeof machineDeps.machinePageAction>>[0]);
    };
    const openTerminal = async (terminalKey = randomUUID()) => {
      const opened = DaemonTerminalEnsureResponseSchema.parse(await invoke('machines.terminal.open', { ...inputTarget, terminalKey, cwd: directory }));
      if (!opened.ok) throw new Error(`Native terminal producer refused: ${opened.errorCode}`);
      await invoke('machines.terminal.write', { ...inputTarget, terminalId: opened.terminalId,
        event: { t: 'text', text: 'producer bytes\n' } });
      return opened.terminalId;
    };
    const startSignIn = async () => {
      const started = MachinesAgentsSignInStartOutputSchema.parse(await invoke('machines.agents.signIn.start', { machineId: target.machineId, agentId: loginAgent.id, method: 'native' }));
      if (!('terminalId' in started)) throw new Error('Native sign-in producer did not acquire a terminal');
      return started.terminalId;
    };
    const startInstall = async () => {
      const started = DaemonAgentInstallStartResponseSchema.parse(await invoke('machines.agents.install', {
        machineId: target.machineId, agentId: installAgent.id, intent: 'install', consent: { vendorRecipe: false } }));
      if (!started.ok) throw new Error(`Native install producer refused: ${started.errorCode}`);
      return started.jobId;
    };
    return { target: inputTarget, directory, loginAgentId: loginAgent.id, installAgentId: installAgent.id,
      invoke, openTerminal, startSignIn, startInstall, shutdownRequested: () => shutdownRequested,
      close: async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } };
  } catch (error) { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); throw error; }
}

type InventoryCase = Readonly<{ input(fixture: InventoryOutputFixture): unknown | Promise<unknown>;
  execute?(fixture: InventoryOutputFixture, input: unknown): Promise<unknown> }>;
export const inventoryOutputCases = new Map<ActionId, InventoryCase>([
  ['machines.agents.list', { input: f => ({ machineId: f.target.machineId, agentId: f.loginAgentId }) }],
  ['machines.agents.signIn.start', { input: f => ({ machineId: f.target.machineId, agentId: f.loginAgentId, method: 'native' }) }],
  ['machines.agents.signIn.status', { input: f => ({ machineId: f.target.machineId, agentId: f.loginAgentId }) }],
  ['machines.agents.signIn.cancel', { input: async f => ({ machineId: f.target.machineId, agentId: f.loginAgentId, terminalId: await f.startSignIn() }) }],
  ['machines.agents.signIn.restart', { input: async f => ({ machineId: f.target.machineId, agentId: f.loginAgentId, terminalId: await f.startSignIn() }) }],
  ['machines.agents.install', { input: f => ({ machineId: f.target.machineId, agentId: f.installAgentId, intent: 'install', consent: { vendorRecipe: false } }) }],
  ['machines.agents.uninstall', { input: f => ({ machineId: f.target.machineId, agentId: f.installAgentId }) }],
  ['machines.agents.install.status', { input: async f => ({ machineId: f.target.machineId, jobId: await f.startInstall(), cursor: 0, waitForTerminal: true }) }],
  ['machines.agents.install.cancel', { input: async f => ({ machineId: f.target.machineId, jobId: await f.startInstall() }) }],
  ['machines.terminal.open', { input: f => ({ ...f.target, terminalKey: randomUUID(), cwd: f.directory }) }],
  ['machines.terminal.list', { input: f => f.target }],
  ['machines.terminal.read', { input: async f => ({ ...f.target, terminalId: await f.openTerminal(), byteOffset: 0 }) }],
  ['machines.terminal.write', { input: async f => ({ ...f.target, terminalId: await f.openTerminal(), event: { t: 'text', text: 'producer bytes\n' } }) }],
  ['machines.terminal.close', { input: async f => ({ ...f.target, terminalId: await f.openTerminal() }) }],
  ['machines.terminal.restart', { input: async f => {
    await f.openTerminal('output-restart');
    return { ...f.target, terminalKey: 'output-restart', cwd: f.directory };
  } }],
  ['machines.command.run', { input: () => ({ command: 'echo output-producer' }) }],
  ['machines.work.summary.get', { input: f => f.target }],
  ['machines.capabilities.detect', { input: f => f.target }],
  ['machines.capabilities.install', { input: f => ({ ...f.target, capabilityId: 'dep.gh', method: 'install' }) }],
  ['machines.runs.list', { input: f => f.target }],
  ['machines.daemon.stop', { input: f => f.target }],
]);
