import type { ConnectedAccountReadContext, ConnectedAccountRuntime, ConnectedAccountsService } from '../connected-accounts/index.js';
import type { JsonValue, PluginInvocationContext } from '../index.js';
import { MachineProvisionerObservationV1Schema, type MachineProvisionerObservationV1 } from '../machine-provisioners/index.js';
import { createPluginHttpFixture, createPluginTestkit } from '../testing/index.js';
import { PLUGIN as flyPlugin } from '../../../plugins/machine-fly/src/manifest.js';
import { connectedAccountRuntime as flyAccount } from '../../../plugins/machine-fly/src/account.js';
import { PLUGIN as hetznerPlugin } from '../../../plugins/machine-hetzner/src/manifest.js';
import { connectedAccountRuntime as hetznerAccount } from '../../../plugins/machine-hetzner/src/account.js';
import { PLUGIN as digitaloceanPlugin } from '../../../plugins/machine-digitalocean/src/manifest.js';
import { connectedAccountRuntime as digitaloceanAccount } from '../../../plugins/machine-digitalocean/src/account.js';
import { createCoderClient } from '../../../plugins/machine-coder/src/machine/nativeClient.js';
import { createModalProvisionerRoles } from '../../../plugins/machine-modal/src/machine/roles.js';
import type { ModalNativeClient, ModalSandboxHandle } from '../../../plugins/machine-modal/src/machine/nativeClient.js';
import { createCrabboxProvider } from '../../../plugins/machine-crabbox/src/machine/provider.js';
import { createCrabboxDirectProvider } from '../../../plugins/machine-crabbox/src/machine/direct.js';

type ObservationCase = Readonly<{
  plugin: string; provisioner: string; state: string;
  expected: Partial<MachineProvisionerObservationV1>;
  observe: () => Promise<MachineProvisionerObservationV1>;
}>;
type Reply = Readonly<{ body?: unknown; status?: number; failure?: boolean }>;
const observedAt = 123;

// HTTP and credential storage are host boundaries; account materialization,
// activation, Action codecs, native decoders and observation projection are real.
async function inspectHttpPlugin(plugin: Parameters<typeof createPluginTestkit>[0]['module'] & { manifest: Parameters<typeof createPluginTestkit>[0]['manifest'] },
  account: ConnectedAccountRuntime, resource: JsonValue, replies: readonly Reply[]) {
  let index = 0;
  const http = createPluginHttpFixture({ async request() {
    const reply = replies[index++];
    if (!reply || reply.failure) throw new TypeError('Native transport unavailable');
    return { status: reply.status ?? 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(reply.body ?? {})) };
  } });
  const signal = new AbortController().signal;
  const accountContext = { configuration: { values: { organizationSlug: 'selected-org' } },
    credentials: { get: async () => 'fixture-token' }, signal, services: { http } } as unknown as ConnectedAccountReadContext;
  const materialize: ConnectedAccountsService['materialize'] = (_purpose, request, options) => account.materialize(request, accountContext, options);
  const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin,
    services: { http, connectedAccounts: { materialize } as ConnectedAccountsService } });
  return MachineProvisionerObservationV1Schema.parse(await kit.invokeAction('inspect', { resource }, { surface: 'plugin' }));
}

const flyResource = { app: { name: 'selected-app', ownership: 'existing' }, machineId: 'machine-1', volume: { id: 'vol-1', ownership: 'attached' } };
const flyMachine = (state: string) => ({ id: 'machine-1', instance_id: 'instance-1', state, region: 'ams',
  config: { guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 }, mounts: [{ volume: 'vol-1', path: '/persistent' }], services: [] } });
const flyPresent = (state: string): Reply[] => [{ body: flyMachine(state) }, { body: { id: 'vol-1', state: 'created', attached_machine_id: 'machine-1', size_gb: 10 } }];
const hetznerResource = { serverId: 42, owned: { volumeIds: [], primaryIpIds: [] } };
const hetznerServer = (status: string) => ({ id: 42, status, labels: {}, public_net: { ipv4: null, ipv6: null },
  server_type: { id: 1, name: 'cx-test', cores: 2, memory: 4, disk: 40 } });
const dropletResource = { dropletId: 42, ownedVolumeIds: [] };
const droplet = (status: string) => ({ id: 42, name: 'selected-droplet', status, tags: [], volume_ids: [], vcpus: 2, memory: 4096, disk: 80 });

const coderResource = { workspaceId: 'workspace-1', ownerId: 'owner-1', ownerName: 'owner', workspaceName: 'selected',
  organizationId: 'org-1', templateId: 'template-1', agentName: 'main', managedId: 'managed-1' };
function inspectCoder(reply: Reply) {
  const client = createCoderClient({ observedAt, signal: new AbortController().signal, waitForObservation: async () => {},
    request: async path => {
      if (path.endsWith('/users/me')) return Response.json({ id: 'owner-1', username: 'owner' });
      if (reply.failure) throw new TypeError('Native transport unavailable');
      return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
    } });
  return client.inspect(coderResource);
}
const workspace = (status: string) => ({ id: 'workspace-1', owner_id: 'owner-1', owner_name: 'owner', organization_id: 'org-1',
  template_id: 'template-1', name: 'selected', latest_build: { id: 'build-1', workspace_id: 'workspace-1',
    template_version_id: 'version-1', transition: status === 'stopped' ? 'stop' : 'start', status, job: { status: 'succeeded' }, resources: [] } });

// Modal's SDK returns opaque handles, with poll() as its native gRPC boundary.
// No reviewed launch dimensions or timeout are substituted for native facts.
function inspectModal(outcome: 'running' | 'ended' | 'absent' | 'failure' | 'mismatch') {
  const sandbox: ModalSandboxHandle = {
    sandboxId: outcome === 'mismatch' ? 'other-sandbox' : 'sandbox-1',
    async poll() {
      if (outcome === 'absent') throw { '@@nice-grpc:ClientError': true, code: 5 };
      if (outcome === 'failure') throw { '@@nice-grpc:ClientError': true, code: 14 };
      return outcome === 'ended' ? 0 : null;
    },
    async terminate() { throw new Error('Unexpected mutation'); },
    async exec() { throw new Error('Unexpected guest IO'); },
    filesystem: { async writeBytes() { throw new Error('Unexpected guest IO'); } },
  };
  const client: ModalNativeClient = {
    version: () => '0.11.0', apps: { async fromName() { throw new Error('Unexpected inventory'); } },
    images: { fromRegistry() { throw new Error('Unexpected image lookup'); } },
    sandboxes: { async fromId() { return sandbox; }, async create() { throw new Error('Unexpected allocation'); }, async *list() { throw new Error('Unexpected inventory'); } },
  };
  return createModalProvisionerRoles(client, observedAt).inspect({ resource: { appId: 'app-1', sandboxId: 'sandbox-1' } });
}

const crabboxResource = { backendId: 'aws' as const, namespace: 'test-org', transport: 'coordinator' as const, leaseId: 'cbx_abcdef123456' };
const lease = (state: string) => ({ id: crabboxResource.leaseId, provider: 'aws', org: 'test-org', state, cloudID: 'i-exact',
  expiresAt: '2026-11-16T12:00:00Z', idleTimeoutSeconds: 1800 });
function inspectCrabbox(reply: Reply) {
  return createCrabboxProvider({ observedAt, connection: { endpoint: 'https://coordinator.example.test', namespace: 'test-org', token: 'fixture-token' },
    http: async () => { if (reply.failure) throw new TypeError('Native transport unavailable'); return Response.json(reply.body ?? {}, { status: reply.status ?? 200 }); } }).inspect(crabboxResource);
}
async function inspectDirectCrabbox(state: string, malformed = false, failure = false) {
  const resource = { transport: 'direct' as const, backendId: 'local-container' as const, namespace: 'local', leaseId: 'cbx_abcdef123456', nativeInstanceId: 'a'.repeat(64) };
  // Process, dependency lookup and private credential-file delivery are host
  // boundaries. Native command response decoding and identity stay real.
  const context = { invokedAtMs: observedAt, signal: new AbortController().signal, services: {
    managedServices: { dependencies: { async status() { return { state: 'ready', executable: { kind: 'path', path: '/fixture/crabbox' } }; } } },
    machineProvisioners: { async withBootstrapCredentialFile(_input: unknown, effect: (value: { path: string }) => Promise<unknown>) {
      return effect({ path: `/tmp/fixture/native/crabbox/testboxes/${resource.leaseId}/id_ed25519` });
    } },
    exec: { async run() {
      if (failure) throw new TypeError('Native process unavailable');
      return { stdout: new TextEncoder().encode(JSON.stringify(malformed ? {} : { id: resource.leaseId, provider: 'local-container', target: 'linux',
        state, serverId: resource.nativeInstanceId, ready: state === 'running' || state === 'ready', hasHost: true })), stderr: new Uint8Array(),
        stdoutTruncated: false, stderrTruncated: false, termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } };
    } },
  } } as unknown as PluginInvocationContext;
  return (await createCrabboxDirectProvider(context)).inspect(resource);
}

export const NATIVE_OBSERVATION_CASES: readonly ObservationCase[] = [
  ...(['started', 'stopped', 'suspended', 'starting'] as const).map(state => ({ plugin: 'machine-fly', provisioner: 'fly', state,
    expected: { availability: 'present', power: state === 'started' ? 'running' : state === 'stopped' ? 'stopped' : state === 'suspended' ? 'suspended' : 'unknown', storage: 'retained',
      size: { cpuCores: 2, memoryBytes: 2048 * 1024 ** 2 } } satisfies Partial<MachineProvisionerObservationV1>,
    observe: () => inspectHttpPlugin(flyPlugin, flyAccount, flyResource, flyPresent(state)) })),
  { plugin: 'machine-fly', provisioner: 'fly', state: 'absent', expected: { availability: 'absent' }, observe: () => inspectHttpPlugin(flyPlugin, flyAccount, flyResource, [{ status: 404 }]) },
  { plugin: 'machine-fly', provisioner: 'fly', state: 'dimensions-not-supplied', expected: { availability: 'present', size: undefined },
    observe: () => inspectHttpPlugin(flyPlugin, flyAccount, flyResource, [{ body: { ...flyMachine('started'), config: { mounts: [{ volume: 'vol-1', path: '/persistent' }], services: [] } } }, flyPresent('started')[1]!]) },
  ...([{ state: 'read-failure', reply: { failure: true } }, { state: 'malformed', reply: { body: {} } }] as const).map(({ state, reply }) => ({ plugin: 'machine-fly', provisioner: 'fly', state,
    expected: { availability: 'unavailable' } as const, observe: () => inspectHttpPlugin(flyPlugin, flyAccount, flyResource, [reply]) })),
  ...(['running', 'off', 'starting', 'stopping'] as const).map(state => ({ plugin: 'machine-hetzner', provisioner: 'hetzner', state,
    expected: { availability: 'present', power: state === 'running' ? 'running' : state === 'off' ? 'stopped' : 'unknown', storage: 'retained',
      size: { cpuCores: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 40 * 1000 ** 3 } } satisfies Partial<MachineProvisionerObservationV1>,
    observe: () => inspectHttpPlugin(hetznerPlugin, hetznerAccount, hetznerResource, [{ body: { server: hetznerServer(state) } }]) })),
  { plugin: 'machine-hetzner', provisioner: 'hetzner', state: 'absent', expected: { availability: 'absent' }, observe: () => inspectHttpPlugin(hetznerPlugin, hetznerAccount, hetznerResource, [{ status: 404, body: { error: { code: 'not_found' } } }]) },
  { plugin: 'machine-hetzner', provisioner: 'hetzner', state: 'dimensions-not-supplied', expected: { availability: 'present', size: undefined },
    observe: () => inspectHttpPlugin(hetznerPlugin, hetznerAccount, hetznerResource, [{ body: { server: { id: 42, status: 'running', labels: {}, public_net: { ipv4: null, ipv6: null } } } }]) },
  ...([{ state: 'read-failure', reply: { failure: true } }, { state: 'malformed', reply: { body: {} } }] as const).map(({ state, reply }) => ({ plugin: 'machine-hetzner', provisioner: 'hetzner', state,
    expected: { availability: 'unavailable' } as const, observe: () => inspectHttpPlugin(hetznerPlugin, hetznerAccount, hetznerResource, [reply]) })),
  ...(['active', 'off', 'new'] as const).map(state => ({ plugin: 'machine-digitalocean', provisioner: 'digitalocean', state,
    expected: { availability: 'present', power: state === 'active' ? 'running' : state === 'off' ? 'stopped' : 'unknown', storage: 'retained',
      size: { cpuCores: 2, memoryBytes: 4096 * 1024 ** 2, diskBytes: 80 * 1000 ** 3 } } satisfies Partial<MachineProvisionerObservationV1>,
    observe: () => inspectHttpPlugin(digitaloceanPlugin, digitaloceanAccount, dropletResource, [{ body: { droplet: droplet(state) } }]) })),
  { plugin: 'machine-digitalocean', provisioner: 'digitalocean', state: 'absent', expected: { availability: 'absent' }, observe: () => inspectHttpPlugin(digitaloceanPlugin, digitaloceanAccount, dropletResource, [{ status: 404 }]) },
  { plugin: 'machine-digitalocean', provisioner: 'digitalocean', state: 'dimensions-not-supplied', expected: { availability: 'present', size: undefined },
    observe: () => inspectHttpPlugin(digitaloceanPlugin, digitaloceanAccount, dropletResource, [{ body: { droplet: { id: 42, name: 'selected-droplet', status: 'active', tags: [], volume_ids: [] } } }]) },
  ...([{ state: 'read-failure', reply: { failure: true } }, { state: 'malformed', reply: { body: {} } }] as const).map(({ state, reply }) => ({ plugin: 'machine-digitalocean', provisioner: 'digitalocean', state,
    expected: { availability: 'unavailable' } as const, observe: () => inspectHttpPlugin(digitaloceanPlugin, digitaloceanAccount, dropletResource, [reply]) })),
  ...(['running', 'stopped', 'starting', 'stopping'] as const).map(state => ({ plugin: 'machine-coder', provisioner: 'coder', state,
    expected: { availability: 'present', power: state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : 'unknown', storage: 'unknown' } satisfies Partial<MachineProvisionerObservationV1>,
    observe: () => inspectCoder({ body: workspace(state) }) })),
  { plugin: 'machine-coder', provisioner: 'coder', state: 'absent', expected: { availability: 'absent', storage: 'lost' }, observe: () => inspectCoder({ status: 404 }) },
  ...([{ state: 'read-failure', reply: { failure: true } }, { state: 'malformed', reply: { body: {} } }] as const).map(({ state, reply }) => ({ plugin: 'machine-coder', provisioner: 'coder', state,
    expected: { availability: 'unavailable' } as const, observe: () => inspectCoder(reply) })),
  ...(['running', 'ended', 'absent', 'failure', 'mismatch'] as const).map(state => ({ plugin: 'machine-modal', provisioner: 'modal', state,
    expected: state === 'running' ? { availability: 'present', power: 'running', storage: 'retained' } as const
      : state === 'ended' || state === 'absent' ? { availability: 'absent', storage: 'lost' } as const : { availability: 'unavailable' } as const,
    observe: () => inspectModal(state) })),
  ...(['active', 'provisioning'] as const).map(state => ({ plugin: 'machine-crabbox', provisioner: 'crabbox-coordinator', state,
    expected: { availability: 'present', power: 'unknown', storage: 'unknown', nativeExpiry: Date.parse('2026-11-16T12:00:00Z') } as const,
    observe: () => inspectCrabbox({ body: { lease: lease(state) } }) })),
  { plugin: 'machine-crabbox', provisioner: 'crabbox-coordinator', state: 'released-cleaned', expected: { availability: 'absent', storage: 'lost' },
    observe: () => inspectCrabbox({ body: { lease: { ...lease('released'), cleanupStatus: 'complete', cleanupCompletedAt: '2026-11-16T12:01:00Z', releaseDeletesServer: true } } }) },
  ...([{ state: 'missing-is-uncertain', reply: { status: 404 } }, { state: 'read-failure', reply: { failure: true } }, { state: 'malformed', reply: { body: {} } }] as const)
    .map(({ state, reply }) => ({ plugin: 'machine-crabbox', provisioner: 'crabbox-coordinator', state, expected: { availability: 'unavailable' } as const, observe: () => inspectCrabbox(reply) })),
  ...(['ready', 'running', 'starting'] as const).map(state => ({ plugin: 'machine-crabbox', provisioner: 'crabbox', state,
    expected: { availability: 'present', power: state === 'ready' || state === 'running' ? 'running' : 'unknown', storage: 'unknown' } satisfies Partial<MachineProvisionerObservationV1>,
    observe: () => inspectDirectCrabbox(state) })),
  { plugin: 'machine-crabbox', provisioner: 'crabbox', state: 'missing-is-uncertain', expected: { availability: 'unavailable' }, observe: () => inspectDirectCrabbox('missing') },
  { plugin: 'machine-crabbox', provisioner: 'crabbox', state: 'read-failure', expected: { availability: 'unavailable' }, observe: () => inspectDirectCrabbox('ready', false, true) },
  { plugin: 'machine-crabbox', provisioner: 'crabbox', state: 'malformed', expected: { availability: 'unavailable' }, observe: () => inspectDirectCrabbox('ready', true) },
];
