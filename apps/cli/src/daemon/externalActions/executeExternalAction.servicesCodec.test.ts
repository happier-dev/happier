import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineServicesListResultV1Schema, type MachineMetadataFieldReadV1 } from '@happier-dev/protocol';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineServicesRuntime } from '@/daemon/local/services/launch/machineServices';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';

describe('credential-free native services codec', () => {
  it.each(['plain', 'e2ee'] as const)('lists native services without requester credentials and preserves requester disclosure ($0)', async accountEncryptionMode => {
    const home = await mkdtemp(join(tmpdir(), 'happier-services-codec-'));
    const fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
      runtimeOptions: { pluginIds: [] } });
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const homeId = 'srv_services_codec';
    const machine = { serverId: homeId, machineId: 'company-controller' };
    const target = { kind: 'machine' as const, machineId: machine.machineId };
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'company' })).toString('base64url')}.signature`, encryption: null };
    const watch = { v: 1 as const, watchId: 'machine-watch', name: 'Machine worker', adapter: { pluginId: 'fixture.native', localId: 'service' },
      nativeResourceId: 'worker.service', lifecyclePurpose: 'infrastructure' as const };
    const metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1,
      metadata: { serviceWatchesV1: { v: 1, watches: [watch] } } };
    const runtime = createMachineServicesRuntime({ target: machine, readMetadata: () => metadata,
      captureMetadataPort: () => ({ read: async () => metadata,
        compareAndSwap: async () => { throw new Error('Inventory must not mutate Machine metadata'); } }) });
    const owner = fixture.registry.projectManagedServices;
    const handles: Awaited<ReturnType<typeof owner.superviseProject>>[] = [];
    let environmentReadable = false;
    let accessUnavailable = false;
    let httpBoundaryFailure: unknown;
    const observedRequesters: (string | null | undefined)[] = [];
    const http = vi.spyOn(axios, 'request').mockImplementation(async request => {
      try {
        expect(request.url).toBe('https://services-codec.test/v1/deployments/environments/access');
        expect(request.method).toBe('POST');
        expect(request.data).toEqual({ serverId: homeId, environmentIds: ['private-environment'] });
        expect(Object.keys(request.headers ?? {}).some(name => name.toLowerCase() === 'authorization')).toBe(false);
        const headers = request.headers;
        const token = headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
        const signature = headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        expect(typeof token).toBe('string');
        expect(typeof signature).toBe('string');
        if (typeof token !== 'string' || typeof signature !== 'string') throw new Error('Missing installed signed requester proof');
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: token, effectActionId: 'machines.services.list', target,
          installationId: 'company-installation', requestId: 'native-services-codec', method: 'POST',
          path: '/v1/deployments/environments/access', body: request.data, publicKey: installation.publicKey, signature })).toBe(true);
        return accessUnavailable ? { status: 503, data: { ok: false, error: 'deployment_unavailable' } }
          : { status: 200, data: { ok: true, items: environmentReadable
            ? [{ environmentId: 'private-environment', read: true, deploy: false }] : [] } };
      } catch (error) {
        httpBoundaryFailure = error;
        throw error;
      }
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('Unexpected requester Account content read'); });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
      throw new Error('Unexpected requester Account write');
    });
    try {
      // Only native inspection is substituted. Registry publication, supervision,
      // ingress, execution, disclosure selection and signed HTTP remain real.
      for (const accountId of ['company', 'member']) {
        const workspace = { id: `${accountId}-workspace`, ...machine, rootPath: home, createdAtMs: 1 };
        handles.push(await owner.superviseProject({ kind: 'workspace', workspace,
          declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name: `${accountId}-worker` } },
          requester: { ...machine, accountId, installationId: 'company-installation' }, cwd: home,
          serviceId: `${accountId}-service`, specIdentity: `${accountId}-native-observation`, isCurrent: () => true,
          authorizeLaunch: async () => { throw new Error('Inventory must not launch a workspace service'); },
          processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
            async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
            async stop() { throw new Error('Inventory must not stop a workspace service'); },
          } } } }));
      }
      const document = JSON.stringify({ services: { web: { image: 'fixture/web:1' } } });
      const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
        return { environmentId: 'private-environment', environmentInstanceId: 'private-instance', deploymentId: 'private-deployment',
          machineId: machine.machineId, installationId: 'company-installation', deploymentRoot: join(home, 'deployments'),
          artifactDirectory: join(home, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1,
            document, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] },
          async assertCurrent() {} };
      } });
      const release = await materializer.materialize({ environmentId: 'private-environment', deploymentId: 'private-deployment' });
      await release.commit();
      handles.push(await owner.superviseProject({ kind: 'environment', ...machine,
        environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId,
        deploymentId: release.deploymentId, release, composeService: 'web', serviceId: 'private-instance/web',
        specIdentity: 'private-native-observation', isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [] },
        processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
          async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
          async stop() { throw new Error('Inventory must not stop an Environment service'); },
        } } } }));
      const executor = createCliActionExecutor({ credentials, token: credentials.token, mode: 'plain', ctx: null,
        sessionId: 'cli-global', serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'https://services-codec.test',
        externalActionMachineInstallationId: 'company-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
        pluginActionExecutionOwner: 'current_process', machineActionDirectTargetTransport: { machineId: machine.machineId,
          invoke: async () => { throw new Error('Native inventory must not re-enter Machine RPC'); },
          machineServiceAction: request => { observedRequesters.push(request.requesterAccountId); return runtime.execute(request); } } });
      const authentication = { kind: 'account' as const, tokenEpoch: 1 };
      const binding = { serverIdentityId: homeId, accountId: 'member', authentication, actionId: 'machines.services.list' as const,
        requestId: 'native-services-codec', target };
      const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
      const envelope = ExternalActionRequestEnvelopeSchema.parse(accountEncryptionMode === 'e2ee'
        ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
          binding, material, input: machine, randomBytes: tweetnacl.randomBytes })
        : { v: 1, requestId: binding.requestId, target, input: machine });
      const authorization = sealManagedControllerActionCodecV1({ authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
        token: 'home-native-services-root', binding: { ...binding, custodianAccountId: 'company', accountEncryptionMode,
          admittedMachineRole: 'manage', machineId: machine.machineId, installationId: 'company-installation',
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } }), material,
        invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' },
        installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
      const run = async () => {
        const response = await executeExternalAction({ actionId: binding.actionId, envelope,
          principal: { accountId: 'member', authority: 'present_user', authentication }, surface: 'cli',
          currentServerHttpBaseUrl: 'https://services-codec.test', currentMachineId: machine.machineId, currentAccountId: 'company',
          currentServerId: homeId, currentInstallationId: 'company-installation', executionAuthorization: authorization,
          externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
          isInstallationCurrent: () => true, resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor,
          prepareRequesterAccountContext: () => { throw new Error('Native inventory must not request full sign-in'); } });
        if (httpBoundaryFailure) throw httpBoundaryFailure;
        expect(response, JSON.stringify(response)).toMatchObject({ kind: 'response' });
        if (response.kind !== 'response') throw new Error('Missing native service response');
        return envelope.v === 2 ? openExternalActionResponseV2({ envelope: response.response, request: envelope, binding, material })
          : 'execution' in response.response ? response.response.execution : null;
      };
      const hidden = await run();
      expect(hidden, JSON.stringify(hidden)).toMatchObject({ ok: true, result: { kind: 'snapshot' } });
      if (!hidden?.ok) throw new Error('Native inventory failed');
      const hiddenRows = MachineServicesListResultV1Schema.parse(hidden.result);
      if (hiddenRows.kind !== 'snapshot') throw new Error('Expected native inventory snapshot');
      expect(hiddenRows.services.map(row => row.serviceId).sort()).toEqual(['machine-watch', 'member-service']);
      environmentReadable = true;
      const visible = await run();
      expect(visible, JSON.stringify(visible)).toMatchObject({ ok: true, result: { kind: 'snapshot' } });
      if (!visible?.ok) throw new Error('Native inventory failed after Environment admission');
      const visibleRows = MachineServicesListResultV1Schema.parse(visible.result);
      if (visibleRows.kind !== 'snapshot') throw new Error('Expected admitted Environment snapshot');
      expect(visibleRows.services.map(row => row.serviceId).sort()).toEqual(['machine-watch', 'member-service', 'private-instance/web']);
      accessUnavailable = true;
      expect(await run()).toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
      expect(observedRequesters).toEqual(['member', 'member', 'member']);
      expect(http).toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    } finally {
      http.mockRestore(); get.mockRestore(); post.mockRestore();
      for (const handle of handles) await handle.dispose();
      await runtime.dispose(); await fixture.dispose(); await rm(home, { recursive: true, force: true });
    }
  });
});
