import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { z } from 'zod/mini';
import { loadIrohNodeNative } from '@happier-dev/iroh-native/node';
import { sanitizeDaemonSpawnEnv } from '@happier-dev/cli-common/process';
import { HomeConnectionDescriptorV1Schema, SessionSpawnNewInputV2Schema, SessionSpawnNewActionResultV1Schema,
  projectSessionSpawnNewActionInputV2, type ActionExecutorContext } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { readDaemonState, updateSettings, writeCredentialsTokenOnly } from '@/persistence';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { daemonPost } from '@/daemon/controlHttp';
import { stopDaemonSession } from '@/daemon/controlClient';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { probeAlreadyRunningExistingSessionServiceability } from './pendingQueueNudge';
import { CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV } from '@/auth/cliApiToken';
import { PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES_V1 } from '@happier-dev/protocol/generated/agents/bundledAgentIdentitiesV1';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { appendBoundedStderrTail, sanitizeChildStderrTail } from '@/daemon/spawn/childStderrDiagnostic';
import { sanitizeConnectedServiceDiagnosticString } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { readSessionRunnerLockStatus } from '@/daemon/sessionRunnerLock';

const childrenSchema = z.object({ children: z.array(z.object({ happySessionId: z.string(), pid: z.number() })) });

it.skipIf(process.env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION !== '1')('retains a runner through a new daemon process, serves its capability RPC and resumes the same Session without another runner', async () => {
  let existingRuntimeEnvironment: NodeJS.ProcessEnv | undefined;
  const existingEntrypoint = process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT?.trim();
  if (existingEntrypoint) {
    // The Stack's JavaScript launch owners retain the already-managed development graph.
    const [launchOwner, recordOwner] = await Promise.all([
      import(new URL('../../../../stack/scripts/runtime/launch/resolveCliRuntimeLaunchSpec.mjs', import.meta.url).href),
      import(new URL('../../../../stack/scripts/runtime/shared/source_bundle_record.mjs', import.meta.url).href),
    ]);
    const record = await recordOwner.readSourceRuntimeBundleRecord(existingEntrypoint);
    const launch = await launchOwner.resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: record,
      env: sanitizeDaemonSpawnEnv(process.env) });
    existingRuntimeEnvironment = sanitizeDaemonSpawnEnv(launchOwner.applyCliRuntimeLaunchProvenanceEnv({ cliLaunchSpec: launch }));
    console.info('Iroh restart existing development runtime', { entrypoint: launch.entrypoint,
      sourceCapture: record.sourceCapture, dependencyStatus: launch.dependencyStatus ?? null });
  }
  const directory = await mkdtemp(join(tmpdir(), 'happier-iroh-runner-restart-'));
  const workspace = join(directory, 'workspace');
  const controllerDirectory = join(directory, 'controller');
  await mkdir(workspace);
  await mkdir(controllerDirectory);
  // Use the daemon owner's product isolation, retaining the executor's real
  // admission and worker context for source-child dependency preparation.
  const daemonEnvironment = sanitizeDaemonSpawnEnv(process.env);
  const daemonEnvironmentChanges = Object.fromEntries(
    [...new Set([...Object.keys(process.env), ...Object.keys(daemonEnvironment)])]
      .filter(key => process.env[key] !== daemonEnvironment[key])
      .map(key => [key, daemonEnvironment[key]]));
  const environment = createEnvKeyScope([...Object.keys(daemonEnvironmentChanges), ...Object.keys(existingRuntimeEnvironment ?? {}),
    'DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_HOME_CARRIER_POLICY', 'HAPPIER_IROH_RELAY_POLICY',
    'HAPPIER_VARIANT', 'HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', 'HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT',
    'HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH', 'HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED',
    'HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE',
    'HAPPIER_CLI_SUBPROCESS_PREFER_TSX', 'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK',
    'HAPPIER_DAEMON_WAIT_FOR_AUTH', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
    'HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED',
    'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK', CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV, PROCESS_OWNER_ENV_KEY]);
  const lifetime = new AbortController();
  const daemons: { child: ChildProcess; closed: Promise<unknown>; logPath: string }[] = [];
  let completed = false;
  let runnerPid: number | undefined;
  let plugin: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
  const serverPath = '../../../../server/sources/testkit/workflowApprovedOperationServer.testkit';
  const server: typeof import('../../../../server/sources/testkit/workflowApprovedOperationServer.testkit') = await import(serverPath);
  let home: Awaited<ReturnType<typeof server.startWorkflowApprovedOperationServer>> | undefined;
  const loaded = loadIrohNodeNative();
  if (!loaded.available) throw new Error(`Real Home native transport unavailable: ${loaded.message}`);
  const native = loaded.native;
  let endpoint: Awaited<ReturnType<typeof native.createEndpoint>> | undefined;
  const stageProjection = (value: string) => value.split('\n').filter(line =>
    /Spawn preparation phase|Spawn process phase|Spawned process|Spawn launch admission|Starting happy CLI|SPAWN HAPPIER CLI|Created session attach file|Child stdout:|Child stderr:/u.test(line)).join('\n');
  const sanitize = (value: string) => sanitizeChildStderrTail(appendBoundedStderrTail('', value), text =>
    sanitizeConnectedServiceDiagnosticString(text, { maxLength: text.length,
      redactedValues: [home?.token, home?.installedToken].filter((token): token is string => typeof token === 'string') }));
  onTestFinished(async () => {
    if (!completed) {
      const listed = z.object({ children: z.array(z.object({ pid: z.number() })) }).safeParse(
        await daemonPost('/list', {}).catch(() => null));
      console.info('Iroh restart startup custody', { daemonPid: (await readDaemonState())?.pid,
        childPids: listed.success ? listed.data.children.map(child => child.pid) : [] });
    }
    lifetime.abort();
    try {
      const state = await readDaemonState();
      if (state && daemons.some(({ child }) => child.pid === state.pid && child.exitCode === null)) {
        for (const session of (await home?.readWorkflowSessionEffects())?.sessions ?? []) {
          await stopDaemonSession(session.id, { target: state });
        }
      }
    } finally {
      // All PIDs below were created/observed by this isolated fixture only.
      if (runnerPid && !await waitForProcessExit(runnerPid, { timeoutMs: 0 })) {
        try { process.kill(runnerPid, 'SIGTERM'); } catch { /* already retired */ }
        expect(await waitForProcessExit(runnerPid)).toBe(true);
      }
      for (const daemon of daemons) {
        if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill('SIGTERM');
        await daemon.closed;
      }
      console.info('Iroh restart fixture retired its owned processes', { daemonPids: daemons.map(({ child }) => child.pid), runnerPid });
      if (!completed) {
        const retainedLogs = join(tmpdir(), `${basename(directory)}-logs`);
        await cp(configuration.logsDir, retainedLogs, { recursive: true }).catch(() => {});
        console.info('Iroh restart retained process logs', retainedLogs);
        for (const daemon of daemons) {
          console.info('Iroh restart daemon exit', { pid: daemon.child.pid,
            code: daemon.child.exitCode, signal: daemon.child.signalCode });
          const text = await readFile(daemon.logPath, 'utf8').catch(() => 'log unavailable');
          console.info('Iroh restart daemon stages', sanitize(stageProjection(text)));
          console.info('Iroh restart daemon diagnostic', sanitize(text));
        }
        for (const entry of await readdir(retainedLogs, { withFileTypes: true }).catch(() => [])) {
          if (entry.isFile() && entry.name.endsWith('.log')) {
            const text = await readFile(join(retainedLogs, entry.name), 'utf8').catch(() => 'log unavailable');
            console.info('Iroh restart process stages', entry.name, sanitize(stageProjection(text)));
            console.info('Iroh restart process diagnostic', entry.name, sanitize(text));
          }
        }
      }
      try { await plugin?.dispose(); }
      finally {
        try { if (endpoint) await native.shutdownEndpoint({ endpointHandle: endpoint.endpointHandle }); }
        finally { try { await home?.close(); }
          finally { environment.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true }); } }
      }
    }
  });
  environment.patch(daemonEnvironmentChanges);
  const serverId = 'iroh-runner-restart';
  environment.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: serverId,
    HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_VARIANT: 'dev',
    HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined, HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: undefined,
    HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: undefined, HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
    [CLI_API_TOKEN_ENV]: undefined, [CLI_API_TOKEN_HANDOFF_ENV]: undefined, [PROCESS_OWNER_ENV_KEY]: undefined });
  reloadConfiguration();
  const installation = await readOrCreateInstallationIdentity();
  const machineId = randomUUID();
  home = await server.startWorkflowApprovedOperationServer({ installedMachine: { machineId, installation, happyHomeDir: directory } });
  const boundHome = home;
  if (!home.installedToken) throw new Error('Installed terminal credential was not minted');
  endpoint = await native.createEndpoint({ relayPolicy: 'disabled', capProfile: 'homeInteractive' });
  await native.startHomeAcceptor({ endpointHandle: endpoint.endpointHandle, targetPort: Number(new URL(home.baseUrl).port) });
  const status = await native.getEndpointStatus(endpoint.endpointHandle);
  if (!status?.directAddresses.length) throw new Error('Home acceptor did not publish a direct address');
  // The configured HTTPS route deliberately has no server. All daemon/runner
  // requests must use their own native Home listener, including after restart.
  const canonicalServerUrl = 'https://iroh-runner-restart.invalid';
  const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: home.homeId,
    canonicalServerUrl, revision: 1, endpoints: [{ kind: 'iroh', endpointId: endpoint.endpointId,
      directAddresses: status.directAddresses }] });
  environment.patch({ DEBUG: '1', HAPPIER_SERVER_URL: canonicalServerUrl, HAPPIER_WEBAPP_URL: canonicalServerUrl,
    HAPPIER_HOME_CARRIER_POLICY: 'automatic', HAPPIER_IROH_RELAY_POLICY: 'disabled',
    HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1', HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
    HAPPIER_DAEMON_WAIT_FOR_AUTH: '1', HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: serverId,
    HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0',
    HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '0' });
  if (existingRuntimeEnvironment) environment.patch(existingRuntimeEnvironment);
  await writeDaemonSettingsFixture(directory, { activeServerId: serverId,
    servers: { [serverId]: { id: serverId, name: serverId, serverUrl: canonicalServerUrl, webappUrl: canonicalServerUrl,
      createdAt: 0, updatedAt: 0, lastUsedAt: 0 } },
    machineIdByServerIdByAccountId: { [serverId]: { [home.accountId]: machineId } },
    lastTokenSubByServerId: { [serverId]: home.accountId } });
  reloadConfiguration();
  await seedTestServerProfile({ id: serverId, homeId: home.homeId, serverUrl: canonicalServerUrl });
  await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
    [serverId]: { ...settings.servers![serverId], homeConnectionDescriptor: descriptor } } }));
  await writeCredentialsTokenOnly({ token: home.installedToken });
  reloadConfiguration();
  const agentIdentity = BUNDLED_AGENT_CONTRIBUTION_IDENTITIES_V1.codex!;
  const conversation = createFirstConversationAgentFixture('IROH_RESTART_FIRST', {
    nativeSession: { providerSessionId: 'iroh-retained-native' },
  });
  // Substitute the external Agent implementation under a real bundled target;
  // all host catalog, admission, Session and RPC owners remain source-real.
  plugin = await runWithServerHttpBaseUrl(boundHome.baseUrl, () => createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
    plugins: [{ ...conversation, manifest: { ...conversation.manifest, id: agentIdentity.pluginId,
      contributes: { ...conversation.manifest.contributes,
        agents: conversation.manifest.contributes.agents.map(agent => ({ ...agent, id: agentIdentity.localId })) } },
      files: { ...conversation.files, 'daemon.mjs': `import { factory } from './agent.mjs';
        export function activate(api) { api.agents.register(${JSON.stringify(agentIdentity.localId)}, factory, {
          sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }` },
      includeAvailability: true, replaceExisting: true }] }));
  const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
  const start = async () => {
    const output = createWriteStream(join(tmpdir(), `${basename(directory)}-daemon-${daemons.length}.log`));
    console.info('Iroh restart daemon log', String(output.path));
    const child = existingRuntimeEnvironment
      ? spawnHappyCLI(['daemon', 'start-sync'], { cwd: repository, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
        { environment: process.env })
      : spawn(process.execPath, ['--conditions=happier-source', '--import',
        join(repository, 'packages/cli-common/registerSourceRuntime.mjs'), join(repository, 'apps/cli/src/index.ts'), 'daemon', 'start-sync'],
      { cwd: repository, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.pipe(output); child.stderr!.pipe(output, { end: false });
    let diagnosticTail = '';
    child.stdout!.on('data', chunk => { diagnosticTail = appendBoundedStderrTail(diagnosticTail, chunk); });
    child.stderr!.on('data', chunk => { diagnosticTail = appendBoundedStderrTail(diagnosticTail, chunk); });
    const closed = once(child, 'exit');
    void closed.finally(() => output.end());
    daemons.push({ child, closed, logPath: String(output.path) });
    await Promise.race([Promise.all([
      boundHome.waitForMachineRpc(machineId, RPC_METHODS.CAPABILITIES_DESCRIBE, lifetime.signal),
      boundHome.waitForMachineRpc(machineId, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, lifetime.signal),
    ]), closed.then(([code, signal]) => { throw new Error(`Daemon ${child.pid} ended before registering its Machine RPC; code=${code} signal=${signal}; ${sanitize(diagnosticTail)}`); })]);
    expect((await readDaemonState())?.pid).toBe(child.pid);
    return { child, closed };
  };
  const context: ActionExecutorContext = { surface: 'ui', externalActionTarget: { kind: 'machine', machineId,
    project: { machineId, directory: workspace } } };
  const execute = async (actionId: string, input: unknown,
    caller = { token: boundHome.token, accountId: boundHome.accountId }) => {
    const requestId = randomUUID();
    const send = (actionInput: unknown, presentUserConfirmation?: ActionExecutorContext['presentUserConfirmation']) =>
      dispatchOriginalAccountAction({ actionId, input: actionInput, requestId, target: context.externalActionTarget!,
        credentials: { token: caller.token, encryption: null }, serverHttpBaseUrl: boundHome.baseUrl,
        serverIdentityId: boundHome.homeId, authority: 'present_user',
        invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user',
          ...(presentUserConfirmation ? { presentUserConfirmation } : {}) },
        onRequesterSessionCredentialDisclosure: () => true, signal: lifetime.signal });
    const reviewed = await send(input);
    if (reviewed?.ok !== false || reviewed.errorCode !== 'action_interactive_review_required') return reviewed;
    // The fixture is the present user's affirmative choice for this exact
    // public review. Retain the owner's normalized input and invocation binding.
    const details = z.object({ review: z.object({ actionArgs: z.unknown() }), reviewDigest: z.string() }).parse(reviewed.details);
    return await send(details.review.actionArgs, { actionId: ActionIdSchema.parse(actionId),
      inputDigest: computeActionInputApprovalDigestV1(ActionIdSchema.parse(actionId), details.review.actionArgs),
      reviewDigest: details.reviewDigest, requestId, accountId: caller.accountId,
      serverId: boundHome.homeId, target: context.externalActionTarget });
  };
  const first = await start();
  const birth = await execute('session.spawn_new', projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
    creationKey: randomUUID(), executionTarget: { serverId, machineId }, directory: { kind: 'path', path: workspace },
    organizationPlacement: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: agentIdentity },
    connectedServices: { v: 2, bindingsByServiceId: {} }, initialInput: { text: 'IROH_RESTART_FIRST' },
  })));
  expect(birth, JSON.stringify(birth)).toMatchObject({ ok: true });
  if (!birth?.ok) throw new Error('Session birth refused');
  const created = SessionSpawnNewActionResultV1Schema.parse(birth.result);
  if (created.type !== 'success') throw new Error(`Session did not start: ${sanitize(JSON.stringify(created))}`);
  const sessionId = created.sessionId;
  const originalChildren = childrenSchema.parse(await daemonPost('/list', {})).children;
  const launchPid = originalChildren.find(child => child.happySessionId === sessionId)?.pid;
  expect(launchPid).toBeTypeOf('number');
  expect(await execute('session.wait.idle', { sessionId })).toMatchObject({ ok: true, result: { idle: true } });
  // The launch process can be a custody wrapper. The canonical lock identifies
  // the actual Session runner recovered by the replacement daemon.
  const initialLock = await readSessionRunnerLockStatus({ sessionId, happyHomeDir: directory });
  expect(initialLock).toMatchObject({ ok: true });
  if (!initialLock.ok) throw new Error('Session runner lock unavailable after first turn');
  runnerPid = initialLock.lock.pid;
  const runnerStartTimeMs = initialLock.lock.processStartTimeMs;
  expect(runnerStartTimeMs).toBeTypeOf('number');
  console.info('Iroh restart Session born', { daemonPid: first.child.pid, launchPid, runnerPid, runnerStartTimeMs, sessionId });
  first.child.kill('SIGTERM');
  await first.closed;
  expect(() => process.kill(runnerPid!, 0)).not.toThrow();
  expect(await readSessionRunnerLockStatus({ sessionId, happyHomeDir: directory }))
    .toMatchObject({ ok: true, lock: { pid: runnerPid, processStartTimeMs: runnerStartTimeMs } });
  // Probe after the old process and its loopback listener are gone, before
  // the replacement can mask loss of the runner's own transport.
  const probe = async (token: string) => {
    // A remote controller has no same-OS Session descriptor. Keep the real RPC
    // owner on its Home socket path instead of the same-user local channel.
    const controller = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    controller.patch({ HAPPIER_HOME_DIR: controllerDirectory });
    reloadConfiguration();
    try {
      return await runWithServerHttpBaseUrl(boundHome.baseUrl, () =>
        probeAlreadyRunningExistingSessionServiceability({ sessionId, credentials: { token, encryption: null } }));
    } finally { controller.restore(); reloadConfiguration(); }
  };
  expect(await probe(home.token)).toEqual({ state: 'servable' });
  console.info('Iroh restart surviving Home capability', { runnerPid, sessionId, state: 'servable' });
  const second = await start();
  expect(second.child.pid).not.toBe(first.child.pid);
  expect(await probe(home.token)).toEqual({ state: 'servable' });
  expect(await execute('session.open', { sessionId, serverId, intent: 'resume' })).toMatchObject({ ok: true,
    result: { status: 'opened', sessionId } });
  expect(await readSessionRunnerLockStatus({ sessionId, happyHomeDir: directory }))
    .toMatchObject({ ok: true, lock: { pid: runnerPid, processStartTimeMs: runnerStartTimeMs } });
  const retainedChildren = childrenSchema.parse(await daemonPost('/list', {})).children;
  expect(retainedChildren.filter(child => child.happySessionId === sessionId)).toEqual([{ happySessionId: sessionId, pid: runnerPid }]);
  expect((await home.readWorkflowSessionEffects()).sessions).toHaveLength(1);
  const foreign = await home.createForeignAccount();
  expect(await probe(foreign.token)).toEqual({ state: 'unknown', reason: 'transport_unavailable' });
  home.setCostPhase('foreign-session-open');
  const foreignOpen = await execute('session.open', { sessionId, serverId, intent: 'resume' }, foreign);
  console.info('Iroh restart foreign admission HTTP', home.readRequestCosts()
    .filter(cost => cost.phase === 'foreign-session-open' && cost.method === 'GET' && cost.route.startsWith('/v1/machines/'))
    .map(({ method, route, status }) => ({ method, route, status })));
  // This Account has no Machine share; the requester inventory owner refuses
  // the absent target before any Session effect can be submitted.
  expect(foreignOpen, JSON.stringify(foreignOpen)).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
  expect(await readSessionRunnerLockStatus({ sessionId, happyHomeDir: directory }))
    .toMatchObject({ ok: true, lock: { pid: runnerPid, processStartTimeMs: runnerStartTimeMs } });
  expect(childrenSchema.parse(await daemonPost('/list', {})).children.filter(child => child.happySessionId === sessionId))
    .toEqual([{ happySessionId: sessionId, pid: runnerPid }]);
  expect((await home.readWorkflowSessionEffects()).sessions).toHaveLength(1);
  console.info('Iroh restart composed outcomes', { firstDaemonPid: first.child.pid, replacementDaemonPid: second.child.pid,
    runnerPid, runnerStartTimeMs, sessionId, homeCapability: 'servable', sessionOpen: 'opened', foreignOpen: 'admission_unavailable' });
  completed = true;
// This opt-in manual journey includes canonical runtime/dependency admission. Let
// that operation finish rather than cutting off its healthy queue/build work.
}, 0);
