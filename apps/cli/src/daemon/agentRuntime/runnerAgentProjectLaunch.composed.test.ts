import { afterEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectTrustContentV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { ProjectTrustMutationRequestV1Schema, ProjectTrustReadRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { prepareProjectAgentLaunch } from '@/workspaces/projectSetup/projectAgentLaunch';
import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';
import { createProjectSetupSuccessStore } from '@/workspaces/projectSetup/projectSetupSuccess';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import type { PtyProcess, PtyExitEvent, PtySpawnParams } from '@/terminal/pty/provider';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { authorizePluginExecLaunchForHost, createStablePluginExecService, issueAgentNativeLaunchQualifierForHost,
  type ProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createRunnerAgentProjectLaunchInvocation } from './runnerAgentProjectLaunch';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { createExecutionRunHostBackendFromConversationRuntime, type AgentExecutionRunRuntimeContextV1,
  type AgentExecutionRunOpenRequest, type AgentExecutionRunConversationEventV1, type AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromSessionRuntime } from '@happier-dev/plugin-sdk/host/registration';
import { createCodexAppServerRuntime } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime';
import { createCodexNativeAppServerClient } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';
import { createCodexNativeAppServerSessionRuntime } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import type { AgentSessionRuntimeEvent, AgentExecutionRunEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { bindRequesterSessionRuntimeMachineAdmissionCurrentness } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { MachineAdmissionVerifyResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { performance } from 'node:perf_hooks';
import { logger } from '@/utils/logger';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createNativeAgentExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function harness(options: Readonly<{ setup?: boolean; trusted?: boolean; boundRequester?: boolean }> = {}) {
  const f = await createProjectSessionRuntimeFixture(options.boundRequester ? { boundSessionId: 'session' } : {});
  await writeStoredCredentialsForServerId('session-home', { token: 'custodian-token', encryption: null });
  const custodianCredentials = await readStoredCredentialsForServerId('session-home');
  if (!custodianCredentials) throw new Error('Missing real installed custodian credentials');
  // Machine lookup is an HTTP boundary; Session-custody preparation must not
  // need a foreign Machine or a second ApiClient/Session runtime.
  const api = { getMachine: async () => null };
  const cwd = join(f.directory, 'accepted-project');
  await mkdir(join(cwd, '.happier'), { recursive: true });
  const manifest = { version: 1, environment: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
    ...(options.setup ? { workspace: { setup: [{ kind: 'command', command: 'printf setup' }] } } : {}) };
  await writeFile(join(cwd, '.happier/project.json'), JSON.stringify(manifest));
  await writeFile(join(cwd, 'mise.toml'), '[env]\nNATIVE = "active"\n');
  let projectKey = 'project';
  let rowRevision = 1;
  let trust: ProjectTrustContentV1 | null = null;
  let trustWrites = 0;
  const accountReadTokens: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    accountReadTokens.push(options?.headers?.Authorization);
    if (String(url).endsWith('/admission/verify')) return { status: 200,
      data: MachineAdmissionVerifyResponseV1Schema.parse({ v: 1, ok: true }) };
    if (String(url).endsWith('/project-trust/read')) {
      const requested = ProjectTrustReadRequestV1Schema.parse(body).project;
      const found = trust?.t === 'plain' && trust.v.project.serverId === requested.serverId && trust.v.project.projectId === requested.projectId;
      return { status: 200, data: found ? { status: 'present', revision: 1, content: trust } : { status: 'absent' } };
    }
    if (String(url).endsWith('/project-trust/mutate')) {
      trustWrites++;
      trust = ProjectTrustMutationRequestV1Schema.parse(body).content;
      return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
    }
    if (String(url).endsWith('/project-rows/list')) {
      const key = { kind: 'workspace-ref', serverId: 'session-home', id: 'workspace' };
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [{ key, revision: rowRevision,
        content: { t: 'plain', v: { key, value: { id: 'workspace', serverId: 'session-home', machineId: 'machine',
          rootPath: cwd, projectKey, createdAtMs: 1 } } } }] } };
    }
    throw new Error(`Unexpected Home write: ${new URL(String(url)).pathname}`);
  });
  if (options.boundRequester) bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap: f.bootstrap,
    boundary: { machineId: 'machine', daemonToken: 'custodian-token', isHomeCurrent: f.isHomeCurrent, readInstallation: () => f.installation } });
  let nativeEffects = 0;
  let toolReads = 0;
  let available = true;
  let duringNative: (() => Promise<void>) | undefined;
  // Installed tool discovery and native process IO are the OS boundary. The
  // Project/Account/trust/effect/Exec admission graph remains production code.
  const environmentIo: ProjectNativeEnvironmentIoForHost = {
    resolveTool: async () => available ? { executablePath: '/tools/mise', version: '2026.10.4' } : null,
    async run() { nativeEffects++; await duringNative?.(); return { exitCode: 0, stdout: 'PATH=/native/bin\0NATIVE=active\0' }; },
    createInvocation: () => environmentIo,
  };
  const nativeIo = { commandIo: { resolveTool: async () => {
    toolReads++;
    return available ? { executablePath: '/tools/mise', version: '2026.10.4' } : null;
  } }, environmentIo };
  const controller = new AbortController();
  const signal = controller.signal;
  const ingress = { signal, requesterSessionBootstrap: f.bootstrap };
  const spawned: Array<{ launch: PtySpawnParams; exit(code: number): void }> = [];
  const terminalSessions = createTerminalPtySessionManager({ ptyProvider: { spawn(launch) {
    const listeners = new Set<(event: PtyExitEvent) => void>();
    const pty: PtyProcess = { pid: 12345, ownedProcessGroupId: 12345, write() {}, resize() {}, kill() {},
      onData: () => ({ dispose() {} }),
      onExit(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; } };
    spawned.push({ launch, exit: exitCode => { for (const listener of listeners) listener({ exitCode, signal: 0 }); } });
    return pty;
  } }, probeProcessGroup: () => 'absent', stopProcessTree: async () => {},
    config: readDaemonTerminalPtyConfig({}).sessionManager, env: { SHELL: '/bin/bash' }, platform: 'linux' });
  onTestFinished(() => terminalSessions.dispose());
  const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'custodian',
    supportsCoreCancellation: () => true,
    custodyBinding: { serverId: 'session-home', installationId: f.installation.installationId } });
  const admission = createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
    readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }) });
  const factory = createInstalledProjectFiniteRuntime({ api, credentials: custodianCredentials,
    externalActionAccountId: 'custodian', finiteServerId: 'session-home', finiteServerHttpBaseUrl: 'https://session-home.test', registeredMachineId: 'machine',
    admission, nativeIo, successHomeDir: join(f.directory, 'success'), isCurrent: async () => true,
    prepareBetween: async () => { throw new Error('No worker preparation expected'); }, resolveCurrentMachineExecutionOriginContext: async () => null });
  const resolveRuntime = (context: typeof ingress) => factory({ operationRuntime, terminalSessions }, context);
  const runtime = await resolveRuntime(ingress);
  if (!runtime) throw new Error('Missing installed Session Project runtime');
  const reviewed = await prepareProjectAgentLaunch({ cwd, machineId: 'machine', serverId: 'session-home', serverHttpBaseUrl: 'https://session-home.test',
    account: projectRuntimeAccountRowsInput(runtime), nativeIo: runtime.nativeIo, successHomeDir: runtime.successHomeDir,
    platform: { os: (runtime.platform ?? process.platform) === 'win32' ? 'windows' : runtime.platform ?? process.platform,
      arch: runtime.arch ?? process.arch }, signal });
  if (reviewed.kind !== 'prepared') throw new Error(`Project review failed: ${JSON.stringify(reviewed)}`);
  const plan = reviewed.outcome.plan;
  if (options.trusted !== false) await createProjectSetupTrustClient({ credentials: f.bootstrap.credentials, serverHttpBaseUrl: 'https://session-home.test' })
    .approveReviewedEffect({ project: plan.project, expectedRevision: 'absent', authority: 'present_user',
      reviewedEffectDigest: plan.reviewedEffectDigest, currentEffectDigest: plan.reviewedEffectDigest, approvedAtMs: 1 });
  let runnerCurrent = true;
  const invocation = createRunnerAgentProjectLaunchInvocation({ cwd, signal, sessionId: 'session',
    requester: { bootstrap: f.bootstrap, isCurrent: f.bootstrap.isCurrent }, isCurrent: () => runnerCurrent,
    resolveRuntime: context => factory({ operationRuntime, terminalSessions }, context) });
  onTestFinished(() => invocation.disposeProjectAgentLaunch());
  const executable = { kind: 'systemTool' as const, id: 'fixture.agent' };
  const service = createStablePluginExecService({  signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => ({ command: '/installed/agent', args: ['installed-agent'] }), resolvePath: async () => cwd,
    prepareAgentNativeLaunch: invocation.prepareAgentNativeLaunch });
  const launch = () => authorizePluginExecLaunchForHost(service, { executable, cwd, args: ['--resume'], env: { ORIGINAL: 'host' } },
    { nativeLaunch: issueAgentNativeLaunchQualifierForHost(service) });
  const missingCustody = createRunnerAgentProjectLaunchInvocation({ cwd, signal, isCurrent: () => true,
    resolveRuntime: context => factory({ operationRuntime, terminalSessions }, context) });
  onTestFinished(() => missingCustody.disposeProjectAgentLaunch());
  const missingCustodyService = createStablePluginExecService({  signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => ({ command: '/installed/agent' }), resolvePath: async () => cwd,
    prepareAgentNativeLaunch: missingCustody.prepareAgentNativeLaunch });
  const scope = { accountId: f.bootstrap.attribution.accountId, machineId: 'machine', sessionId: 'session' };
  let coldOperationId: string | undefined;
  const launchWithOperation = async (concurrent = false) => {
    let authorized: Awaited<ReturnType<typeof launch>> | undefined;
    const result = await operationRuntime.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'original-cold-start' },
      sessionId: 'session', rpcContext: ingress, execute: async operation => {
        coldOperationId = operation.operationAcceptance?.operationId;
        const retained = createRunnerAgentProjectLaunchInvocation({ cwd, signal: operation.signal, sessionId: 'session',
          requester: { bootstrap: f.bootstrap, isCurrent: f.bootstrap.isCurrent }, isCurrent: () => true,
          operation: operation satisfies ProjectSetupOperationContext,
          resolveRuntime: context => factory({ operationRuntime, terminalSessions }, context) });
        onTestFinished(() => retained.disposeProjectAgentLaunch());
        const retainedService = createStablePluginExecService({  signal: operation.signal,
          isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: '/installed/agent' }), resolvePath: async () => cwd,
          prepareAgentNativeLaunch: retained.prepareAgentNativeLaunch });
        const authorize = () => authorizePluginExecLaunchForHost(retainedService, { executable, cwd },
          { nativeLaunch: issueAgentNativeLaunchQualifierForHost(retainedService) });
        if (concurrent) {
          const launches = await Promise.all([authorize(), authorize()]);
          authorized = launches[0];
          await launches[1].release();
        } else authorized = await authorize();
        return { ok: true, result: {} };
      } });
    if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
    if (!authorized) throw new Error('Original launch did not complete');
    return authorized;
  };
  return { launch, launchWithOperation, spawned, cwd, admission, scope, invocation,
    projectLaunchContext: { requester: { bootstrap: f.bootstrap, isCurrent: f.bootstrap.isCurrent }, isCurrent: () => true,
      resolveRuntime: (context: Parameters<typeof factory>[1]) => factory({ operationRuntime, terminalSessions }, context) },
    operation: () => coldOperationId ? operationRuntime.store.get(scope, coldOperationId) : null,
    decide: (digest: string, skipForInvocation = false) => operationRuntime.decideSetupReview(scope, coldOperationId!,
      { serverId: 'session-home', machineId: 'machine', workspaceId: 'workspace', rootPath: cwd }, 'setup',
      { reviewedEffectDigest: digest, skipForInvocation }),
    cancel: () => operationRuntime.runner.cancel(scope, coldOperationId!),
    trustWrites: () => trustWrites,
    operations: () => operationRuntime.store.list(scope).items,
    completion: () => createProjectSetupSuccessStore({ homeDir: runtime.successHomeDir! }).read({
      serverId: 'session-home', machineId: 'machine', workspaceRefId: 'workspace' }),
    async remember(digest: string, operationId = coldOperationId) {
      await createProjectSetupTrustClient({ credentials: f.bootstrap.credentials, serverHttpBaseUrl: 'https://session-home.test' })
        .approveReviewedEffect({ project: plan.project, expectedRevision: 'absent', authority: 'present_user',
          reviewedEffectDigest: digest, currentEffectDigest: digest, approvedAtMs: 2 });
      await operationRuntime.handlers.getV2({ operationId: operationId!, refreshSetupReview: true }, ingress);
    },
    clearTrust: () => { trust = null; },
    async changeSetup() { await writeFile(join(cwd, '.happier/project.json'), JSON.stringify({ ...manifest,
      workspace: { setup: [{ kind: 'command', command: 'printf changed' }] } })); },
    reassignProject() { projectKey = 'replacement-project'; rowRevision++; },
    retireRunner: () => { runnerCurrent = false; },
    nativeEffects: () => nativeEffects, toolReads: () => toolReads, unavailable: () => { available = false; },
    accountReadTokens: () => [...accountReadTokens],
    launchWithoutRequester: () => authorizePluginExecLaunchForHost(missingCustodyService, { executable, cwd },
      { nativeLaunch: issueAgentNativeLaunchQualifierForHost(missingCustodyService) }),
    async selectChild() { await writeFile(join(cwd, '.happier/project.json'), JSON.stringify({ ...manifest, devcontainer: {} })); },
    async markCompleted() { await createProjectSetupSuccessStore({ homeDir: runtime.successHomeDir! }).recordCompletion({
      serverId: 'session-home', machineId: 'machine', workspaceRefId: 'workspace' }, { v: 1, workspaceRefId: 'workspace',
      ...plan.successBasis, completedAtMs: 1 }); },
    changeProjectDuringNative() { duringNative = async () => { projectKey = 'reassigned-project'; rowRevision++; }; },
    duringNative(work: () => Promise<void>) { duringNative = work; },
  };
}

it('retains a known host executable-resolution refusal before native input dispatch', async () => {
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  let executableDispatches = 0;
  const exec = createStablePluginExecService({
    signal: controller.signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => { executableDispatches++; return { command: process.execPath }; },
    resolvePath: async () => process.cwd(),
  });
  const runtime = createCodexAppServerRuntime({ directory: process.cwd(), happierSessionId: 'session', host: {
    baseProcessEnv: {}, logger: { debug() {}, warn() {} },
    accountUsage: { resolveSourceContext: async () => null, recordSnapshot: async () => ({ status: 'recorded' }),
      adoptProvisionalRecord: async () => ({ status: 'adopted', fromRecordId: 'from', toRecordId: 'to' }) },
    createClient: async () => await createCodexNativeAppServerClient({ exec, processEnv: {},
      transport: { kind: 'daemonProxy' }, signal: controller.signal }),
  } });
  const native = createCodexNativeAppServerSessionRuntime(runtime, 'session');
  const host = await createExecutionRunHostBackendFromSessionRuntime({ sessionId: 'session', openSession: () => native,
    request: { kind: 'resume', checkpointId: 'thread', runId: 'run', cwd: process.cwd(),
      profile: { pluginId: 'acme.agent', localId: 'delegate' } } });
  onTestFinished(() => host.dispose());
  const result = await host.send({ text: 'Start' }, { localInputId: 'input' });
  expect(executableDispatches).toBe(0);
  expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'plugin_exec_system_tool_resolution_unavailable' } });
});

it.each(['before_launch', 'after_dispatch'] as const)('preserves native input custody across a known host refusal: %s', async phase => {
  const h = await harness();
  let turnDispatched = false;
  const appServer = createCodexAppServerRuntime({ directory: h.cwd, happierSessionId: 'session', host: {
    baseProcessEnv: {}, logger: { debug() {}, warn() {} },
    accountUsage: { resolveSourceContext: async () => null, recordSnapshot: async () => ({ status: 'recorded' }),
      adoptProvisionalRecord: async () => ({ status: 'adopted', fromRecordId: 'from', toRecordId: 'to' }) },
    async createClient() {
      // Native process/transport boundary: real host Project and Exec admission
      // must complete before this fixture can receive any native turn.
      const launch = await h.launch();
      await launch.release();
      return { launchFeatures: { realtimeConversationAdvertised: false },
        async request(method) {
          if (method === 'thread/start') return { thread: { id: 'native-thread' } };
          if (method === 'turn/start') {
            turnDispatched = true;
            h.retireRunner();
            await h.launch();
            throw new Error('Expected the retired runner to refuse launch');
          }
          return {};
        },
        async notify() {}, registerRequestHandler: () => () => {}, registerNotificationHandler: () => () => {},
        onExit: () => () => {}, async dispose() {},
      };
    },
  } });
  const native = createCodexNativeAppServerSessionRuntime(appServer, 'session');
  onTestFinished(() => native.dispose());
  const events: AgentSessionRuntimeEvent[] = [];
  native.watch(event => events.push(event));
  if (phase === 'before_launch') {
    h.retireRunner();
    await expect(h.launch()).rejects.toMatchObject({ code: 'project_requester_credentials_unavailable' });
  }
  const host = await createExecutionRunHostBackendFromSessionRuntime({ sessionId: 'session', openSession: () => native,
    request: { kind: 'resume', checkpointId: 'thread', runId: 'run', cwd: h.cwd,
      profile: { pluginId: 'acme.agent', localId: 'delegate' } } });
  const runEvents: AgentExecutionRunEvent[] = [];
  host.watch(event => runEvents.push(event));
  onTestFinished(() => host.dispose());
  const result = await host.send({ text: 'Start' }, { localInputId: 'input' });
  expect(turnDispatched).toBe(phase === 'after_dispatch');
  expect(result).toMatchObject(phase === 'before_launch'
    ? { status: 'rejected', diagnostic: { code: 'project_requester_credentials_unavailable' } }
    : { status: 'unavailable', diagnostic: { code: 'codex_send_outcome_unknown' } });
  expect(events.some(event => event.kind === 'input-custody-unknown')).toBe(phase === 'after_dispatch');
  expect(events.some(event => event.kind === 'input-accepted')).toBe(false);
  expect(runEvents).toContainEqual(expect.objectContaining({ kind: 'run-failed', diagnostic: {
    code: phase === 'before_launch' ? 'project_requester_credentials_unavailable' : 'codex_send_outcome_unknown',
    severity: 'error', message: expect.any(String),
  } }));
  if (phase === 'before_launch') expect(h.nativeEffects()).toBe(0);
  if (phase === 'before_launch') await expect(h.launch()).rejects.toMatchObject({
    execLaunch: 'notStarted', data: { execLaunch: 'notStarted' } });
});

it('remeasures native Project inputs once per launch checkpoint without repeating full preparation', async () => {
  const h = await harness();
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = h.toolReads();
    const startedAt = performance.now();
    const launch = await h.launch();
    await launch.release();
    const toolReads = h.toolReads() - before;
    console.info('R7 Project native preparation source measurement', {
      attempt, durationMs: Math.round(performance.now() - startedAt), toolReads,
    });
    // Installed tool identity is genuine OS-boundary work. One initial review
    // and the three Exec checkpoints each remeasure it once; a second launch
    // must do the same fresh work rather than reuse settled admission.
    expect(toolReads).toBe(4);
    expect(h.nativeEffects()).toBe(attempt + 1);
  }
});

it('shares requester authority reads within each native launch checkpoint and starts fresh for the next preparation', async () => {
  const h = await harness({ boundRequester: true });
  const get = vi.mocked(axios.get);
  const post = vi.mocked(axios.post);
  const read = get.getMockImplementation()!;
  const write = post.getMockImplementation()!;
  // A small deterministic transport delay exposes repeated serial Home reads;
  // it is fixture cost, never a production deadline or performance assertion.
  get.mockImplementation(async (...args) => { await new Promise(resolve => setTimeout(resolve, 2)); return read(...args); });
  post.mockImplementation(async (...args) => { await new Promise(resolve => setTimeout(resolve, 2)); return write(...args); });
  for (let attempt = 0; attempt < 2; attempt++) {
    get.mockClear(); post.mockClear();
    const startedAt = performance.now();
    const launch = await h.launch();
    await launch.release();
    const sessionReads = get.mock.calls.filter(([url]) => String(url).endsWith('/v2/sessions/session')).length;
    const profileReads = get.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/profile')).length;
    const accessReads = get.mock.calls.filter(([url]) => String(url).endsWith('/v1/machines/machine/access')).length;
    const admissionReads = post.mock.calls.filter(([url]) => String(url).endsWith('/admission/verify')).length;
    console.info('FIX68 native authorization source measurement', { attempt, durationMs: Math.round(performance.now() - startedAt),
      sessionReads, profileReads, accessReads, admissionReads });
    // One preparation and Exec's three incumbent checkpoints: before native
    // environment production, before secret release, and before final launch.
    expect({ sessionReads, profileReads, accessReads, admissionReads }).toEqual({
      sessionReads: 4, profileReads: 4, accessReads: 4, admissionReads: 8,
    });
  }
});

it.each(['secret release', 'final launch'])('refuses Home revocation before %s even when nested checks share an observation', async checkpoint => {
  const h = await harness({ boundRequester: true });
  const post = vi.mocked(axios.post);
  const write = post.getMockImplementation()!;
  let revoked = false;
  let nativeProduced = false;
  post.mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path.endsWith('/admission/verify') && revoked) return { status: 403, data: { error: 'access_denied' } };
    const result = await write(...args);
    // The post-environment checkpoint remeasures Project trust before final
    // launch. Revoke after its fresh authority read to distinguish the last
    // launch check from the earlier secret-release check.
    if (nativeProduced && checkpoint === 'final launch' && path.endsWith('/project-trust/read')) revoked = true;
    return result;
  });
  h.duringNative(async () => { nativeProduced = true; if (checkpoint === 'secret release') revoked = true; });
  await expect(h.launch()).rejects.toMatchObject({ code: 'project_requester_credentials_unavailable' });
  expect(h.nativeEffects()).toBe(1);
});

it('prepares a fresh zero-step native Project through installed Session custody before final Agent authorization', async () => {
  const h = await harness();
  const launch = await h.launch();
  try {
    expect(launch).toMatchObject({ command: '/installed/agent', args: ['installed-agent', '--resume'], cwd: h.cwd,
      env: { PATH: '/native/bin', NATIVE: 'active' } });
    expect(launch.env).not.toHaveProperty('ORIGINAL');
    expect(h.nativeEffects()).toBe(1);
  } finally { await launch.release(); }
});

it('prepares a detached Run through its production invocation services and issued native launch qualifier', async () => {
  const h = await harness();
  const executable = { kind: 'systemTool' as const, id: 'fixture.agent' };
  const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
    exec: { resolveExecutable: async () => ({ command: '/installed/agent', args: ['installed-agent'] }), resolvePath: async () => h.cwd } });
  onTestFinished(() => owners.dispose());
  const services = owners.createOperationServices({ plugin: { id: 'acme.agent', version: '1.0.0' },
    contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' }, occurrenceId: 'run-occurrence',
    correlationId: 'detached-run', surface: 'agent', signal: new AbortController().signal, isOccurrenceCurrent: () => true }, {
    filesystemRoots: { pluginData: h.cwd, workspace: h.cwd, projects: new Map() },
    hostAccessRequests: [{ required: true, request: { id: 'agent', capability: 'process', reason: 'Launch Agent', scope: { executables: [executable] } } }],
    prepareAgentNativeLaunch: h.invocation.prepareAgentNativeLaunch,
  });
  const generic = await authorizePluginExecLaunchForHost(services.exec, { executable, cwd: h.cwd });
  await generic.release();
  expect(h.nativeEffects()).toBe(0);
  const runtime: AgentRuntime = { executionRuns: { async open(_request, context) {
    expect('session' in context).toBe(false);
    const launch = await authorizePluginExecLaunchForHost(context.services.exec, { executable, cwd: h.cwd, args: ['--resume'] },
      { nativeLaunch: context.executionRun.services.nativeLaunch });
    try { expect(launch).toMatchObject({ command: '/installed/agent', args: ['installed-agent', '--resume'], cwd: h.cwd,
      env: { PATH: '/native/bin', NATIVE: 'active' } }); }
    finally { await launch.release(); }
    return { async send() { return { status: 'admitted' as const }; }, async stop() { return { status: 'notRunning' as const }; },
      watch() { return { dispose() {} }; }, async dispose() {} };
  } } };
  const host = createNativeAgentExecutionRunHostRuntime({ runtime,
    lease: { pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'acme.agent/agent', localAgentId: 'agent', occurrenceId: 'run-occurrence', isCurrent: () => true },
    options: { cwd: h.cwd, runId: 'detached-run', scope: 'detached', backendId: 'acme.agent/agent', permissionMode: 'default', start: { intent: 'delegate' } },
    supportsResume: true, services: Promise.resolve(services) });
  try { await host.provisionRuntime({ initialPrompt: 'Start' }); expect(h.nativeEffects()).toBe(1); }
  finally { await host.dispose(); }
});

it.each(['continue', 'cancel'] as const)('serializes concurrent qualified native setup within the original startup operation: %s', async decision => {
  const h = await harness({ setup: true, trusted: false });
  const launching = h.launchWithOperation(true);
  let settled = false;
  void launching.then(() => { settled = true; }, () => undefined);
  onTestFinished(() => { h.cancel(); });
  await expect.poll(() => h.operation()?.setupReview?.reviewedEffectDigest).toEqual(expect.any(String));
  if (decision === 'cancel') {
    h.cancel();
    await expect(launching).rejects.toBeDefined();
    expect(h.spawned).toHaveLength(0);
    expect(h.admission.dependencies()).toHaveLength(0);
    return;
  }
  await h.decide(h.operation()!.setupReview!.reviewedEffectDigest);
  await expect.poll(() => h.spawned.length).toBe(1);
  h.spawned[0]!.exit(0);
  await expect.poll(() => settled).toBe(true);
  const launch = await launching;
  try { expect(h.spawned).toHaveLength(1); expect(h.operations()).toHaveLength(1); }
  finally { await launch.release(); }
});

it('diagnoses the pending preparation phase and cancellation source without exception contents', async () => {
  const h = await harness({ setup: true, trusted: false });
  const log = vi.spyOn(logger, 'debug');
  const launching = h.launchWithOperation();
  void launching.catch(() => {});
  onTestFinished(() => { h.cancel(); });
  await expect.poll(() => h.operation()?.setupReview?.reviewedEffectDigest).toEqual(expect.any(String));
  h.cancel();
  await expect(launching).rejects.toBeDefined();
  const diagnostic = log.mock.calls.find(([message, fields]) => message === '[PluginExec] Native launch preparation phase'
    && fields && typeof fields === 'object' && 'phase' in fields && fields.phase === 'project_preparation'
    && 'status' in fields && fields.status === 'failed');
  expect(diagnostic?.[1]).toMatchObject({ pendingPhase: 'setup_review', abortSources: expect.arrayContaining(['operation']),
    abortReason: 'abort' });
  expect(diagnostic?.[1]).not.toHaveProperty('error');
});

it('executes trusted cold setup inside the original startup reservation before authorizing the Agent', async () => {
  const h = await harness({ setup: true });
  const launching = h.launchWithOperation();
  void launching.catch(() => {});
  await expect.poll(() => h.spawned.length).toBe(1);
  expect(h.operation()).toMatchObject({ actionId: 'session.spawn_new', state: 'running' });
  expect(h.spawned[0]!.launch.options.cwd).toBe(h.cwd);
  h.spawned[0]!.exit(0);
  const launch = await launching;
  try { expect(launch.env.NATIVE).toBe('active'); expect(h.spawned).toHaveLength(1); }
  finally { await launch.release(); }
});

it.each(['thisTime', 'untilChanged', 'skip', 'changed', 'reassigned', 'cancel'] as const)('retains original cold setup for %s without a replacement preparation Action', async decision => {
  const h = await harness({ setup: true, trusted: false });
  const launching = h.launchWithOperation();
  void launching.catch(() => {});
  await expect.poll(() => h.operation()?.setupReview?.reviewedEffectDigest).toEqual(expect.any(String));
  const original = h.operation()!;
  const digest = original.setupReview!.reviewedEffectDigest;
  expect(h.spawned).toHaveLength(0);
  expect(h.admission.dependencies()).toMatchObject([{ operationId: original.operationId, state: 'setup' }]);
  expect(h.operations()).toHaveLength(1);
  if (decision === 'reassigned') {
    h.reassignProject();
    await h.decide(digest);
    await expect.poll(() => h.admission.dependencies()).toHaveLength(0);
    await expect(launching).rejects.toMatchObject({ code: 'project_workspace_changed' });
    expect(h.spawned).toHaveLength(0);
    return;
  }
  if (decision === 'cancel') {
    h.cancel();
    await expect(launching).rejects.toBeDefined();
    expect(await h.decide(digest)).toBeNull();
    expect(h.spawned).toHaveLength(0);
    return;
  }
  if (decision === 'changed') {
    await h.changeSetup();
    expect(await h.decide(digest)).toMatchObject({ operationId: original.operationId,
      setupReview: { code: 'project_setup_effect_changed' } });
    expect(h.spawned).toHaveLength(0);
    h.cancel();
    await expect(launching).rejects.toBeDefined();
    return;
  }
  if (decision === 'untilChanged') await h.remember(digest);
  else await h.decide(digest, decision === 'skip');
  if (decision !== 'skip') {
    await expect.poll(() => h.spawned.length).toBe(1);
    expect(h.operation()?.operationId).toBe(original.operationId);
    h.spawned[0]!.exit(0);
  }
  const launch = await launching;
  try {
    expect(launch.env.NATIVE).toBe('active');
    expect(h.spawned).toHaveLength(decision === 'skip' ? 0 : 1);
    expect(h.trustWrites()).toBe(decision === 'untilChanged' ? 1 : 0);
    expect(h.operations()).toHaveLength(1);
    if (decision === 'skip') expect(await h.completion()).toBeNull();
    expect(h.operation()?.operationId).toBe(original.operationId);
  } finally { await launch.release(); }
});

it('retains exact completed setup while producing the native launch environment once', async () => {
  const h = await harness({ setup: true });
  await h.markCompleted();
  const launch = await h.launch();
  try { expect(launch.env.NATIVE).toBe('active'); expect(h.nativeEffects()).toBe(1); }
  finally { await launch.release(); }
});

it('refuses trusted unfinished setup when the original Session operation is unavailable', async () => {
  const h = await harness({ setup: true });
  await expect(h.launch()).rejects.toMatchObject({ code: 'project_setup_operation_unavailable' });
  expect(h.nativeEffects()).toBe(0);
});

it.each(['missing', 'child'] as const)('refuses %s native preparation without returning an Agent launch', async state => {
  const h = await harness();
  if (state === 'missing') h.unavailable(); else await h.selectChild();
  await expect(h.launch()).rejects.toMatchObject({ code: state === 'missing' ? 'native_tool_unavailable' : 'child_required' });
  expect(h.nativeEffects()).toBe(0);
});

it('rechecks the actual accepted Project after native IO and refuses a reassigned root before Agent launch', async () => {
  const h = await harness();
  h.changeProjectDuringNative();
  await expect(h.launch()).rejects.toMatchObject({ code: 'project_workspace_changed' });
  expect(h.nativeEffects()).toBe(1);
});

it('refuses missing private Session custody before resolving a custodian Project runtime', async () => {
  const h = await harness();
  let refusal: unknown;
  try { await h.launchWithoutRequester(); } catch (error) { refusal = error; }
  expect(h.accountReadTokens()).not.toContain('Bearer custodian-token');
  expect(refusal).toMatchObject({ code: 'project_requester_credentials_unavailable' });
  expect(h.nativeEffects()).toBe(0);
});

it.each(['ensure', 'send'] as const)('uses fresh captured Project custody when %s recreates a retained native Run', async method => {
  let phase = 'initial native launch';
  onTestFailed(() => { console.error(`Retained native Run failed during: ${phase}`); });
  const [{ createAuthoredAdmittedPluginRuntimeFixture }, { resolveCliEngineRegistry }, { ExecutionRunHostBridge }] = await Promise.all([
    import('@/plugins/testkit/admittedRuntime'), import('@/agent/runtime/registry/engineRegistry'),
    import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge'),
  ]);
  const h = await harness();
  const requests: AgentExecutionRunOpenRequest[] = [];
  const nativeEnvironments: Readonly<Record<string, string>>[] = [];
  const open: NonNullable<AgentRuntime['executionRuns']>['open'] = async (request, context: AgentExecutionRunRuntimeContextV1) => {
    requests.push(request);
    if (request.kind === 'fork') throw new Error('Fixture supports create and resume only');
    const launch = await authorizePluginExecLaunchForHost(context.services.exec, {
      executable: { kind: 'systemTool', id: 'runner' }, cwd: { root: 'workspace', relativePath: '' },
    }, { nativeLaunch: context.executionRun.services.nativeLaunch });
    try { nativeEnvironments.push(launch.env); } finally { await launch.release(); }
    return await createExecutionRunHostBackendFromConversationRuntime({ request,
      readCheckpointId: event => event.kind === 'provider-session-id' ? event.providerSessionId : null,
      openConversation() {
        let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
        return {
          watch(next) { listener = next; next({ kind: 'provider-session-id', providerSessionId: 'original-provider-thread' });
            return { dispose() { listener = undefined; } }; },
          async send(input) {
            listener?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
            listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Native Run completed.' });
            listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
            return { status: 'admitted' as const };
          },
          async cancel() { return { status: 'notRunning' as const }; },
          async dispose() {},
        };
      },
    });
  };
  const plugin = definePlugin({ id: 'acme.project-resume', version: '1.0.0', displayName: 'Project resume Agent',
    entrypoints: { daemon: './daemon.mjs' },
    hostAccess: { required: [
      { id: 'native-process', capability: 'process', reason: 'Open the native Agent', scope: { executables: [{ kind: 'systemTool', id: 'runner' }] } },
      { id: 'native-cwd', capability: 'filesystem', reason: 'Open the admitted workspace', scope: { locations: [{ root: 'workspace' }], access: ['read'] } },
    ], optional: [] },
    systemTools: { runner: { title: 'Native Agent process boundary', executableNames: ['sh'] } },
    agents: { agent: { declaration: { title: 'Project Agent', runtime: { kind: 'custom' }, primary: 'executionRuns',
      capabilities: { executionRuns: { open: ['create', 'resume'], checkpoint: true, stop: true } } },
      factory: () => ({ executionRuns: { open } }),
    } },
  });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: plugin.manifest, files: {
    'agent-runtime.mjs': `let open; export function configure(callback) { open = callback; }
      export function createRuntime() { return { executionRuns: { open: (request, context) => open(request, context) } }; }`,
    'daemon.mjs': `import * as leaf from './agent-runtime.mjs'; export function activate(api) {
      api.agents.register('agent', leaf.createRuntime); }
      export function configureUnitLeaf(open) { leaf.configure(open); return { activate }; }`,
  }, instantiateCommittedModule(module) {
    const configure = module.configureUnitLeaf;
    if (typeof configure !== 'function') throw new Error('Provider boundary fixture unavailable');
    return configure(open) as PluginDaemonModuleNamespace;
  } }] });
  onTestFinished(() => fixture.dispose());
  const identity = { pluginId: plugin.manifest.id, localId: 'agent' };
  const agentId = `${identity.pluginId}/${identity.localId}`;
  const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
  const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => identity });
  const bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: h.cwd,
    happyHomeDir: fixture.happyHomeDir, sendAcp: async () => {},
    resolveExecutionRunProfileCatalog: () => ({ engineRegistry, profileCatalog }) });
  onTestFinished(() => bridge.dispose());
  let initialCurrent = true;
  const started = await bridge.start({ sessionId: null, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId },
    instructions: 'Open the native Project Agent.', modelSelection: null, connectedServices: null, permissionMode: 'read_only',
    retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
    projectLaunchContext: { ...h.projectLaunchContext, isCurrent: () => initialCurrent } });
  await vi.waitFor(() => expect(bridge.get(started.runId), JSON.stringify(bridge.get(started.runId)))
    .toMatchObject({ resumeHandle: { kind: 'provider_session.v1' } }), { timeout: 30_000 });
  expect(nativeEnvironments).toMatchObject([{ NATIVE: 'active' }]);
  phase = 'settle initial input';
  await vi.waitFor(() => expect(bridge.getPublic(started.runId)).toMatchObject({ turnInFlight: false }), { timeout: 30_000 });
  // This SDK conversation adapter is finite: its completed native instance
  // cannot accept another warm turn. Recovery opens a new native instance.
  phase = 'stop original Run';
  await bridge.stop(started.runId);
  phase = 'wait for original Run stop';
  await bridge.waitForTerminal(started.runId);
  initialCurrent = false;
  const beforeResume = h.nativeEffects();
  const fresh = { ...h.projectLaunchContext, isCurrent: () => true };
  phase = `cold ${method}`;
  const resumed = method === 'ensure'
    ? await bridge.ensure(started.runId, { resume: true, projectLaunchContext: fresh })
    : await bridge.send(started.runId, { resume: true, message: 'Cold input', projectLaunchContext: fresh });
  expect(resumed).toMatchObject({ ok: true });
  expect(requests.map(request => request.kind)).toEqual(['create', 'resume']);
  expect(nativeEnvironments).toMatchObject([{ NATIVE: 'active' }, { NATIVE: 'active' }]);
  expect(h.nativeEffects()).toBe(beforeResume + 1);
  expect(bridge.get(started.runId)?.runId).toBe(started.runId);
});
