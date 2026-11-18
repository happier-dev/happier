import type { ExecService, PluginProcessResult } from '../exec.js';
import type { MachineProvisionerObservationV1 } from '../machine-provisioners/index.js';
import type { LimaExecutor } from '../machine-provisioners/lima/index.js';
import { createLimaProvider } from '../../../plugins/machine-lima/src/machine/provider.js';
import { createLumeProvider } from '../../../plugins/machine-lume/src/machine/provider.js';
import { createLumeNativeClient } from '../../../plugins/machine-lume/src/machine/nativeClient.js';
import { createDockerSandboxesProvider } from '../../../plugins/machine-docker-sandboxes/src/machine/provider.js';
import { createCloudClient } from '../../../plugins/machine-docker-sandboxes/src/cloud/nativeClient.js';
import { sandboxFixture } from '../../../plugins/machine-docker-sandboxes/src/cloud/fixtures.js';
import { DOCKER_ACCOUNT_SERVICE } from '../../../plugins/machine-docker-sandboxes/src/machine/dockerAccount.js';
import { createPluginHttpFixture } from '../testing/index.js';

export type BundledObservationCase = {
  plugin: string; provisioner: string; state: string;
  expected: Partial<MachineProvisionerObservationV1>;
  expectedErrorCode?: string;
  observe: () => Promise<MachineProvisionerObservationV1>;
};
const size = { cpuCores: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 20 * 1024 ** 3 };
const resource = { store: '/private/lima-test', instance: 'happier-lima-test', image: 'https://example.test/ubuntu.img',
  vmType: 'vz' as const, arch: 'aarch64' as const, cpus: 1, memoryBytes: 2 * 1024 ** 3, diskBytes: 10 * 1024 ** 3, mounts: [] };
const native = { name: resource.instance, dir: `${resource.store}/${resource.instance}`, status: 'Running',
  vmType: resource.vmType, arch: resource.arch, cpus: 2, memory: size.memoryBytes, disk: size.diskBytes,
  config: { images: [{ location: resource.image, arch: resource.arch }], mounts: [],
    ssh: { forwardAgent: false }, containerd: { user: false, system: false } } };
const processResult = (stdout: string, exitCode = 0): PluginProcessResult => ({
  termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
  stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
});

export const LOCAL_OBSERVATION_CASES: BundledObservationCase[] = [
  ...['running', 'stopped', 'creating', 'absent', 'failure', 'malformed'].map((state): BundledObservationCase => ({
    plugin: 'machine-docker-sandboxes', provisioner: 'docker-cloud', state,
    ...(state === 'malformed' ? { expectedErrorCode: 'docker_cloud_invalid_response' } : {}),
    expected: state === 'failure' || state === 'malformed' ? { availability: 'unavailable' }
      : state === 'absent' ? { availability: 'absent' }
      : { availability: 'present', storage: 'retained', power: state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : 'unknown',
        nativeExpiry: Date.parse('2026-11-15T18:00:00Z') },
    async observe() {
      const http = createPluginHttpFixture({ async request(request) {
        const token = request.url.startsWith('https://hub.docker.com/');
        const body = token ? { access_token: 'fixture-token' } : state === 'malformed' ? {}
          : { ...sandboxFixture, core: { ...sandboxFixture.core, status: state } };
        return { status: token ? 200 : state === 'absent' ? 404 : state === 'failure' ? 503 : 200,
          headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
      } });
      const unavailable = (): never => { throw new Error('Unexpected Connected Account operation'); };
      return createCloudClient({ signal: new AbortController().signal, invokedAtMs: 10,
        services: { http, connectedAccounts: {
          getBinding: async (purpose) => ({
            purpose, service: DOCKER_ACCOUNT_SERVICE,
            target: { kind: 'account', displayName: 'Docker fixture' },
            account: { service: DOCKER_ACCOUNT_SERVICE, accountId: 'fixture' },
          }),
          materialize: async () => ({ kind: 'environment', env: { DOCKER_ID: 'fixture-user', DOCKER_PAT: 'fixture-token' } }),
          requestSelection: unavailable,
          listAccounts: unavailable,
          materializeListedAccount: unavailable,
          watch: unavailable,
        } } }).inspect({ sandboxName: sandboxFixture.name });
    },
  })),
  ...['Running', 'Stopped', 'Starting', 'absent', 'failure', 'malformed'].map((state): BundledObservationCase => ({
    plugin: 'machine-lima', provisioner: 'lima', state,
    expected: state === 'failure' || state === 'malformed' ? { availability: 'unavailable' }
      : state === 'absent' ? { availability: 'absent' }
      : { availability: 'present', power: state === 'Running' ? 'running' : state === 'Stopped' ? 'stopped' : 'unknown', storage: 'retained', size },
    async observe() {
      const capture: LimaExecutor['capture'] = async () => ({ exitCode: state === 'failure' ? 1 : 0,
        out: state === 'malformed' ? '{' : state === 'absent' ? '' : JSON.stringify({ ...native, status: state }), err: '' });
      return createLimaProvider({ capture, run: capture }).inspect(resource);
    },
  })),
  ...['running', 'stopped', 'provisioning', 'provisioning-zero-dimensions', 'absent', 'failure', 'malformed'].map((state): BundledObservationCase => ({
    plugin: 'machine-lume', provisioner: 'lume', state,
    expected: state === 'failure' || state === 'malformed' ? { availability: 'unavailable' }
      : state === 'absent' ? { availability: 'absent', storage: 'lost' }
      : { availability: 'present', power: state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : 'unknown',
        storage: state === 'running' || state === 'stopped' ? 'retained' : 'unknown',
        size: state === 'provisioning-zero-dimensions' ? { cpuCores: size.cpuCores } : size },
    async observe() {
      const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', command: {
        executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } },
        exec: { async run() { throw new Error('Unexpected native mutation'); } },
      }, fetch: async () => {
        if (state === 'failure') return Response.json({}, { status: 503 });
        if (state === 'malformed') return new Response('{');
        if (state === 'absent') return Response.json({ message: 'Virtual machine not found: happier-test' }, { status: 400 });
        return Response.json({ name: 'happier-test', locationName: 'home', status: state === 'provisioning-zero-dimensions' ? 'provisioning' : state, os: 'macos',
          cpuCount: size.cpuCores, memorySize: state === 'provisioning-zero-dimensions' ? 0 : size.memoryBytes,
          diskSize: { total: state === 'provisioning-zero-dimensions' ? 0 : size.diskBytes, allocated: 0 } });
      } });
      return createLumeProvider({ native, observedAt: 10 }).inspect({ storage: 'home', vmName: 'happier-test' });
    },
  })),
  ...['running', 'stopped', 'starting', 'absent', 'failure', 'malformed'].map((state): BundledObservationCase => ({
    plugin: 'machine-docker-sandboxes', provisioner: 'docker-sandboxes', state,
    expected: state === 'failure' || state === 'malformed' ? { availability: 'unavailable' }
      : state === 'absent' ? { availability: 'absent', storage: 'lost' }
      : { availability: 'present', storage: 'retained', power: state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : 'unknown' },
    async observe() {
      const run: ExecService['run'] = async () => processResult(state === 'malformed' ? '{'
        : JSON.stringify({ sandboxes: state === 'absent' ? [] : [{ name: 'happier-test', status: state }] }), state === 'failure' ? 1 : 0);
      return createDockerSandboxesProvider({ run }, { kind: 'systemTool', id: 'sbx' }, 10).inspect({ sandboxName: 'happier-test' });
    },
  })),
];
