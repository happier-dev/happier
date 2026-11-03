import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { AgentRuntimeDaemonServiceRequestV1Schema, AGENT_RUNTIME_DAEMON_SERVICES_PATH } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { configuration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import * as processIdentity from '@/daemon/processIdentity';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createNativeAgentRuntimeSessionPlanFixture, createSessionHostServiceOwners } from './nativeAgentSession.testkit';
import { projectEngineRuntimeContributionFromAgent } from './contributions';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createProviderCliAttachSurface, attachObservedNativeClient } from '@/session/attach/providerCliAttach';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { runTerminalRemoteSessionModeLoop } from '@/agent/runtime/session/loop/runTerminalRemoteSessionModeLoop';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { SessionProviderCliAttachPrepareRequestV1Schema } from '@happier-dev/protocol';
import { createTerminalAttachmentId, readTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { PluginError } from '@happier-dev/plugin-sdk';
import { waitForCondition } from '@/testkit/async/waitFor';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null,
  afterDescriptorWrite: null as (() => Promise<void>) | null }));
// The descriptor is committed by the real owner. Only the OS rename boundary
// is held to reproduce withdrawal after durable staging, before publication.
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    await fs.rename(...args);
    if (typeof args[1] === 'string' && args[1].endsWith('.host.json')) await boundary.afterDescriptorWrite?.();
  } };
});
// Only the other-process daemon listener is substituted; source, private
// authority, dispatcher, original Exec, Session and attach owners remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; boundary.afterDescriptorWrite = null; });
afterAll(() => pluginReloadController.shutdown());

const attachAgent = {
  manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: { agents: [{
    id: 'agent', title: 'Native attach boundary Agent', runtime: { kind: 'custom' }, primary: 'sessions',
    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: false } },
  }] } }),
  // A real installed Agent leaf supplies only its native presentation. It
  // cannot issue an execution identity, and an accidental model turn fails.
  files: {
    'agent.mjs': `export function factory() { return { sessions: { async open(_request, context) { return {
      send: async () => { throw new Error('No model turn in attach admission'); },
      watch: listener => { listener({ kind:'provider-session-id',sessionId:context.session.id,
        providerSessionId:'native-attach-session',emittedAtMs:1,sequence:1 }); return { dispose() {} }; }, dispose: async () => {},
      prepareTerminalPresentation: async () => ({ kind: 'provider_attach', metadata: {} }),
      runtimeCapabilities: { localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach', remoteWritable: true } },
    }; } } }; }`,
    'daemon.mjs': `import { factory } from './agent.mjs'; export function activate(api) {
      api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
    }`,
  },
};

it.skipIf(process.platform === 'win32').for([
  { shape: 'owner-off', hosted: false },
  { shape: 'owner-off', hosted: true },
  { shape: 'member-off', hosted: false },
  { shape: 'unknown', hosted: true },
  { shape: 'owner-on', hosted: true },
  { shape: 'withdrawn-during-host-resolution', hosted: true },
  { shape: 'owner-adoption', hosted: false },
  { shape: 'member-adoption', hosted: false },
  { shape: 'withdrawn-during-adoption-write', hosted: false },
] as const)('retains original requester custody before native attach effects ($shape, hosted=$hosted)', async ({ shape, hosted }, { task }) => {
  await withHerdrApi(async api => {
    api.setServerVersion('0.9.3');
    const lifetime = new AbortController();
    const home = 'srv_s0_attach_agent';
    const member = shape === 'member-off' || shape === 'member-adoption';
    const adoption = shape === 'owner-adoption' || shape === 'member-adoption' || shape === 'withdrawn-during-adoption-write';
    const unknown = shape === 'unknown';
    const custodian = member ? 'company' : 'requester';
    let runnerCommand = '';
    const roots: string[] = [];
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: custodian,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, attachAgent, undefined, {
      credentials, externalActionAccountId: custodian, homeServerIdentityId: home,
      ordinaryAccountSession: !member && !unknown,
      ...(unknown ? { retainIncompleteRequesterCustody: true } : {}),
      machineAccess: { custodianAccountId: custodian, role: 'manage' },
      runnerIdentity: directory => {
        runnerCommand = `${process.execPath} ${join(directory, '.runner-snapshots', 'attach-runner', 'index.mjs')}`;
        return { pid: process.pid, processStartTimeMs: 1, processCommandHash: hashProcessCommand(runnerCommand), snapshotIdentity: 'snapshot:attach-runner' };
      },
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
      agentIsolation: { read: () => ({ enabled: shape === 'owner-on', status: shape === 'owner-on'
        ? { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } : { kind: 'disabled' }, workspaceRoots: roots }) },
    });
    roots.push(h.cwd);
    const realProcessIdentity = processIdentity.readProcessIdentityByPid;
    vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockImplementation(async (pid, dependencies) => pid === h.runner.pid
      ? { pid, processStartTimeMs: h.runner.processStartTimeMs, command: runnerCommand }
      : await realProcessIdentity(pid, dependencies));
    const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing });
    await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
      path: authorityFilePath, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
    const realFetch = globalThis.fetch;
    const privateErrors: string[] = [];
    const privateThrows: string[] = [];
    const privatePhases = { admission: 0, resolved: 0 };
    let finalizedLaunches = 0;
    vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(String(url)).pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await realFetch(url, init);
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
      if (request.operation.kind === 'plugin_exec.resolved_agent_launch.authorize_v1') {
        if (request.operation.phase === 'admit') privatePhases.admission++;
        else privatePhases.resolved++;
      }
      const result = await h.dispatch(request.operation, request.context.executionRunSnapshotId).catch(error => {
        // Only canonical PluginError.code crosses this diagnostic boundary;
        // arbitrary exception messages, arguments and environment never do.
        privateThrows.push(error instanceof PluginError ? error.code : 'non_plugin_error');
        throw error;
      });
      if (!result.ok) privateErrors.push(result.error.code);
      if (result.ok && request.operation.kind === 'plugin_exec.resolved_agent_launch.authorize_v1'
        && request.operation.phase !== 'admit') finalizedLaunches++;
      return Response.json(result);
    });
    const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
      authorityFilePath, expectedSessionId: h.sessionId });
    if (!source) throw new Error('Missing genuine native attach source');
    const nativeRecord = join(h.f.directory, 'attach-os-effects.jsonl');
    const readEffects = async () => {
      const raw = await readFile(nativeRecord, 'utf8').catch(() => '');
      const kinds = raw.trim() ? raw.trim().split('\n').map(line => {
        const value: unknown = JSON.parse(line);
        return value && typeof value === 'object' && 'kind' in value
          && (value.kind === 'version' || value.kind === 'native') ? value.kind : 'unknown';
      }) : [];
      return { versions: kinds.filter(kind => kind === 'version').length, native: kinds.filter(kind => kind === 'native').length,
        unknown: kinds.filter(kind => kind === 'unknown').length };
    };
    const nativePath = join(h.f.directory, 'native-attach-cli');
    const herdrPath = join(h.f.directory, 'herdr-cli');
    // Actual executable and terminal server are the OS/third-party boundary.
    await writeFile(nativePath, `#!${process.execPath}\nconst fs=require('node:fs');const version=process.argv.includes('--version');fs.appendFileSync(${JSON.stringify(nativeRecord)},JSON.stringify({kind:version?'version':'native',pid:process.pid})+'\\n');if(version){console.log('1.0.0');process.exit(0)}process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`, { mode: 0o755 });
    await writeFile(herdrPath, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('herdr 0.9.3');else console.log(${JSON.stringify(JSON.stringify({ sessions: [{ name: 'attach', socket_path: api.socketPath, running: true }] }))});\n`, { mode: 0o755 });
    vi.stubEnv('HERDR_BIN_PATH', herdrPath);
    let withdrawnAfterNativeFinalization = false;
    api.beforeResponse.set('session.snapshot', async () => {
      // The first real finalization belongs to --version, the second to the
      // native tuple. Retire its original credential source only after that
      // tuple is finalized, while the actual terminal adapter awaits Herdr.
      if (shape === 'withdrawn-during-host-resolution' && finalizedLaunches >= 2 && !withdrawnAfterNativeFinalization) {
        await writeStoredCredentialsForServerId(h.f.bootstrap.attribution.serverId,
          { token: 'replacement-account-token', encryption: null });
        withdrawnAfterNativeFinalization = true;
      }
    });
    let native: ChildProcess | null = null;
    api.beforeResponse.set('layout.apply', () => {
      const root = api.requests.at(-1)?.params.root;
      if (!root || typeof root !== 'object' || !('command' in root) || !Array.isArray(root.command)
        || !root.command.every((item): item is string => typeof item === 'string')) throw new Error('Invalid external terminal launch');
      native = spawn(root.command[0]!, root.command.slice(1), { stdio: 'ignore', detached: true });
    });
    api.beforeResponse.set('pane.close', async () => { if (native) await terminateProcessTree(native, { ownedProcessGroup: true }); });
    const session = createMutableApiSessionClientFixture({ sessionId: h.sessionId, metadata: createTestMetadata({ path: h.cwd,
      ...(adoption ? { terminal: { mode: 'herdr',
        herdr: { sessionName: 'attach', socketPath: api.socketPath, paneId: 'managed', terminalId: 'terminal_before_restart' },
        controlServiceabilityV1: { v: 1, attachmentId: createTerminalAttachmentId(), state: 'unknown', observedAt: 1,
          retired: true, reason: 'attachment_retired' } } } : {}),
    }) });
    if (adoption) api.panes.add('managed');
    const attach = createProviderCliAttachSurface({ agentId: source.identity.agentId,
      resolveTarget: () => ({ ok: true, value: { baseUrl: 'http://127.0.0.1:43130' } }),
      createArgs: () => [], cliVersionArgs: ['--version'],
      resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: nativePath, command: nativePath, args: [] }),
    });
    const plan = await createNativeAgentRuntimeSessionPlanFixture({
      identity: source.identity, createRuntime: source.createRuntime, authorizeNewTurn: source.authorizeNewTurn,
      agent: source.agentContribution, backend: projectEngineRuntimeContributionFromAgent(source.agentContribution, source.identity.agentId),
      createInvocationServices: input => source.createInvocationServices({ ...input, pluginId: source.identity.pluginId,
        pluginVersion: source.identity.pluginVersion, agentId: source.identity.agentId, occurrenceId: source.identity.occurrenceId,
        processOwner: { kind: 'session', sessionId: h.sessionId }, isOccurrenceCurrent: source.identity.isCurrent }),
      executionSurfaces: { attach }, createSessionHostServiceOwners, generationSignal: lifetime.signal,
      reportSessionMetadataToDaemon: async () => {},
      resolveProviderCliAttachManagedServiceAccess: source.resolveProviderCliAttachManagedServiceAccess,
      sessionInput: buildPluginSessionBindingInput({ credentials, directory: h.cwd, startedBy: 'daemon', startingMode: 'remote',
        backendTarget: { kind: 'backend', backendId: source.identity.agentId },
        terminalRuntime: { mode: 'plain', requested: hosted ? 'herdr' : 'plain', herdrSessionName: 'attach', herdrSocketPath: api.socketPath } }),
    });
    const created = await plan.config.createSessionRuntime!({ directory: h.cwd, metadata: session.getMetadataSnapshot()!, machineId: 'machine',
      agentTargetKey: `backend:${source.identity.agentId}`, session, transcriptSession: session,
      messageQueue: new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode),
      messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[attach]' }),
      getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false, runnerProcessIdentity: null, startupModelSelection: null,
      async runWithTerminalModelSelection() { throw new Error('Unexpected exclusive terminal selection'); },
    });
    let stopEvents = () => {};
    let modeLoop: ReturnType<typeof runTerminalRemoteSessionModeLoop> | null = null;
    const externalAbort = new AbortController();
    let externalAttach: Promise<unknown> | null = null;
    try {
    expect({
      localControl: created.runtimeCapabilities?.localControl ?? null,
      preparePresentation: typeof created.nativeRuntime?.prepareTerminalPresentation,
      mode: created.terminalRemoteModeLoop !== undefined,
    }).toEqual({ localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach', remoteWritable: true },
      preparePresentation: 'function', mode: true });
    if (!created.terminalRemoteModeLoop) throw new Error('Missing canonical provider attach mode');
    stopEvents = created.operations.subscribeRuntimeEvents(() => {});
    if (adoption) expect(created.operations.readSessionIdentity().sessionId).toBe('native-attach-session');
    modeLoop = runTerminalRemoteSessionModeLoop(created.terminalRemoteModeLoop);
      await vi.waitFor(() => expect(session.rpcHandlerManager.hasHandler('switch')).toBe(true));
      if (adoption) {
        let descriptorWithdrawal = false;
        let externalPhase: 'initial_prepare' | 'awaiting_process' | 'restored_prepare' | 'admitted' | 'settled' = 'initial_prepare';
        let externalOutcome: 'pending' | 'ok' | 'failed' | 'refused' = 'pending';
        const prepareOutcomes: Array<'accepted' | 'refused' | 'threw'> = [];
        boundary.afterDescriptorWrite = async () => {
          if (shape !== 'withdrawn-during-adoption-write' || descriptorWithdrawal) return;
          descriptorWithdrawal = true;
          await writeStoredCredentialsForServerId(h.f.bootstrap.attribution.serverId,
            { token: 'replacement-account-token', encryption: null });
        };
        externalAttach = attachObservedNativeClient({ surface: attach,
          request: { sessionId: session.sessionId, metadata: { path: h.cwd }, signal: externalAbort.signal },
          providerSessionId: 'native-attach-session',
          herdr: { sessionName: 'attach', socketPath: api.socketPath, paneId: 'managed', terminalId: 'terminal_1' },
          observe: async value => {
            const request = SessionProviderCliAttachPrepareRequestV1Schema.parse(value);
            if (request.terminalClient?.attached) {
              externalPhase = 'awaiting_process';
              let nativePid = 0;
              await vi.waitFor(async () => {
                const records: unknown[] = (await readFile(nativeRecord, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
                const record = records.find(value => value && typeof value === 'object' && 'kind' in value && value.kind === 'native');
                if (record && typeof record === 'object' && 'pid' in record && typeof record.pid === 'number') nativePid = record.pid;
                expect(nativePid).toBeGreaterThan(1);
              }, { timeout: task.timeout });
              // This third-party process report is checked against the actual
              // OS census, launcher fingerprint and parent/child ancestry.
              const launcher = request.terminalClient.launcher;
              api.responses.set('pane.process_info', () => ({ process_info: { shell_pid: process.pid, foreground_processes: [
                { pid: launcher.pid, argv: [process.execPath, 'terminal_launch_spec_runner.cjs'] },
                { pid: nativePid, argv: [nativePath] },
              ] } }));
              externalPhase = 'restored_prepare';
            }
            try {
              const outcome = await session.rpcHandlerManager.invokeLocal('session.providerCliAttach.prepare.v1', request);
              const accepted = !!outcome && typeof outcome === 'object' && 'ok' in outcome && outcome.ok === true;
              prepareOutcomes.push(accepted ? 'accepted' : 'refused');
              if (accepted && request.terminalClient?.attached) externalPhase = 'admitted';
              return outcome;
            } catch (error) { prepareOutcomes.push('threw'); throw error; }
          },
        }).then(result => {
          externalPhase = 'settled'; externalOutcome = result.ok ? 'ok' : 'failed'; return { result };
        }, error => {
          externalPhase = 'settled'; externalOutcome = 'refused';
          return { refused: true, code: error instanceof PluginError ? error.code : undefined };
        });
        // November 2 guest fallback: provisioning-off members use the owner's OS user.
        if (shape === 'owner-adoption' || shape === 'member-adoption') {
          let effects = await readEffects();
          // The containing test already owns real process startup/census. Race
          // successful publication against actual external completion, rather
          // than imposing vi.waitFor's unrelated one-second default on it.
          await waitForCondition(async () => {
            effects = await readEffects();
            return (session.getAgentStateSnapshot()?.localControl?.attached === true && prepareOutcomes.length >= 2)
              || externalOutcome !== 'pending';
          }, { timeoutMs: task.timeout, label: 'original native client admission',
            debug: () => JSON.stringify({ externalPhase, externalOutcome, prepareOutcomes, ...effects, privateErrors, privateThrows }) });
          expect({ attached: session.getAgentStateSnapshot()?.localControl?.attached === true, externalOutcome,
            prepareOutcomes, ...effects, privateErrors, privateThrows }).toEqual({ attached: true, externalOutcome: 'pending',
              prepareOutcomes: ['accepted', 'accepted'], versions: 2, native: 1, unknown: 0, privateErrors: [], privateThrows: [] });
          expect(await readTerminalHostAttachmentInfo({ happyHomeDir: h.f.directory, sessionId: h.sessionId }))
            .toMatchObject({ version: 3, lifecycle: 'borrowed', nativeClientProcess: { pid: expect.any(Number) } });
          await expect(session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).resolves.toBe(true);
          await expect(externalAttach).resolves.toMatchObject({ result: { ok: true } });
          expect(await readEffects()).toEqual({ versions: 2, native: 1, unknown: 0 });
        } else {
          await expect(externalAttach).resolves.toMatchObject({ result: { ok: false } });
          expect({ descriptorWithdrawal, privateErrors }).toEqual({ descriptorWithdrawal: true,
            privateErrors: ['agent_isolation_unavailable'] });
        }
        // This observation is before finally/reset. A failed post-write
        // admission must retire its own descriptor, not leave teardown to do it.
        expect(await readTerminalHostAttachmentInfo({ happyHomeDir: h.f.directory, sessionId: h.sessionId })).toBeNull();
        expect(session.getAgentStateSnapshot()?.localControl?.attached).not.toBe(true);
        expect(api.requests.filter(request => request.method === 'layout.apply' || request.method === 'pane.close')).toHaveLength(0);
        return;
      }
      const switched = await session.rpcHandlerManager.invokeLocal('switch', { to: 'local' });
      if (switched === true) await vi.waitFor(async () => expect((await readEffects()).native).toBe(1));
      const effectCounts = { switched, ...await readEffects(), layouts: api.requests.filter(request => request.method === 'layout.apply').length };
      if (shape === 'owner-off' || shape === 'member-off') {
        expect({ ...effectCounts, privateErrors, privateThrows, privatePhases }).toEqual({ switched: true,
          versions: 1, native: 1, unknown: 0, layouts: hosted ? 1 : 0, privateErrors: [], privateThrows: [],
          privatePhases: { admission: expect.any(Number), resolved: 2 } });
        await expect(session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).resolves.toBe(true);
      } else if (shape === 'withdrawn-during-host-resolution') {
        expect({ withdrawnAfterNativeFinalization, finalizedLaunches, ...effectCounts }).toEqual({
          withdrawnAfterNativeFinalization: true, finalizedLaunches: 2,
          switched: false, versions: 1, native: 0, unknown: 0, layouts: 0,
        });
        expect(privateErrors).toContain('agent_isolation_unavailable');
      } else {
        expect(effectCounts).toEqual({ switched: false, versions: 0, native: 0, unknown: 0, layouts: 0 });
        expect(privateErrors).toContain('agent_isolation_unavailable');
      }
    } finally {
      lifetime.abort();
      externalAbort.abort();
      await created.operations.resetOrDisposeRuntime('session_closed');
      await modeLoop;
      await externalAttach;
      stopEvents();
      await source.retire?.();
      if (native) await terminateProcessTree(native, { ownedProcessGroup: true });
      await session.close();
    }
  });
}, 120_000);
