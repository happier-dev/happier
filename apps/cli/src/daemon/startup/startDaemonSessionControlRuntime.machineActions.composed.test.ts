import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import { ApiMachineClient } from '@/api/apiMachine';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';

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
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (new URL(url).pathname === '/v1/account/encryption') {
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    }
    throw new Error(`Unexpected Home GET: ${new URL(url).pathname}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(url).pathname;
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
    },
    startup: {
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
      metadata: null,
      metadataVersion: 0,
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
  } finally {
    active?.shutdown();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
