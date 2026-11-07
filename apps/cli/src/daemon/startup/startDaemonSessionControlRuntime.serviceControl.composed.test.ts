import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

import { ApiMachineClient } from '@/api/apiMachine';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import { createScmBackendRegistry } from '@/scm/registry';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';

// Substitute the physical listener, retaining the actual startup and RPC receiver.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }),
}));

afterEach(() => { vi.restoreAllMocks(); });

it('accepts native Service Stop through the startup-published Machine RPC receiver', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-service-control-startup-'));
  const happyHomeDir = join(directory, 'home');
  const serverId = 'service-control-home';
  const machineId = 'service-control-target';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
  let active: ApiMachineClient | null = null;
  const receiving: { routes?: DaemonLocalServicesMachineRpcRoutes } = {};
  // Home is a genuine HTTP boundary. Admission, custody and Action execution remain real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 0 } };
    if (path === `/v1/machines/${machineId}`) return { status: 200, data: {
      machine: { id: machineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
    } };
    throw new Error(`Unexpected Home GET: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(url).pathname;
    if (path === `/v1/machines/${machineId}/admission/verify`) {
      expect(body).toMatchObject({ context: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId } });
      return { status: 200, data: { v: 1, ok: true } };
    }
    throw new Error(`Unexpected Home POST: ${path}`);
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    const path = new URL(String(request.url)).pathname;
    if (path === '/v1/deployments/environments/access') return { status: 200,
      data: { ok: true, items: [{ environmentId: 'startup-environment', read: true, deploy: true }] } };
    throw new Error(`Unexpected Home request: ${path}`);
  });
  const fixture = await createRequesterSessionControlRuntimeFixture({
    happyHomeDir, activeServerDir: join(happyHomeDir, 'servers', serverId), serverId,
    serverHttpBaseUrl: 'https://service-control.invalid', machineId, custodianAccountId: 'owner',
    credentials: { token, encryption: null },
    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
    resolveQualifiedConnectedAccountV4Support: () => 'advertised', getApiMachineForSessions: () => active,
    beforeStartup: async () => {
      await writeStoredCredentialsForServerId(serverId, { token, encryption: null });
      const profile = await addServerProfile({ name: serverId, serverUrl: 'https://service-control.invalid',
        webappUrl: 'https://service-control.invalid' });
      expect(profile.id).toBe(serverId);
      await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
        v: 1, homeServerIdentityId: 'srv_service_control', canonicalServerUrl: profile.serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: profile.serverUrl }],
      } });
    },
    startup: { pluginRuntimeController: pluginReloadController,
      onLocalServicesRoutesReady: routes => { receiving.routes = routes; },
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: serverId }),
    },
  });
  let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  try {
    admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir, controller: pluginReloadController,
      runtimeOptions: { pluginIds: [] } });
    active = new ApiMachineClient(token, { id: machineId, encryptionMode: 'plain',
      metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: directory, happyHomeDir },
      metadataVersion: 1, daemonState: null, daemonStateVersion: 0 });
    if (!receiving.routes) throw new Error('Missing startup Local Services receiver');
    active.registerLocalServicesRoutes(receiving.routes);
    const document = JSON.stringify({ services: { web: { image: 'example/web:1' } } });
    const release = await createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]),
      async admit() { return { environmentId: 'startup-environment', environmentInstanceId: 'startup-instance',
        deploymentId: 'startup-deployment', machineId, installationId: 'startup-installation',
        deploymentRoot: join(directory, 'deployments'), artifactDirectory: join(directory, 'artifacts'),
        definition: { kind: 'stored' as const, contentRevision: 1, document,
          composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] },
        async assertCurrent() {} }; },
    }).materialize({ environmentId: 'startup-environment', deploymentId: 'startup-deployment' });
    await release.commit();
    let nativePhase: 'running' | 'stopped' = 'running';
    let nativeStops = 0;
    const service = await admitted.registry.projectManagedServices.superviseProject({ kind: 'environment',
      serverId, machineId, environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId,
      deploymentId: release.deploymentId, release, composeService: 'web', serviceId: 'startup-instance/web',
      specIdentity: 'startup-web', isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [] },
      // Native IO is the boundary; operation acceptance and native effect admission remain real.
      processSpec: { mode: { kind: 'native', builtinLifecycle: {
        async inspect() { return { phase: nativePhase, readiness: 'not_reported', endpoint: null }; },
        async stop() { nativeStops++; nativePhase = 'stopped'; return { status: 'stopped' }; },
      } } },
    });
    expect((await readStoredCredentialsForServerId(serverId))?.token === token).toBe(true);
    const controlled = await active.getPeerMediationMachineRpcHandlerManager().invokeLocal(
      RPC_METHODS.MACHINES_SERVICE_CONTROL, { serverId, machineId, serviceId: service.serviceId,
        expectedGeneration: service.instanceId, operation: 'stop' },
      { verifiedPeerAccountId: 'owner', verifiedPeerAuthority: 'present_user' },
    );
    expect(controlled).toMatchObject({ kind: 'observed', state: 'stopped', serviceId: service.serviceId,
      generation: service.instanceId, operation: { operationId: expect.any(String) } });
    expect(nativeStops).toBe(1);
  } finally {
    await active?.shutdown();
    await admitted?.dispose();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
