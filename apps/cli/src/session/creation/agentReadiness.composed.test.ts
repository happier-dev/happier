import axios from 'axios';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema, SessionSpawnNewInputV2Schema, accountSettingsParse } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { io } from 'socket.io-client';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createApiSessionSocketStub, bindApiSessionSocketMock } from '@/testkit/backends/apiSessionSocketHarness';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import type { CapabilityDetectRequest } from '@/capabilities/types';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetServerFeaturesClientForTests(); });

it.each([
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null, remoteFiles: true },
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null, remoteFiles: true, deferredClone: true },
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null, hostPath: true },
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null, hostPath: true, metadataProbeForbidden: true },
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null, hostPath: true, capabilityUnknown: true },
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null },
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null, inventoryFailure: 'machine_target_not_current' },
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null, inventoryFailure: 'machine_agent_inventory_unavailable' },
  { role: 'use', installed: false, outdated: false, acquireAllowed: false, refusal: 'agent_cli_missing' },
  { role: 'manage', installed: false, outdated: false, acquireAllowed: true, refusal: null, actionFailure: 'acquire' },
  { role: 'manage', installed: false, outdated: false, acquireAllowed: true, refusal: null, actionFailure: 'status' },
  { role: 'use', installed: true, outdated: true, acquireAllowed: false, refusal: null },
  { role: 'manage', installed: false, outdated: false, acquireAllowed: true, refusal: null },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: null },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: null, terminalFailed: true },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: null, updateInUse: true },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: null, updatePending: true },
  { role: 'manage', installed: false, outdated: false, acquireAllowed: true, refusal: 'agent_cli_not_ready', terminalFailed: true },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: 'agent_cli_not_ready', terminalFailed: true, dependencyMissing: true },
  { role: 'manage', installed: true, outdated: false, acquireAllowed: true, refusal: 'agent_cli_not_ready', dependencyMissing: true },
] as const)('admits Agent readiness before Session birth ($role, installed=$installed, outdated=$outdated, hostPath=$hostPath, metadataProbeForbidden=$metadataProbeForbidden, capabilityUnknown=$capabilityUnknown, inventoryFailure=$inventoryFailure, remoteFiles=$remoteFiles, deferredClone=$deferredClone)', async testCase => {
  const { installed, outdated, acquireAllowed, refusal } = testCase;
  const remoteFiles = 'remoteFiles' in testCase && testCase.remoteFiles;
  const deferredClone = 'deferredClone' in testCase && testCase.deferredClone;
  const terminalFailed = 'terminalFailed' in testCase && testCase.terminalFailed;
  const updateInUse = 'updateInUse' in testCase && testCase.updateInUse;
  const updatePending = 'updatePending' in testCase && testCase.updatePending;
  const dependencyMissing = 'dependencyMissing' in testCase && testCase.dependencyMissing;
  const hostPath = 'hostPath' in testCase && testCase.hostPath;
  const metadataProbeForbidden = 'metadataProbeForbidden' in testCase && testCase.metadataProbeForbidden;
  const capabilityUnknown = 'capabilityUnknown' in testCase && testCase.capabilityUnknown;
  const inventoryFailure = 'inventoryFailure' in testCase ? testCase.inventoryFailure : null;
  const actionFailure = 'actionFailure' in testCase ? testCase.actionFailure : null;
  let hostExecutablePath: string | undefined;
  let metadataProbeLog: string | undefined;
  if (hostPath) {
    const fixture = await createProbeTempDir('happier-session-host-cli');
    onTestFinished(fixture.cleanup);
    vi.stubEnv('HAPPIER_HOME_DIR', fixture.dir);
    vi.stubEnv('HOME', fixture.dir);
    vi.stubEnv('USERPROFILE', fixture.dir);
    vi.stubEnv('CODEX_HOME', fixture.dir);
    vi.stubEnv('HAPPIER_CODEX_PATH', '');
    vi.stubEnv('HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON', '');
    vi.stubEnv('PATH', fixture.dir);
    hostExecutablePath = join(fixture.dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    metadataProbeLog = join(fixture.dir, 'metadata-probes.log');
    await writeExecutableScript(hostExecutablePath, process.platform === 'win32'
      ? metadataProbeForbidden
        ? `@echo off\r\necho probe>>"${metadataProbeLog}"\r\nexit /b 1\r\n`
        : '@echo off\r\necho codex 1.2.3\r\n'
      : metadataProbeForbidden
        ? `#!/bin/sh\nprintf 'probe\\n' >> '${metadataProbeLog.replaceAll("'", "'\\''")}'\nexit 1\n`
        : '#!/bin/sh\nprintf "codex 1.2.3\\n"\n');
    // The isolated Home has no managed installation; PATH is the only CLI source.
    expect(resolveAgentCliLaunchSpec('codex', { processEnv: { ...process.env, PATH: '' } })).toBeNull();
  }
  const accountId = 'requester';
  const machineId = 'machine-1';
  const sessionId = 'readiness-session';
  const requestId = 'readiness-start-request';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null };
  const events: string[] = [];
  const sourceWorkspace = { serverId: 'home-a', machineId: 'source-machine', workspaceId: 'source-project', rootPath: '/source/dirty-project' };
  const targetWorkspace = { serverId: 'home-a', machineId, workspaceId: 'target-project', rootPath: '/remote/managed-project' };
  const clonedDirectory = `${targetWorkspace.rootPath}/repository`;
  const cloneSource = { source: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'owner/original' }, protocol: 'https' }, branch: 'feature/original' };
  const acquisitionRequests: string[] = [];
  let bornSession: Record<string, unknown> | undefined;
  let machineBound = false;
  const facts = { installed, version: installed ? '1.2.3' : null, latestVersion: '1.2.4',
    update: { supported: outdated, command: null },
    signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
    install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null },
    dependencies: dependencyMissing ? [{ key: 'runtime', installed: false, version: null }] : [] };
  const content = { mode: 'plain' as const };
  bindApiSessionSocketMock(vi.mocked(io), createApiSessionSocketStub({ emitWithAck: async (event, raw) => {
    if (event !== SOCKET_RPC_EVENTS.CALL || !raw || typeof raw !== 'object'
      || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Unexpected RPC');
    const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
    const method = raw.method.slice(raw.method.indexOf(':') + 1);
    if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START || method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ) {
      acquisitionRequests.push(method);
    }
    if (actionFailure === 'acquire' && method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START
      || actionFailure === 'status' && method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ) {
      return { ok: false, errorCode: 'machine_target_not_current', error: 'child_not_derived' };
    }
    // Socket.IO is the genuine Home boundary. Real Home Use/Manage admission
    // is independently exercised in sessionAgentReadiness.sqlite.integration.spec.ts;
    // these granted/refused network outcomes exercise the Session owner response.
    if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START && !acquireAllowed) {
      return { ok: false, error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN };
    }
    let result: unknown;
    if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
      result = { ok: true, directory: '/remote/project', directoryKind: 'path', directoryCreationRequired: false, checkout: null };
    } else if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      events.push('inventory');
      if (inventoryFailure === 'machine_target_not_current') {
        return { ok: false, errorCode: inventoryFailure, error: 'child_not_derived' };
      }
      if (inventoryFailure === 'machine_agent_inventory_unavailable') {
        return { ok: true, result: await socketRpcCodec.encodeResponse(content, { protocolVersion: 1 }, decoded.callId) };
      }
      result = { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
        codex: { id: 'codex', title: 'Codex', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
      } } };
    } else if (method === RPC_METHODS.CAPABILITIES_DETECT) {
      if (capabilityUnknown) {
        // Observed live daemon response when this capability has no registration.
        result = { protocolVersion: 1, results: { 'cli.codex': { ok: false, checkedAt: 1,
          error: { code: 'unknown-capability', message: 'Capability is not registered' } } } };
      } else {
        // Keep physical detection/projection real behind the Machine network boundary.
        // Keep the real capability request/context path: readiness must not
        // spend optional metadata subprocesses before its native spawn.
        const request: CapabilityDetectRequest = { id: 'cli.codex', params: decoded.params && typeof decoded.params === 'object'
          && 'requests' in decoded.params && Array.isArray(decoded.params.requests)
          ? decoded.params.requests[0]?.params : undefined };
        const data = hostPath ? buildCliCapabilityData({ request,
          entry: (await buildDetectContext([request])).cliSnapshot?.clis.codex }) : facts;
        if (hostPath) expect(data).toMatchObject({ resolutionSource: 'system', resolvedPath: hostExecutablePath });
        result = { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data } } };
      }
    } else if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START) {
      events.push(outdated ? 'update' : 'install');
      result = updateInUse ? { ok: false, errorCode: 'in_use', error: 'The installed Agent is in use' } : { ok: true, jobId: 'acquisition-job' };
    } else if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ) {
      expect(decoded.params).toMatchObject({ jobId: 'acquisition-job', waitForTerminal: !(installed && !dependencyMissing) });
      expect(events).not.toContain('birth');
      events.push('terminal');
      result = { ok: true, steps: [], progress: [], events: [], nextCursor: 0, done: !updatePending,
        ...(updatePending ? {} : { outcome: terminalFailed ? { kind: 'failed', code: 'install_failed', stepId: 'install', message: 'Installer failed' }
          : { kind: 'succeeded', version: '1.2.4' } }) };
    } else throw new Error(`Unexpected RPC ${method}`);
    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
  } }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine: { id: machineId, active: true,
      installationId: 'installation-1', kind: 'persistent', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      revokedAt: null, replacedByMachineId: null } } };
    if (path === `/v1/access-keys/${sessionId}/${machineId}`) return { status: 200,
      data: { accessKey: machineBound ? { data: 'bound-key' } : null } };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: bornSession } };
    throw new Error(`Unexpected Home read ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: bornSession ? [bornSession] : [] } };
    if (path === '/v1/sessions') {
      events.push('birth');
      if (!raw || typeof raw !== 'object') throw new Error('Missing birth body');
      const ownerMetadata = SessionOwnerMetadataEnvelopeV1Schema.parse(Reflect.get(raw, 'ownerMetadata'));
      const shared = Reflect.get(raw, 'sharedMetadata');
      if (!shared || typeof shared !== 'object') throw new Error('Missing shared metadata');
      bornSession = { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        archivedAt: null, metadataVersion: 1, metadataLayoutVersion: 1,
        metadata: Reflect.get(shared, 'ciphertext'), ownerMetadata, encryptionMode: 'plain', agentState: null,
        agentStateVersion: 0, dataEncryptionKey: null, share: null };
      return { status: 200, data: { created: true, session: bornSession } };
    }
    if (path === `/v1/access-keys/${sessionId}/${machineId}`) {
      machineBound = true;
      return { status: 200, data: { success: true, accessKey: { data: Reflect.get(raw as object, 'data') } } };
    }
    throw new Error(`Unexpected Home write ${path}`);
  });
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url).endsWith('/v1/account/profile')) return Response.json({ id: accountId });
    if (String(url).endsWith('/v1/features')) return Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }));
    throw new Error(`Unexpected fetch ${url}`);
  }));
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    const path = new URL(String(config.url)).pathname;
    if (path === '/v1/home/governance/get') return { status: 200, data: { homeDefaults: null } };
    throw new Error(`Unexpected Home Action read: ${path}`);
  });
  const settings = accountSettingsParse({ memoryUpkeepInNewBots: false,
    actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.agents.install': ['cli'] } },
  });
  const executor = createCliActionExecutor({ credentials, token, sessionId: '', mode: 'plain', ctx: null,
    // This port is the host-to-Machine Action transport. Source declarations,
    // exact child admission and the native Session producer remain real.
    routeHostChildAction: async ({ actionId, input }) => {
      if (actionId !== 'projects.open') return null;
      const request = OpenProjectInputV1Schema.parse(input);
      const workspace = request.machineId === sourceWorkspace.machineId ? sourceWorkspace : targetWorkspace;
      events.push(request.machineId === sourceWorkspace.machineId ? 'source-open' : 'target-copy');
      return { ok: true, result: { kind: 'opened', workspace, directory: request.materialization.kind === 'clone' ? clonedDirectory : workspace.rootPath,
        setup: 'notRequired', ...(request.cloneSource ? { cloneSource } : {}) } };
    },
    serverId: 'home-a', serverIdentityId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }),
    savedSecretOperationContext: createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://home-a.example.test', isCurrent: async () => true,
      snapshot: { settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], source: 'network',
        scopeKey: resolveAccountSettingsScopeKeyForToken(token), whenRefreshed: null,
        connectedPurposeCatalog: { status: 'ready', revision: 1, record: { key: 'purposes',
          value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } } } }),
    sessionSpawnDirectTargetTransport: { machineId, readMachineMetadataSnapshot: () => ({ status: 'ready', metadata: {} }), prepare: async request => {
      if (remoteFiles) expect(request.directory).toEqual({ kind: 'managed' });
      return { ok: true, directory: remoteFiles ? targetWorkspace.rootPath : '/remote/project',
      directoryKind: remoteFiles ? 'managed' : 'path', directoryCreationRequired: false, checkout: null };
    }, spawnedSession: {
      // The native process boundary performs birth and launch together.
      spawn: async request => {
        if (remoteFiles) expect(request).toMatchObject({ directory: deferredClone ? clonedDirectory : targetWorkspace.rootPath,
          sessionCreationCorrespondence: { recipe: deferredClone ? { projectFiles: { kind: 'git_clone', ...cloneSource } }
            : { projectFilesOrigin: { sourceWorkspace, targetWorkspace } } } });
        const ownerView = createSessionOwnerMetadataV1({ metadata: {
          machineId, path: request.directory, hostPid: 1, sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence,
        } });
        if (!ownerView.ok) throw new Error(`invalid native birth fixture: ${ownerView.unsupportedFields.join(',')}`);
        if (remoteFiles) bornSession = { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          archivedAt: null, metadataVersion: 1, metadataLayoutVersion: 1,
          metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })),
          ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema.parse({ t: 'plain', v: ownerView.ownerMetadata }),
          encryptionMode: 'plain', agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null };
        if (hostPath) expect(resolveAgentCliLaunchSpec('codex')).toMatchObject({ source: 'system', resolvedPath: hostExecutablePath });
        if (metadataProbeForbidden) {
          const probes = await readFile(metadataProbeLog!, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return '';
            throw error;
          });
          expect(probes, 'runnable Agent birth must spend zero optional metadata subprocesses').toBe('');
        }
        // Runnable installations never spend pre-birth work on an optional update,
        // including an update that would be busy, pending, or failed.
        if (installed && !dependencyMissing) expect(acquisitionRequests).toHaveLength(0);
        events.push('birth', 'spawn'); return { type: 'success', sessionId,
        sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } }; },
      resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
    } },
  });
  const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'readiness-birth',
    executionTarget: { serverId: 'home-a', machineId }, directory: { kind: 'path', path: remoteFiles ? sourceWorkspace.rootPath : '/remote/project' },
    ...(remoteFiles ? { sessionPlacement: { kind: 'machine', target: { serverId: 'home-a', machineId },
      projectFilesSource: { target: { serverId: 'home-a', machineId: sourceWorkspace.machineId }, directory: sourceWorkspace.rootPath },
      ...(deferredClone ? { projectFiles: { kind: 'git_clone' } } : {}) } } : {}),
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false });
  const result = await executor.execute('session.spawn_new', input, { surface: 'cli', authority: 'present_user',
    actionCaller: { kind: 'host' }, serverId: 'home-a', actionRequestId: requestId, bypassApprovals: true });
  if (inventoryFailure) {
    expect(result).toMatchObject({ ok: false, errorCode: inventoryFailure });
    expect(events).toEqual(['inventory']);
    expect(acquisitionRequests).toEqual([]);
  } else if (actionFailure || !acquireAllowed && !installed) {
    expect(result).toMatchObject({ ok: false,
      errorCode: actionFailure ? 'machine_target_not_current' : RPC_ERROR_CODES.FORBIDDEN });
    expect(events).not.toContain('birth');
    expect(events).not.toContain('spawn');
    expect(acquisitionRequests).toHaveLength(actionFailure === 'status' ? 2 : 1);
  } else if (refusal) {
    expect(result).toMatchObject({ ok: true, result: { type: 'error', code: refusal, agentId: 'codex', retryable: false } });
    expect(events).toEqual(terminalFailed ? ['inventory', outdated ? 'update' : 'install', 'terminal'] : ['inventory']);
  } else {
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
    if (installed && outdated) {
      expect(result).toMatchObject({ result: { agentUpdate: { agentId: 'codex', status: 'pending', requestId } } });
    }
    expect(events).toEqual(['inventory', ...(remoteFiles ? ['source-open', 'target-copy'] : []), ...(!installed || dependencyMissing
      ? [outdated ? 'update' : 'install', ...(updateInUse ? [] : ['terminal'])] : []), 'birth', 'spawn']);
    if (remoteFiles) {
      const beforeRetry = events.length;
      const retried = await executor.execute('session.spawn_new', input, { surface: 'cli', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: 'home-a', actionRequestId: requestId, bypassApprovals: true });
      expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
      expect(events.slice(beforeRetry)).toEqual(['inventory']);
      if (deferredClone) {
        const conflicting = await executor.execute('session.spawn_new', { ...input, sessionPlacement: {
          ...input.sessionPlacement!, projectFiles: { kind: 'git_clone', branch: 'different-branch' },
        } }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
          serverId: 'home-a', actionRequestId: `${requestId}-changed`, bypassApprovals: true });
        expect(conflicting).toMatchObject({ ok: false, errorCode: 'creation_conflict' });
      }
    }
  }
});
