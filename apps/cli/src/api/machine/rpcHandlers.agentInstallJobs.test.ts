import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fastify from 'fastify';
import type { Socket } from 'socket.io-client';
import { callSocketRpc, type SocketRpcContent } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS, SocketRpcContinuationFrameV1Schema, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import type { RpcHandler, RpcHandlerContext } from '../rpc/types';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from './machineRpcAuthorization';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { registerMachineAgentInstallJobRpcHandlers } from './rpcHandlers.agentInstallJobs';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { getResolvedContributionRegistry, readCurrentBundledPluginEnablement } from '@/plugins/projection/registry/builtIn/snapshot';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { readRequestedIntentPluginIds } from '@/testkit/http/accountPluginAvailability';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['plain', 'e2ee'] as const)('follows one admitted member install and pushes only changed facts over %s RPC', async mode => {
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'fixture', runtimeSpec: { id: 'fixture', title: 'Fixture', binaryName: 'fixture',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'none',
      manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false } }] }) });
  const progress = { t: 'progress', stepId: 'cli', bytesDone: 1, bytesTotal: 10 } as const;
  const controller = new AbortController();
  const frames: unknown[] = [];
  let establish!: () => void;
  const established = new Promise<void>(resolve => { establish = resolve; });
  const key = new Uint8Array(32).fill(21);
  const content: SocketRpcContent = mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
    encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
    decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
  } };
  const installation = { machineId: 'machine', resolveCustodianAccountId: vi.fn(async () => 'custodian'),
    resolveInstallationId: () => 'installation',
    verifyMachineAdmission: vi.fn(async () => { throw new Error('Authenticated Home already admitted the call'); }) };
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', logger: () => {},
    ...(mode === 'plain' ? { encryptionMode: 'plain' as const } : { encryptionMode: 'e2ee' as const, encryptionKey: key, encryptionVariant: 'dataKey' as const }),
    authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, installation, source) });
  registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: rpc });

  // Substitute only the Home/socket boundary. Both continuation endpoints, codecs,
  // request admission, the daemon RPC dispatcher and the install journal run normally.
  const clientEvents = new EventEmitter();
  const daemonEvents = new EventEmitter();
  const relay = (senderSocketId: string, targetEvents: EventEmitter, requestId: string, raw: unknown) => {
    const { returnTo, ...frame } = SocketRpcContinuationFrameV1Schema.parse(raw);
    targetEvents.emit(SOCKET_RPC_EVENTS.CONTINUATION, { ...frame, senderSocketId, requestId: returnTo?.requestId ?? requestId });
  };
  rpc.onSocketConnect({
    on: daemonEvents.on.bind(daemonEvents), off: daemonEvents.off.bind(daemonEvents),
    emit(event: string, raw: unknown) {
      if (event === SOCKET_RPC_EVENTS.CONTINUATION) relay('daemon-socket', clientEvents, '', raw);
    },
  } as unknown as Socket);
  const read = (actorAccountId: string, jobId: string) => {
    const requestId = `read-${actorAccountId}`;
    const targetRequestId = `target-${requestId}`;
    return callSocketRpc({
      socket: { connected: true, on: clientEvents.on.bind(clientEvents), off: clientEvents.off.bind(clientEvents),
        emit(event: string, raw: unknown, callback?: (ack: unknown) => void) {
          if (event === SOCKET_RPC_EVENTS.CONTINUATION) relay('client-socket', daemonEvents, targetRequestId, raw);
          if (event !== SOCKET_RPC_EVENTS.CALL) return;
          const request = raw as SocketRpcRequestPayload;
          clientEvents.emit(SOCKET_RPC_EVENTS.CONTINUATION, { requestId, selectedSocketId: 'daemon-socket' });
          void rpc.handleRequest({ ...request, requestId: targetRequestId, continuationReturn: { socketId: 'client-socket', requestId },
            machineAdmission: { actorAccountId, custodianAccountId: 'custodian', machineId: 'machine', installationId: 'installation',
              role: actorAccountId === 'member' ? 'use' : 'manage', encryptionMode: mode },
          }, undefined, 'authenticated_home_socket').then(result => callback?.({ ok: true, result }));
        },
      },
      randomBytes, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, target: { kind: 'machine', id: 'machine' },
      requestId, content, params: { jobId, cursor: 0 }, timeoutMs: null, signal: controller.signal,
      async onContinuation(value) { frames.push(value); establish(); return null; },
    });
  };
  try {
    const started = owner.start({ agentId: 'fixture', intent: 'install', consent: { vendorRecipe: true } }, {
      accountId: 'member', async executeMember(_operation, signal, emit) {
        // The member process is the system boundary. Job admission, history and settlement are real.
        await Promise.race([established, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
        emit(progress);
        emit(progress);
        emit({ ...progress, bytesDone: 2 });
        return { kind: 'succeeded', version: '1.0' };
      },
    });
    if (!started.ok) throw new Error(started.errorCode);
    await expect(read('custodian', started.jobId)).resolves.toMatchObject({ ok: false, errorCode: 'job_not_found' });
    expect(frames).toEqual([]);
    installation.resolveCustodianAccountId.mockClear();
    const terminal = await read('member', started.jobId);
    expect(frames).toEqual([
      { events: [], nextCursor: 0 },
      { events: [progress], nextCursor: 1 },
      { events: [{ ...progress, bytesDone: 2 }], nextCursor: 2 },
    ]);
    expect(terminal).toMatchObject({ ok: true, done: true, events: [], nextCursor: 2, outcome: { kind: 'succeeded' } });
    expect(installation.resolveCustodianAccountId).toHaveBeenCalledTimes(1);
    expect(installation.verifyMachineAdmission).not.toHaveBeenCalled();
    expect(owner.read({ jobId: started.jobId, cursor: 1 }, 'member')).toMatchObject({
      ok: true, events: [{ ...progress, bytesDone: 2 }], nextCursor: 2, done: true,
    });
  } finally { controller.abort(); rpc.onSocketDisconnect(); await owner.shutdown(); }
});

it('carries a closed member isolation cause through the install RPC and Action failure', async () => {
  const handlers = new Map<string, RpcHandler>();
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [] });
  const context: RpcHandlerContext = { signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId: 'machine',
      installationId: 'installation', role: 'manage', encryptionMode: 'plain' } };
  registerMachineAgentInstallJobRpcHandlers({ owner, deps: { platform: 'linux', resolveHostHomeServerIdentityId: async () => 'home',
    nativeOperationRuntime: { async prepareNativeOperation() { throw new Error('Unavailable members cannot start an install'); } },
    agentIsolation: {
      read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'unavailable', code: 'payload_not_accessible' }, workspaceRoots: [] }),
      async readMember() {
        throw new PluginError({ code: 'agent_isolation_unavailable', message: 'Private setup detail', retryable: false,
          details: { reason: 'member_setup_required', phase: 'native_execution_preparation', readinessCode: 'payload_not_accessible',
            remedy: { kind: 'ask_machine_manager' }, privateValue: 'PRIVATE_MARKER' } });
      },
    } }, rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
  try {
    const reply = DaemonAgentInstallStartResponseSchema.parse(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({
      agentId: 'fixture', intent: 'install', consent: { vendorRecipe: true },
    }, context));
    expect(readActionFailureEnvelope(reply)).toMatchObject({ ok: false, errorCode: 'member_install_unavailable',
      details: { agentIsolationRefusal: { reason: 'member_setup_required', phase: 'native_execution_preparation',
        readinessCode: 'payload_not_accessible', remedy: { kind: 'ask_machine_manager' } } } });
    expect(JSON.stringify(reply)).not.toMatch(/Private setup detail|PRIVATE_MARKER/u);
    expect(owner.list('custodian')).toMatchObject({ ok: true, jobs: [] });
  } finally { await owner.shutdown(); }
});

it('returns the catalog terminal failure when a finite caller waits for installation', async () => {
  const handlers = new Map<string, RpcHandler>();
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'fixture', runtimeSpec: { id: 'fixture', title: 'Fixture', binaryName: 'fixture',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'none',
      manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false } }] }) });
  registerMachineAgentInstallJobRpcHandlers({ owner,
    rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
  try {
    const result = DaemonAgentInstallStartResponseSchema.parse(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({
      agentId: 'fixture', intent: 'install', consent: { vendorRecipe: true }, waitForTerminal: true,
    }));
    expect(result).toMatchObject({ ok: false, errorCode: 'native_effect_failed',
      details: { outcome: { kind: 'failed', code: 'install_not_available' } } });
    expect(owner.list('custodian')).toMatchObject({ ok: true, jobs: [{ done: true,
      outcome: { kind: 'failed', code: 'install_not_available' } }] });
  } finally { await owner.shutdown(); }
});

it('retains the closed member isolation cause after an admitted install starts', async () => {
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'fixture', runtimeSpec: { id: 'fixture', title: 'Fixture', binaryName: 'fixture',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'none',
      manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false } }] }) });
  try {
    const started = owner.start({ agentId: 'fixture', intent: 'install', consent: { vendorRecipe: true } },
      { accountId: 'custodian', async executeMember() {
        throw new PluginError({ code: 'agent_isolation_unavailable', message: 'PRIVATE_MARKER', retryable: false,
          details: { reason: 'payload_not_accessible', phase: 'native_execution_preparation',
            readinessCode: 'payload_not_accessible', privateValue: 'PRIVATE_MARKER' } });
      } });
    if (!started.ok) throw new Error(`Fixture failed to admit job: ${started.errorCode}`);
    const result = await owner.read({ jobId: started.jobId, cursor: 0, waitForTerminal: true }, 'custodian');
    expect(result).toMatchObject({ ok: true, done: true, outcome: { kind: 'failed', code: 'install_failed',
      agentIsolationRefusal: { reason: 'payload_not_accessible', phase: 'native_execution_preparation', readinessCode: 'payload_not_accessible' } } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MARKER');
  } finally { await owner.shutdown(); }
});

it.skipIf(process.platform === 'win32')('cancels a waiting finite install through the existing catalog job signal', async () => {
  const home = await createTempDir('happier-finite-agent-cancel-');
  const handlers = new Map<string, RpcHandler>();
  let downloading!: () => void;
  const download = new Promise<void>(resolve => { downloading = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200); response.write('partial'); downloading();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing catalog download fixture address');
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [],
    env: { HOME: home, HAPPIER_HOME_DIR: home, PATH: '' },
    readRegistry: () => ({ agents: [{ id: 'fixture-cancel', runtimeSpec: {
      id: 'fixture-cancel', title: 'Fixture cancel', binaryName: 'fixture-cancel', sourcePreferenceDefault: 'managed-first',
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/cancel', binaryName: 'fixture-cancel' },
      manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
    } }] }),
    // Only external release metadata is substituted; download, cancellation and cleanup stay real.
    installerDeps: { fetchGitHubLatestRelease: async () => ({ assets: [{
      name: `fixture-cancel-${process.platform}-${process.arch}`, browser_download_url: `http://127.0.0.1:${address.port}/binary`,
      digest: `sha256:${'0'.repeat(64)}`,
    }] }) },
  });
  const controller = new AbortController();
  const context: RpcHandlerContext = { signal: controller.signal, verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId: 'machine',
      installationId: 'installation', role: 'manage', encryptionMode: 'plain' } };
  registerMachineAgentInstallJobRpcHandlers({ owner,
    rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
  try {
    const waiting = handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({ agentId: 'fixture-cancel', intent: 'install',
      consent: { vendorRecipe: true }, waitForTerminal: true }, context);
    await Promise.race([download, Promise.resolve(waiting).then(result => {
      throw new Error(`Finite install settled before its download: ${JSON.stringify(result)}`);
    })]);
    expect(owner.list('custodian')).toMatchObject({ ok: true, jobs: [{ done: false }] });
    controller.abort();
    expect(DaemonAgentInstallStartResponseSchema.parse(await waiting)).toMatchObject({ ok: false, errorCode: 'cancelled',
      details: { outcome: { kind: 'failed', code: 'cancelled' } } });
    expect(owner.list('custodian')).toMatchObject({ ok: true, jobs: [{ done: true, outcome: { code: 'cancelled' } }] });
  } finally {
    await owner.shutdown(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await removeTempDir(home);
  }
});

it.each(['linux', 'darwin', 'win32'] as const)('admits member install with machine execution when separate users are off on %s', async platform => {
  const handlers = new Map<string, RpcHandler>();
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'fixture', runtimeSpec: { id: 'fixture', title: 'Fixture', binaryName: 'fixture',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'none',
      manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false } }] }) });
  const member: RpcHandlerContext = { signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: { actorAccountId: 'member', custodianAccountId: 'custodian', machineId: 'machine',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' } };
  try {
    for (const enabled of [false, true]) {
      registerMachineAgentInstallJobRpcHandlers({ owner, deps: { platform, agentIsolation: {
        read: () => ({ enabled, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }),
      } }, rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
      const result = await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({ agentId: 'fixture', intent: 'install',
        consent: { vendorRecipe: true } }, member);
      expect(DaemonAgentInstallStartResponseSchema.parse(result)).toMatchObject({ ok: true });
      expect(owner.list('member')).toMatchObject({ ok: true, jobs: expect.arrayContaining([expect.objectContaining({ executionScope: 'machine' })]) });
    }
  } finally { await owner.shutdown(); }
});

it('admits qualified bundled Codex installs through the published Home carrier and machine RPC, sharing the routing-id job', async () => {
  const home = await createTempDir('happier-codex-install-identity-');
  const handlers = new Map<string, RpcHandler>();
  let finishFetch!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { finishFetch = resolve; });
  const app = fastify();
  app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async request => {
    const ids = readRequestedIntentPluginIds(request.body);
    return { availabilityCursor: 1, pluginIds: ids, failedPluginIds: [], intentReads: ids.map(pluginId => ({ pluginId,
      response: { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null,
        release: null, uiArtifacts: [], packageAssets: [] },
    })) };
  });
  await app.ready();
  const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'http://codex-install-carrier.test' });
  const unpublish = publishServerHttpRuntimeOrigin('http://codex-install-carrier.test', 'iroh');
  const registry = getResolvedContributionRegistry({ pluginEnablementById: await readCurrentBundledPluginEnablement({
    machineEnabledById: {}, accountStorageDependencies: { readCredentials: async () => ({ token: 'fixture', encryption: null }) },
  }) });
  const owner = createAgentInstallJobOwner({ readRegistry: () => registry,
    readTrackedSessions: () => [], env: { HOME: home, HAPPIER_HOME_DIR: home, PATH: '' },
    // Account/GitHub HTTP and stored credentials are boundary fixtures; bundled
    // admission, identity projection, installer, settlement and RPC stay real.
    installerDeps: { fetchGitHubReleaseByTag: params => fetchGitHubReleaseByTag({ ...params,
      fetchImpl: async () => response,
    }) },
  });
  registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
  try {
    const start = handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!;
    const request = { agentId: 'happier.agent.codex/codex', intent: 'install', consent: { vendorRecipe: false } };
    const started = DaemonAgentInstallStartResponseSchema.parse(await start(request));
    expect(started).toMatchObject({ ok: true, jobId: expect.any(String) });
    if (!started.ok) return;
    expect(await start({ ...request, agentId: 'codex' })).toEqual(started);
    expect(await start({ ...request, agentId: 'other.plugin/codex' })).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST)!({})).toMatchObject({ ok: true,
      jobs: [{ jobId: started.jobId, agentId: 'codex', done: false }],
    });
    finishFetch(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    await vi.waitFor(async () => expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_READ)!({ jobId: started.jobId, cursor: 0 }))
      .toMatchObject({ ok: true, done: true, outcome: { kind: 'failed', code: 'rate_limited' } }));
  } finally {
    finishFetch(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    await owner.shutdown();
    unpublish();
    restoreHttp();
    await app.close();
    await removeTempDir(home);
  }
});

it('refuses unverified requester jobs before resolving the custodian catalog or built-in target', async () => {
  const handlers = new Map<string, RpcHandler>();
  const definition = AcpBackendDefinitionV1Schema.parse({ id: 'private-agent', name: 'private-agent', title: 'Private Agent',
    launch: { kind: 'command', command: 'private-command' }, createdAt: 1, updatedAt: 1 });
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId }, { id: 'fixture', runtimeSpec: {
        id: 'fixture', title: 'Fixture', binaryName: 'fixture', sourcePreferenceDefault: 'system-first',
        managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
      } }] }),
    readAcpCatalog: () => ({ status: 'ready', record: { v: 1, definitions: [definition] }, revision: 1 }) });
  registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
  const requester: RpcHandlerContext = { signal: new AbortController().signal, machineAdmission: {
    actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'machine', installationId: 'installation',
    role: 'manage', encryptionMode: 'plain',
  } };
  try {
    const handler = handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!;
    for (const intent of ['install', 'update', 'uninstall'] as const) {
      expect(await handler({ agentId: 'custom-acp', definitionId: definition.id, intent, consent: { vendorRecipe: false } }, requester))
        .toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    }
    expect(owner.list()).toEqual({ ok: true, jobs: [] });
    const builtin = DaemonAgentInstallStartResponseSchema.parse(await handler({ agentId: 'fixture', intent: 'install', consent: { vendorRecipe: false } }, requester));
    expect(builtin).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    const privateJob = owner.start({ agentId: 'custom-acp', definitionId: definition.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(privateJob.ok).toBe(true); if (!privateJob.ok) return;
    await vi.waitFor(() => expect(owner.read({ jobId: privateJob.jobId, cursor: 0 })).toMatchObject({ done: true }));
    const before = owner.read({ jobId: privateJob.jobId, cursor: 0 });
    expect(before).toMatchObject({ steps: [expect.objectContaining({ label: definition.title })] });
    expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST)!({}, requester)).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    for (const method of [RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL]) {
      expect(await handlers.get(method)!({ jobId: privateJob.jobId, ...(method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ ? { cursor: 0 } : {}) }, requester))
        .toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    }
    expect(owner.read({ jobId: privateJob.jobId, cursor: 0 })).toEqual(before);
    const custodian: RpcHandlerContext = { ...requester, machineAdmission: { ...requester.machineAdmission!, actorAccountId: 'custodian' },
      verifyMachineAdmissionCurrent: async () => true };
    expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_READ)!({ jobId: privateJob.jobId, cursor: 0 }, custodian)).toEqual(before);
    expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL)!({ jobId: privateJob.jobId }, custodian)).toEqual({ ok: true });
  } finally { await owner.shutdown(); }
});
