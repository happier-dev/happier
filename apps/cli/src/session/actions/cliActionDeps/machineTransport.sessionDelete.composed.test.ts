import axios from 'axios';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createNativeSessionDeleteAction } from '@/daemon/sessions/sessionDeleteAction';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { readStoredCredentialsForServerId, sameStoredCredentials, writeStoredCredentialsForServerId } from '@/persistence';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { AuthTokenProvenanceV2Schema } from '@happier-dev/protocol/auth/authToken';
import type { StoredCredentials } from '@/persistence';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, WorkspaceExecutionConfigReadResponseV1Schema } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

afterEach(() => vi.restoreAllMocks());

it('refuses a broker foreign initiator identified only by runtime Account before a Project finite Action', async () => {
  const installedCredentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: AuthTokenProvenanceV2Schema.parse({ v: 2, kind: 'terminal', authority: 'account_automation',
      evidence: [{ kind: 'home_method', methodId: 'key_challenge' }] }),
  })).toString('base64url')}.signature`, encryption: null, credentialProvenance: 'stored_session' };
  let finite: ReturnType<typeof createInstalledProjectFiniteRuntime> | undefined;
  let finitePorts: Parameters<ReturnType<typeof createInstalledProjectFiniteRuntime>>[0] | undefined;
  const agentIsolation = { read: () => ({ enabled: false as const, status: { kind: 'disabled' as const }, workspaceRoots: [] }) };
  const accountSettings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {},
    approvalWaivedSurfaces: { 'projects.prepare': ['rpc'] } } });
  const f = await createInstalledFilesystemMachineFixture({ agentIsolation, credentials: installedCredentials, accountSettings,
    readAdditionalHttpResponse: async url => new URL(url).pathname.startsWith('/v1/artifacts/')
      ? { status: 404, data: { error: 'not_found' } } : undefined,
    createProjectFiniteRuntime: (...args) => {
      if (!finite) throw new Error('Finite runtime not installed');
      finitePorts = args[0];
      return finite(...args);
    } });
  await seedTestServerProfile({ id: f.serverId, homeId: f.homeServerIdentityId, serverUrl: f.serverHttpBaseUrl });
  await writeStoredCredentialsForServerId(f.serverId, installedCredentials);
  expect(sameStoredCredentials(installedCredentials, await readStoredCredentialsForServerId(f.serverId))).toBe(true);
  const previous = getActiveAccountSettingsSnapshot();
  onTestFinished(() => { if (previous) setActiveAccountSettingsSnapshot(previous); else resetActiveAccountSettingsSnapshotForTests(); });
  await bootstrapAccountSettingsContext({ credentials: installedCredentials, mode: 'blocking', refresh: 'force', publication: 'active',
    caller: 'broker_project_finite_fixture' });
  // Same Home publications and Account-row boundary as the installed finite
  // terminal composition; native admission and Project execution stay real.
  const publication = MachinePublishedRowV1Schema.parse({ id: f.machineId, kind: 'persistent', active: true,
    revokedAt: null, replacedByMachineId: null, managedMachineRef: null, installationId: f.installation.installationId,
    access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
    metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', homeDir: f.directory,
      happyCliVersion: 'test', happyHomeDir: f.directory }), metadataVersion: 1,
    daemonState: null, daemonStateVersion: 0, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
  const originalGet = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    if (String(url).endsWith('/v1/machines')) return { status: 200, data: [publication] };
    if (String(url).endsWith(`/v1/machines/${f.machineId}`)) return { status: 200, data: { machine: publication } };
    return originalGet(url, options);
  });
  const accepted = materializeWorkspaceRefForMachineRoot([], { serverId: f.homeServerIdentityId,
    machineId: f.machineId, rootPath: f.directory, nowMs: 1, createId: () => 'broker-project' });
  const rows = [createPlainProjectAccountRefRow(accepted.workspaceRef)];
  const originalPost = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
    if (String(url).includes('/project-rows/')) return projectAccountRowsReadHttpResponse(rows, String(url), body);
    if (String(url).endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
    if (String(url).endsWith(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`)) return { status: 200,
      data: WorkspaceExecutionConfigReadResponseV1Schema.parse({ status: 'absent' }) };
    return originalPost(url, body, options);
  });
  finite = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => { throw new Error('Unexpected placement'); } },
    credentials: installedCredentials, externalActionAccountId: 'requester', finiteServerId: f.serverId,
    finiteServerHttpBaseUrl: f.serverHttpBaseUrl, registeredMachineId: f.machineId,
    admission: createProjectWorkerAdmission({ machineId: f.machineId, admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
    nativeIo: createProjectNativeIo({ agentIsolation }), agentIsolation, successHomeDir: f.directory,
    isCurrent: async () => f.isHomeCurrent(), prepareBetween: async () => { throw new Error('Unexpected Sync'); },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: f.homeServerIdentityId, machineId: f.machineId }) });
  const deps = createCliActionDeps({ token: installedCredentials.token, credentials: installedCredentials,
    sessionId: '', mode: 'plain', ctx: null, serverId: f.serverId, serverIdentityId: f.homeServerIdentityId,
    serverHttpBaseUrl: f.serverHttpBaseUrl, machineActionDirectTargetTransport: { machineId: f.machineId,
      invoke: (method, input, options) => f.rpcHandlerManager.invokeLocal(method, input, options) } });
  const input = { workspace: { serverId: f.serverId, machineId: f.machineId, workspaceId: 'broker-project', rootPath: f.directory }, phase: 'setup' };
  const context = { surface: 'rpc' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
    runtimeAccountId: 'requester' };
  const execute = (actionContext: typeof context & Partial<Pick<RpcHandlerContext, 'machineAdmission' | 'verifyMachineAdmissionCurrent'>>) =>
    deps.projectAction!({ actionId: 'projects.prepare', input, context: actionContext });
  const admitted = await execute({ ...context, machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester',
    machineId: f.machineId, installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => f.isHomeCurrent() });
  expect(admitted, JSON.stringify({ admitted, postUrls: vi.mocked(axios.post).mock.calls.map(([url]) => String(url)) }))
    .toMatchObject({ operation: { operationId: expect.any(String) } });
  if (!finitePorts || typeof admitted !== 'object' || !admitted || !('operation' in admitted)) throw new Error('Finite operation not admitted');
  const operation = ProjectCommandActionOutputV1Schema.parse(admitted).operation;
  expect(await finitePorts.operationRuntime.runner.waitForTerminal(operation.scope, operation.operationId)).toMatchObject({ state: 'succeeded' });
  for (const runtimeAccountId of ['requester', 'foreign-broker-initiator']) {
    await expect(execute({ ...context, runtimeAccountId })).rejects.toMatchObject({ rpcErrorCode: 'agent_isolation_unavailable', effectAttempted: false });
  }
});

it('refuses the legacy raw CLI Delete at the native owner for a guest own managed Session', async () => {
  let finite: ReturnType<typeof createInstalledProjectFiniteRuntime> | undefined;
  const agentIsolation = { read: () => ({ enabled: false as const, status: { kind: 'disabled' as const }, workspaceRoots: [] }) };
  const f = await createInstalledFilesystemMachineFixture({ agentIsolation,
    createProjectFiniteRuntime: (...args) => {
      if (!finite) throw new Error('Finite runtime not installed');
      return finite(...args);
    } });
  finite = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => { throw new Error('Unexpected placement'); } },
    credentials: f.bootstrap.credentials, externalActionAccountId: 'requester', finiteServerId: f.serverId,
    finiteServerHttpBaseUrl: f.serverHttpBaseUrl, registeredMachineId: f.machineId,
    admission: createProjectWorkerAdmission({ machineId: f.machineId, admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
    nativeIo: createProjectNativeIo({ agentIsolation }), agentIsolation, successHomeDir: f.directory,
    isCurrent: async () => f.isHomeCurrent(), prepareBetween: async () => { throw new Error('Unexpected Sync'); },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: f.homeServerIdentityId, machineId: f.machineId }) });
  const directories = createManagedSessionDirectories({});
  const allocation = await directories.materializeForFreshSpawn({ sessionCreationTag: 'guest-own-session' });
  await directories.bind({ allocationId: allocation.allocationId, sessionId: 'guest-own-session' });
  await writeFile(join(allocation.directory, 'guest-work'), 'guest bytes');
  const ingress: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'requester', machineId: f.machineId,
      installationId: f.installation.installationId, role: 'use', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true };
  const native = createNativeSessionDeleteAction({ ingress,
    resolveRuntime: async context => await f.machine.resolveProjectFiniteRuntime(context) ?? null,
    isSessionActive: async () => false, retireRequesterCustody: async () => true,
    nativeOperationRuntime: { readMemberFolderOwner: async () => null,
      prepareNativeOperation: async () => { throw new Error('No member process'); } } });
  const operations = createHostActionOperationRuntime({ machineId: f.machineId, resolveAccountId: async () => 'guest' });
  let result: unknown;
  let homeDeleted = false;
  const post = vi.mocked(axios.post); post.mockClear();
  const scope = { accountId: 'guest', machineId: f.machineId };
  const accepted = await operations.observeExecution({ actionId: 'session.delete', input: { sessionId: 'guest-own-session' },
    actionRequestId: 'legacy-delete', response: 'admission', execute: async context => {
      const execution = await native({ input: { sessionId: 'guest-own-session' }, context,
        deleteFromHome: async beforeDelete => {
          await beforeDelete?.();
          homeDeleted = true;
          return { ok: true, result: { success: true } };
        } });
      result = execution;
      return execution;
    } });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error('Operation not admitted');
  const operation = operations.store.list(scope).items[0]!;
  await operations.runner.waitForTerminal(scope, operation.operationId);
  expect(result).toMatchObject({ ok: false, errorCode: 'project_setup_operation_unavailable' });
  expect(homeDeleted).toBe(false);
  expect(await readFile(join(allocation.directory, 'guest-work'), 'utf8')).toBe('guest bytes');
  expect(post.mock.calls.some(([url]) => String(url).includes('/project-rows/'))).toBe(false);
});
