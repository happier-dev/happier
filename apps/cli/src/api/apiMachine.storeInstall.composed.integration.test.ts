import { createNativeSoftwareOsFixture } from '@/testkit/machines/nativeSoftwareOs';
import * as React from 'react';
import { readFile } from 'node:fs/promises';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { z } from 'zod/mini';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readMachineAdminAccessV1, MachineAdminAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema,
  ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.composed.testkit';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { installRealActionExecutorModuleLoader } from '../../../ui/sources/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { renderScreen } from '../../../ui/sources/dev/testkit/render/renderScreen';
import { standardCleanup } from '../../../ui/sources/dev/testkit/cleanup/standardCleanup';
import { installVitestRnShim } from '../../../ui/sources/dev/vitestRnShim';
import { installLocalStorageMock, installWebLockManagerMock } from '../../../ui/sources/auth/storage/tokenStorage.web.testHelpers';
import type { StoreSoftwareEntryState } from '../../../ui/sources/components/store/StoreSoftwareEntry';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), navigate: vi.fn(), dismissTo: vi.fn() }));
// This integration starts the actual Home and daemon lifecycle. Only platform
// SDKs and the physical package-manager/elevation boundary are
// substituted. Account, Home HTTP/socket, daemon ingress and Run owners are real.
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('../../../ui/sources/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('react-native', async () => {
  const { createReactNativeWebRuntime } = await import('../../../ui/sources/dev/testkit/runtime/reactNativeRuntime');
  return createReactNativeWebRuntime(undefined, () => vi.importActual<typeof import('../../../ui/sources/dev/reactNativeStub')>('../../../ui/sources/dev/reactNativeStub'));
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('../../../ui/sources/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
  const { createExpoUpdatesMock } = await import('../../../ui/sources/dev/testkit/mocks/expoUpdates');
  return createExpoUpdatesMock();
});
vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemFileMock } = await import('../../../ui/sources/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemFileMock().module;
});
vi.mock('react-native-typography', async () => {
  const { createReactNativeTypographyMock } = await import('../../../ui/sources/dev/testkit/mocks/reactNativeTypography');
  return createReactNativeTypographyMock();
});
vi.mock('@shopify/react-native-skia', async () => {
  const { createReactNativeSkiaMock } = await import('../../../ui/sources/dev/testkit/mocks/reactNativeSkia');
  return createReactNativeSkiaMock();
});
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('__DEV__', true);
vi.stubGlobal('self', globalThis);
installVitestRnShim();
const browserStorage = installLocalStorageMock();
await loadSyncSingletonForTests();
const { StoreSoftwareEntry } = await import('../../../ui/sources/components/store/StoreSoftwareEntry');
const { sync } = await import('../../../ui/sources/sync/sync');
const { storage } = await import('../../../ui/sources/sync/domains/state/storage');
const { createFrontDoorActionExecute } = await import('../../../ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('../../../ui/sources/sync/runtime/orchestration/connectionManager');
const { adoptHomeProfile, removeServerProfile, setActiveServerId } = await import('../../../ui/sources/sync/domains/server/serverProfiles');
const { TokenStorage } = await import('../../../ui/sources/auth/storage/tokenStorage');
const { resetRuntimeFetch } = await import('../../../ui/sources/utils/system/runtimeFetch');
const cleanups: Array<() => Promise<void>> = [];
let os: Awaited<ReturnType<typeof createNativeSoftwareOsFixture>>;
let daemon: Awaited<ReturnType<typeof startInstalledDaemonFixture>>;
let disposeLoader: (() => void) | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
let uiServerId: string | undefined;
let credentialWrite: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>> | undefined;
const InstalledStateSchema = z.strictObject({ installed: z.boolean(), version: z.nullable(z.string()), effects: z.array(z.string()) });

beforeAll(async () => {
  os = await createNativeSoftwareOsFixture({ manager: 'apt' });
  cleanups.push(os.dispose);
  daemon = await startInstalledDaemonFixture({ plugins: os.plugins, registerCleanup: cleanup => { cleanups.push(cleanup); },
    onStartupPhase: phase => { console.info('Installed Store daemon startup:', phase); },
    onShutdownPhase: phase => { console.info('Installed Store daemon shutdown:', phase); } });
});
beforeEach(async () => {
  resetRuntimeFetch();
  webLocks = installWebLockManagerMock();
  for (const method of Object.values(navigation)) method.mockClear();
  disposeLoader = await installRealActionExecutorModuleLoader();
});
afterEach(async () => {
  await standardCleanup();
  await disconnectActiveServerConnection();
  disposeLoader?.();
  const { serverScopedRpcSocketPool } = await import('../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
  await serverScopedRpcSocketPool.stopAll();
  await credentialWrite?.rollback();
  credentialWrite = undefined;
  if (uiServerId) await removeServerProfile(uiServerId);
  uiServerId = undefined;
  webLocks?.restore();
});
afterAll(async () => {
  try { for (const cleanup of cleanups.reverse()) await cleanup(); }
  finally { browserStorage.restore(); }
});

it.skipIf(process.platform !== 'linux')('installs Store software from its one designed confirmation through the native recipe and system task', async () => {
  let phase = 'restore the actual Home Account';
  const requests: Array<Readonly<{ method: string; path: string; status: number }>> = [];
  onTestFailed(() => console.error('Native Store composed boundary', { phase,
    requests, commands: os.nativeCommands, rootLaunches: os.rootLaunches.length }));
  const realFetch = globalThis.fetch;
  const applyTransport: { request?: Request; response?: unknown } = {};
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const capture = request.method === 'POST'
      && new URL(request.url).pathname === '/v1/actions/machines.setup.apply' && !applyTransport.request;
    if (capture) applyTransport.request = request.clone();
    const response = await realFetch(input, init);
    requests.push({ method: request.method, path: new URL(request.url).pathname, status: response.status });
    if (capture) applyTransport.response = await response.clone().json();
    return response;
  });
  onTestFinished(() => { transport.mockRestore(); });
  const profile = await adoptHomeProfile({ descriptor: { serverUrl: daemon.home.baseUrl,
    homeServerIdentityId: daemon.home.homeId, displayName: 'Installed Store Home' },
    source: 'manual', suggestedName: 'Installed Store Home' });
  const serverId = profile.id;
  uiServerId = serverId;
  // The actual Account token is shared; CLI's encryption:null is not UI's
  // canonical token-only Plain credential representation.
  const uiCredentials = { token: daemon.home.token };
  credentialWrite = await TokenStorage.setCredentialsForServerUrlWithRollback(profile.serverUrl, { serverId }, uiCredentials);
  if (!credentialWrite) throw new Error('The browser must retain the actual Home credential');
  expect(await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId })).toEqual(uiCredentials);
  await setActiveServerId(serverId, { scope: 'device' });
  await restoreConnectionToActiveServer(uiCredentials);
  phase = 'hydrate actual Machine inventory';
  await sync.refreshMachines();
  const target = { scope: { serverId, accountId: daemon.home.accountId },
    machine: { serverIdentityId: daemon.home.homeId, machineId: daemon.machineId } };
  phase = 'await actual native admin route attachment';
  await daemon.home.waitForMachineRpc(daemon.machineId, RPC_METHODS.MACHINE_ADMIN_ACCESS_SET);
  phase = 'confirm the native admin policy through its actual transition';
  const machine = storage.getState().machines[daemon.machineId];
  if (!machine) throw new Error('The actual Home must publish its installed Machine');
  const adminPolicy = readMachineAdminAccessV1(machine.metadata);
  if (adminPolicy.status !== 'ready') throw new Error(`Machine admin policy unavailable: ${adminPolicy.status}`);
  const admin = await createFrontDoorActionExecute().confirmed('machines.setup.adminAccess.set', {
    machineId: daemon.machineId, serverId, expectedMetadataVersion: machine.metadataVersion,
    expectedAdminAccess: adminPolicy.policy, adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field',
  }, { surface: 'ui', serverId, expectedAccountId: daemon.home.accountId });
  if (!admin.ok) throw new Error(`Machine admin transition failed: ${admin.errorCode}`);
  expect(MachineAdminAccessMutationResultV1Schema.parse(admin.result)).toMatchObject({
    status: 'applied', policy: { version: 1, mode: 'preauthorized' },
  });
  expect(await readFile(os.sudoersPath, 'utf8')).toContain('NOPASSWD');
  const readInstalled = async () => InstalledStateSchema.parse(JSON.parse(await readFile(os.statePath, 'utf8')));
  const readArtifacts = async () => {
    const response = await realFetch(`${daemon.home.baseUrl}/v1/artifacts`, {
      headers: { Authorization: `Bearer ${daemon.home.token}` },
    });
    expect(response.ok).toBe(true);
    return await response.json();
  };
  let entry: StoreSoftwareEntryState | undefined;
  phase = 'mount selected Store entry';
  await renderScreen(React.createElement(StoreSoftwareEntry, { target,
    selection: { value: { pluginId: 'com.example.public-package', recipeId: 'jq', revision: '1' }, label: 'Exact jq' },
    demand: { presented: true }, children: state => { entry = state; return null; },
  }));
  phase = 'await actual daemon Store declaration';
  await vi.waitFor(() => expect(entry?.status).toBe('ready'));
  let prepared: Awaited<ReturnType<StoreSoftwareEntryState['prepare']>> | undefined;
  phase = 'prepare exact native review';
  await act(async () => { prepared = await entry!.prepare({ inputs: {}, targets: [target] }); });
  if (!prepared?.ok) throw new Error(`Store review failed: ${prepared?.errorCode ?? 'missing_review'}`);
  expect(await readInstalled()).toEqual({ installed: false, version: null, effects: [] });
  const rootLaunchesBeforeApply = os.rootLaunches.length;
  const applyInput = prepared.input;
  let operationId: string | undefined;
  phase = 'confirm and execute one Store Apply';
  await act(async () => {
    const result = await entry!.apply(applyInput);
    if (!result.ok) throw new Error(`Store install failed: ${result.errorCode}`);
    operationId = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].parse(result.result).operationId;
  });
  if (!operationId) throw new Error('Store install must expose its actual operation');
  phase = 'observe actual operation and OS install state';
  const operation = ActionOperationGetV1ResponseSchema.parse(await daemon.invoke(ACTION_OPERATION_RPC_METHODS_V2.get,
    { operationId, waitForTerminal: true }));
  expect(operation).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
  expect(await readArtifacts()).toEqual([]);
  expect(await readInstalled()).toEqual({ installed: true, version: '1.0', effects: ['apt-get'] });
  expect(os.rootLaunches.length - rootLaunchesBeforeApply).toBe(1);
  expect((await daemon.home.readWorkflowSessionEffects()).runs).toEqual([
    expect.objectContaining({ state: 'succeeded', accountId: daemon.home.accountId }),
  ]);
  const children = ActionOperationListV1ResponseSchema.parse(await daemon.invoke(ACTION_OPERATION_RPC_METHODS_V2.list, {}));
  const child = children.items.find(value => value.operationId !== operationId && value.domainRef?.kind === 'machineSetup');
  expect(child).toMatchObject({ state: 'succeeded', domainRef: {
    kind: 'machineSetup', setupTask: { id: expect.any(String), taskKind: 'machine.setup.apply.v1' },
  } });
  if (child?.domainRef?.kind !== 'machineSetup' || !child.domainRef.setupTask)
    throw new Error('Store install must settle its actual system task');
  expect(await getLiveSystemTasksRunnerAdapter().wait({ taskId: child.domainRef.setupTask.id }))
    .toMatchObject({ ok: true, data: { operationId: child.operationId } });
  phase = 'rejoin the same original request across fresh transport decoding';
  if (!applyTransport.request) throw new Error('The Store Apply must cross its real Home HTTP boundary');
  const replay = await realFetch(applyTransport.request.clone());
  expect(replay.ok).toBe(true);
  expect(await replay.json()).toEqual(applyTransport.response);
  expect(await readArtifacts()).toEqual([]);
  const rejoined = ActionOperationListV1ResponseSchema.parse(await daemon.invoke(ACTION_OPERATION_RPC_METHODS_V2.list, {}));
  expect(rejoined.items.map(value => value.operationId).sort()).toEqual(children.items.map(value => value.operationId).sort());
  expect(await readInstalled()).toEqual({ installed: true, version: '1.0', effects: ['apt-get'] });
  expect(os.rootLaunches.length - rootLaunchesBeforeApply).toBe(1);
  for (const method of Object.values(navigation)) expect(method).not.toHaveBeenCalled();
});
