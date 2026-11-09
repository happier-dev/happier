import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { ApiMachineClient } from '@/api/apiMachine';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';

// The private listener is an OS boundary. Startup composition and the Action
// executor it publishes remain real.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});
it('resolves Machine Action adapters after the daemon startup executor is published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-machine-actions-startup-'));
  const serverId = 'machine-actions-home';
  const machineId = 'machine-actions-target';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  let active: ApiMachineClient | null = null;
  const receiving: { routes?: DaemonLocalServicesMachineRpcRoutes } = {};
  let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/account/encryption') {
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    }
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
    if (path === `/v1/machines/${machineId}`) return { status: 200, data: {
      machine: { id: machineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
    } };
    throw new Error(`Unexpected Home GET: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(url).pathname;
    if (path === `/v1/machines/${machineId}/admission/verify`) {
      // Home is the network boundary. The real installed verifier signs the
      // proof and checks the exact local custodian/installation before this read.
      expect(body).toMatchObject({ context: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId } });
      return { status: 200, data: { v: 1, ok: true } };
    }
    // Project setup reads the exact workspace-ref key (/read) or a kind-scoped selection (/list).
    if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list` || path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) {
      return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow({
        id: 'workspace-ref',
        serverId,
        machineId,
        rootPath: directory,
        projectKey: 'machine-actions-project',
        createdAtMs: 1,
      })], path, body);
    }
    throw new Error(`Unexpected Home POST: ${path}`);
  });
  const fixture = await createRequesterSessionControlRuntimeFixture({
    happyHomeDir: join(directory, 'home'),
    activeServerDir: join(directory, 'home', 'servers', serverId),
    serverId,
    serverHttpBaseUrl: 'https://machine-actions.invalid',
    machineId,
    custodianAccountId: 'owner',
    credentials: { token, encryption: null },
    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    registry: new ConnectedServiceRuntimeRegistry(),
    trackedSessions: new Map(),
    getRequester: () => null,
    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    getApiMachineForSessions: () => active,
    beforeStartup: async () => {
      await writeStoredCredentialsForServerId(serverId, { token, encryption: null });
      const profile = await addServerProfile({ name: serverId, serverUrl: 'https://machine-actions.invalid',
        webappUrl: 'https://machine-actions.invalid' });
      expect(profile.id).toBe(serverId);
      await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
        v: 1, homeServerIdentityId: 'srv_machine_actions', canonicalServerUrl: profile.serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: profile.serverUrl }],
      } });
    },
    startup: {
      onLocalServicesRoutesReady: routes => { receiving.routes = routes; },
      resolveCurrentMachineExecutionOriginContext: async () => ({
        machineId,
        serverIdentityId: serverId,
      }),
    },
  });
  try {
    const owner = fixture.runtime.externalActionIngressOwner;
    if (!owner) throw new Error('Missing startup-composed Action owner');
    // The protected Action phase recognizes this canonical error type; a bare
    // Error with a code property would instead become an internal_error.
    await expect(owner.invokeResource?.(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, {}, {
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(PluginError);

    const context = {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      serverId,
      runtimeAccountId: 'owner',
      defaultSessionMachineId: machineId,
      externalActionTarget: { kind: 'machine' as const, machineId },
    };
    await expect(owner.executor.execute('workspace.tabs.open', {
      href: '/projects',
      mode: 'preview',
    }, context)).resolves.toMatchObject({
      ok: false,
      errorCode: 'machine_transport_unavailable',
    });

    active = new ApiMachineClient(token, {
      id: machineId,
      encryptionMode: 'plain',
      metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: directory, happyHomeDir: directory,
        serviceWatchesV1: { v: 1, watches: [{ v: 1, watchId: 'startup-watch', name: 'Startup worker',
          adapter: { pluginId: 'acme.unavailable', localId: 'native' }, nativeResourceId: 'worker.service', lifecyclePurpose: 'infrastructure' }] } },
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const filesystemExecute = vi.fn(async () => ({
      success: true as const,
      content: Buffer.from('ready').toString('base64'),
    }));
    const filesystemFactory = vi
      .spyOn(active, 'createFilesystemActionExecutor')
      .mockReturnValue(filesystemExecute);
    const invokeLocalMachineAction = vi
      .spyOn(active, 'invokeLocalMachineAction')
      .mockResolvedValue({
        controllerMachineId: machineId,
        sets: [],
        relationships: [],
        remoteRelationships: [],
        membership: { workspaceRefId: null, found: null },
        discoveryAvailable: true,
      });
    vi.spyOn(active, 'hasConnectedClientRpcHandler').mockImplementation(
      method => method === RPC_METHODS.UI_ACTION_EXECUTE,
    );
    vi.spyOn(active, 'callConnectedClientRpc').mockImplementation(async (_method, _request, options) => {
      options.onIssued();
      return { ok: true, result: { v: 1, execution: { ok: true, result: { ok: true } } } };
    });
    await expect(owner.executor.execute('workspace.tabs.open', {
      href: '/projects',
      mode: 'preview',
    }, context)).resolves.toMatchObject({ ok: true });
    const filesystemResult = await owner.executor.execute('daemon.filesystem.readFile', {
      rootPath: directory,
      path: 'payload.txt',
    }, context);
    expect(filesystemResult, JSON.stringify(filesystemResult)).toMatchObject({ ok: true });
    expect(filesystemFactory).toHaveBeenCalledWith(serverId);
    expect(filesystemExecute).toHaveBeenCalledTimes(1);

    const relationshipsResult = await owner.executor.execute('workspace.sync.relationships.list', {
      controllerMachineId: machineId,
    }, context);
    expect(relationshipsResult, JSON.stringify(relationshipsResult)).toMatchObject({ ok: true });
    expect(invokeLocalMachineAction).toHaveBeenCalledWith(
      RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST,
      expect.anything(),
      expect.anything(),
    );
    // The daemon must bind its private service owner, not round-trip this
    // Action through the local RPC stub used by unrelated Machine families.
    const services = await owner.executor.execute('machines.services.list', { serverId, machineId }, context);
    expect(services, JSON.stringify(services))
      .toMatchObject({ ok: true, result: { kind: 'snapshot', services: [{ serviceId: 'startup-watch', state: 'unknown' }] } });

    // Exercise the OTHER startup receiver: ordinary Machine-custodian ingress
    // has no private requester executor to bypass its published resolver.
    invokeLocalMachineAction.mockRestore();
    if (!receiving.routes) throw new Error('Missing startup Local Services receiver');
    active.registerLocalServicesRoutes(receiving.routes);
    channel = await createRequesterCurrentnessSocketHarness();
    const outbound: unknown[] = [];
    channel.server.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.CALL, (request: unknown, acknowledge: (response: unknown) => void) => {
        outbound.push(request);
        acknowledge({ ok: true, result: { ok: false, errorCode: 'unexpected_self_rpc', error: 'unexpected_self_rpc' } });
      });
    });
    const received = await active.getPeerMediationMachineRpcHandlerManager().invokeLocal(
      RPC_METHODS.MACHINES_SERVICE_LIST, { serverId, machineId },
      { verifiedPeerAccountId: 'owner', verifiedPeerAuthority: 'present_user' },
    );
    expect.soft(received).toMatchObject({ kind: 'snapshot', services: [{ serviceId: 'startup-watch', state: 'unknown' }] });
    expect(outbound).toEqual([]);
    const installed = active;
    active = null;
    try {
      expect(await installed.getPeerMediationMachineRpcHandlerManager().invokeLocal(
        RPC_METHODS.MACHINES_SERVICE_LIST, { serverId, machineId },
        { verifiedPeerAccountId: 'owner', verifiedPeerAuthority: 'present_user' },
      )).toMatchObject({ kind: 'unavailable', reason: 'admission_unavailable' });
      expect(outbound).toEqual([]);
    } finally { active = installed; }
  } finally {
    await active?.shutdown();
    await channel?.close();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
