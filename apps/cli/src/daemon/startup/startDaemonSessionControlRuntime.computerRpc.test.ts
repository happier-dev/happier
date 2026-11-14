import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DaemonComputerActionExecuteResponseV1Schema } from '@happier-dev/protocol/computer/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createDaemonMachineRpcRouteAttachmentCache } from '../machineRpcRouteAttachments';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createMachineRolesRuntime } from '../roles/machineRolesRuntime';
import type { ComputerRoutes } from '../computer/routes';
import type { DaemonBrowserStoragePurgeOwner } from '../browser/control/routePublication';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';

// The private control listener is an OS boundary; startup, route attachment,
// Machine registration, RPC dispatch and Computer admission remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));

it.each([true, false])('serves Computer RPC when the machine arrives after startup (capture registry=%s)', async withRegistry => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-computer-rpc-startup-'));
  let active: ApiMachineClient | null = null;
  const attachments = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => active });
  const fixture = await createRequesterSessionControlRuntimeFixture({
    happyHomeDir: join(directory, 'home'), activeServerDir: join(directory, 'home', 'servers', 'computer-home'),
    serverId: 'computer-home', serverHttpBaseUrl: 'https://computer-home.invalid',
    machineId: 'machine-computer', custodianAccountId: 'owner', credentials: { token: 'computer-fixture', encryption: null },
    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
    resolveQualifiedConnectedAccountV4Support: () => 'advertised', getApiMachineForSessions: () => active,
    startup: {
      ...(withRegistry ? { liveStreamCaptureRegistry: createMachineLiveStreamCaptureRegistry() } : {}),
      onComputerRoutesReady: resolveComputer => attachments.attachDevicesRoleRoutes({ resolveComputer }),
      onDevicesRoleStopped: () => attachments.attachDevicesRoleRoutes(null),
    },
  });
  try {
    active = new ApiMachineClient('computer-fixture', { id: 'machine-computer', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    attachments.attachApiMachineForSessions(active);
    const manager: unknown = Reflect.get(active, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
    const result = DaemonComputerActionExecuteResponseV1Schema.parse(await manager.invokeLocal(
      RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
      { sessionId: 'session-computer', actionId: 'computer.target.get', input: { machineId: 'machine-computer' } },
      { verifiedPeerAuthority: 'present_user' },
    )).result;
    expect(result).toEqual(withRegistry
      ? { consentGranted: false, approvalDisplay: { machineDisplayName: 'machine-computer', requiresTargetSelection: true } }
      : { ok: false, errorCode: 'computer_unavailable', error: 'computer_unavailable' });
    // The devices role stops with the daemon and withdraws its RPC set.
    await fixture.runtime.stopControlServer();
    expect(manager.hasHandler(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE)).toBe(false);
  } finally {
    active?.shutdown();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('loads nothing for Computer, Browser or simulator while the devices role is off, serves them once on, and cleans what it owned when turned off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-devices-role-'));
  let active: ApiMachineClient | null = null;
  const attachments = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => active });
  // Server boundary: the Machine's opened metadata, edited to turn the role on.
  let metadata: Record<string, unknown> = { rolesV1: { active: ['sessions'] } };
  let metadataVersion = 1;
  const roles = createMachineRolesRuntime({ initialStoredRoles: ['sessions'], port: {
    read: async () => ({ status: 'ready' as const, metadata, metadataVersion }),
    compareAndSwap: async () => ({ status: 'conflict' as const, metadata, metadataVersion }),
  } });
  const onComputerRoutesReady = vi.fn((resolveComputer: () => ComputerRoutes | null) =>
    attachments.attachDevicesRoleRoutes({ resolveComputer }));
  let browserProfiles: DaemonBrowserStoragePurgeOwner['store'] | null = null;
  const fixture = await createRequesterSessionControlRuntimeFixture({
    happyHomeDir: join(directory, 'home'), activeServerDir: join(directory, 'home', 'servers', 'devices-home'),
    serverId: 'devices-home', serverHttpBaseUrl: 'https://devices-home.invalid',
    machineId: 'machine-devices', custodianAccountId: 'owner', credentials: { token: 'devices-fixture', encryption: null },
    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
    resolveQualifiedConnectedAccountV4Support: () => 'advertised', getApiMachineForSessions: () => active,
    startup: {
      liveStreamCaptureRegistry: createMachineLiveStreamCaptureRegistry(),
      machineRoles: roles, onComputerRoutesReady,
      onBrowserStoragePurgeOwnerReady: owner => { browserProfiles = owner.store; },
      onDevicesRoleStopped: () => attachments.attachDevicesRoleRoutes(null),
    },
  });
  try {
    active = new ApiMachineClient('devices-fixture', { id: 'machine-devices', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    attachments.attachApiMachineForSessions(active);
    const manager: unknown = Reflect.get(active, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
    expect(onComputerRoutesReady).not.toHaveBeenCalled();
    expect([RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE, RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES,
      RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT].filter(method => manager.hasHandler(method))).toEqual([]);

    metadata = { rolesV1: { active: ['sessions', 'devices'] } };
    metadataVersion++;
    await roles.reload();
    // Activation loads the role entry and resolves the simulator helpers before publishing.
    await vi.waitFor(() => expect(onComputerRoutesReady).toHaveBeenCalledOnce(), { timeout: 15_000 });
    expect(manager.hasHandler(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE)).toBe(true);
    expect(manager.hasHandler(RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES)).toBe(true);

    // A Session-owned browser profile with bytes on disk while the role runs.
    const store = browserProfiles!;
    store.register({ profileId: 'session-profile', storageMode: 'session', owner: { kind: 'session', id: 'session-devices' } });
    const profileDirectory = store.resolveProfileDirectory('session-profile');
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(profileDirectory, 'Cookies'), 'session bytes');

    // Turning the role off withdraws its RPC set and cleans the data it owned: no Session can reach
    // the profile while the role is off, and nothing would purge it when that Session ends.
    metadata = { rolesV1: { active: ['sessions'] } };
    metadataVersion++;
    await roles.reload();
    await vi.waitFor(() => expect(manager.hasHandler(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE)).toBe(false), { timeout: 15_000 });
    await vi.waitFor(() => expect(store.getProfile('session-profile')).toBeNull(), { timeout: 15_000 });
    await expect(stat(profileDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    active?.shutdown();
    roles.stop();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
