import type { ExecService, PluginProcessResult } from '../exec.js';
import type { BundledObservationCase } from './bundledObservationsLocal.js';
import { createCuaNativeClient } from '../../../plugins/machine-cua/src/machine/nativeClient.js';
import { createCuaLocalProvisioner } from '../../../plugins/machine-cua/src/machine/localProvisioner.js';
import { createCuaByoc } from '../../../plugins/machine-cua/src/machine/byoc.js';
import { createDevcontainerProvider } from '../../../plugins/devcontainer/src/machine/provider.js';
import type { DevcontainerResource } from '../../../plugins/devcontainer/src/machine/schemas.js';

const observedAt = 10;
function processResult(value: unknown, exitCode = 0): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
    stdout: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)),
    stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
const image = 'ghcr.io/trycua/linux:24.04-disk';

// Native basis: trycua/cua@2bce4442, also recorded beside the real producer.
// sandbox info has no observed CPU/memory/disk or guest-enrollment witness.
const localCases = (['local-sandbox', 'local-space'] as const).flatMap(provisioner =>
  ['running', 'stopped', 'suspended', 'missing', 'not-found', 'failure', 'malformed', 'missing-state', 'truncated',
    ...(provisioner === 'local-space' ? ['orphan-registration'] : [])].map((state): BundledObservationCase => ({
    plugin: 'machine-cua', provisioner, state,
    expected: state === 'missing' || state === 'not-found' ? { availability: 'absent', size: undefined }
      : ['running', 'stopped', 'suspended'].includes(state)
        ? { availability: 'present', power: state as 'running' | 'stopped' | 'suspended', storage: 'retained', size: undefined }
        : { availability: 'unavailable' },
    async observe() {
      const sandboxId = 'local:owned';
      const run: ExecService['run'] = async request => {
        const args = request.args ?? [];
        if (args.includes('spaces') && args.includes('ls')) return processResult({ spaces:
          state === 'orphan-registration' || !['missing', 'not-found'].includes(state)
            ? [{ id: sandboxId, provider: 'local', image }] : [] });
        if (!args.includes('sandbox') || !args.includes('info')) throw new Error('Unexpected Cua observation command');
        if (state === 'failure') throw new Error('Native process unavailable');
        if (state === 'malformed') return processResult('{');
        if (state === 'not-found') return processResult('', 3);
        const value = { id: sandboxId, name: 'owned', location: 'local', runtime: 'qemu', kind: 'vm', image,
          status: state === 'missing' || state === 'orphan-registration' ? 'missing' : 'ready',
          ...(state === 'missing-state' ? {} : { state: state === 'orphan-registration' ? 'missing' : state }), ephemeral: false };
        return { ...processResult(value), stdoutTruncated: state === 'truncated' };
      };
      const resource = provisioner === 'local-space'
        ? { kind: 'space', runtimeId: 'qemu', spaceId: sandboxId, sandboxId }
        : { kind: 'sandbox', namespace: 'local', runtimeId: 'qemu', sandboxId };
      return createCuaLocalProvisioner(createCuaNativeClient({ exec: { run },
        executable: { kind: 'systemTool', id: 'cua' } }), provisioner, observedAt).inspect(resource);
    },
  })));

const byocCases = (['aws', 'gcp', 'modal'] as const).flatMap(cloud =>
  ['running', 'suspended', 'gone', 'failure', 'malformed', 'missing-ledger', 'missing-state', 'expires'].map((state): BundledObservationCase => ({
    plugin: 'machine-cua', provisioner: 'byoc', state: `${cloud}-${state}`,
    expected: ['failure', 'malformed', 'missing-ledger', 'missing-state'].includes(state) ? { availability: 'unavailable' }
      : state === 'gone' ? { availability: 'absent' }
        : { availability: 'present', power: state === 'suspended' ? cloud === 'modal' ? 'unknown' : 'stopped' : 'running',
          storage: 'retained', size: undefined,
          billing: { location: 'cloud', stoppedBilling: cloud === 'modal' ? 'unknown' : 'not-billed' },
          nativeExpiry: state === 'expires' ? Date.parse('2026-11-20T12:00:00Z') : undefined },
    async observe() {
      const sandboxId = `${cloud}:owned`;
      const nativeResourceId = `${cloud}-owned`;
      const run: ExecService['run'] = async request => {
        const args = request.args ?? [];
        if (state === 'failure') throw new Error('Native process unavailable');
        if (state === 'malformed') return processResult('{');
        if (args.includes('cloud') && args.includes('status')) return processResult({ providers: [], resources:
          state === 'missing-ledger' ? [] : [{ provider: cloud, id: nativeResourceId, type: cloud === 'modal' ? 'sandbox' : 'instance',
            sandbox: sandboxId, machine: '', region: 'test-region', state: 'running', expires: '', expired: false }] });
        if (!args.includes('sandbox') || !args.includes('info')) throw new Error('Unexpected Cua BYOC observation command');
        return processResult({ id: sandboxId, name: 'owned', location: cloud, image: 'linux', status: 'ready', ephemeral: false,
          ...(state === 'missing-state' ? {} : { state: state === 'expires' ? 'running' : state }),
          expires_at: state === 'expires' ? '2026-11-20T12:00:00Z' : null,
          provider_details: { provider: cloud, id: nativeResourceId } });
      };
      return createCuaByoc(createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' } }))
        .observe({ cloud, nativeResourceId, sandboxId, ownedAttachmentIds: [] }, observedAt);
    },
  })));

const containerId = 'a'.repeat(64);
const containerResource: DevcontainerResource = { configuration: { kind: 'image', image: 'example:latest' },
  reviewedEffectDigest: '0'.repeat(64), managedMachineId: 'managed-test', containerId, user: 'coder', workspaceRoot: '/workspace',
  storage: { kind: 'child', childPath: '/workspace' }, volumes: [{ name: 'workspace-data', childPath: '/workspace' }] };
const containerCases = (['docker', 'podman'] as const).flatMap(runtime =>
  ['running', 'stopped', 'suspended', 'absent', 'failure', 'malformed', 'missing-state', 'truncated', 'unlimited'].map((state): BundledObservationCase => ({
    plugin: 'devcontainer', provisioner: 'devcontainer', state: `${runtime}-${state}`,
    expected: ['failure', 'malformed', 'missing-state', 'truncated'].includes(state) ? { availability: 'unavailable' }
      : state === 'absent' ? { availability: 'absent' }
        : { availability: 'present', power: state === 'unlimited' ? 'running' : state as 'running' | 'stopped' | 'suspended', storage: 'retained',
          size: state === 'unlimited' ? undefined : { cpuCores: 2, memoryBytes: 4 * 1024 ** 3 } },
    async observe() {
      const resource = { ...containerResource, runtime };
      const exec: Pick<ExecService, 'run' | 'spawn'> = {
        spawn: async () => { throw new Error('Observation must not spawn a guest process'); },
        run: async request => {
          const args = request.args ?? [];
          if (state === 'failure') throw new Error('Native process unavailable');
          if (args[0] === 'ps' && state === 'absent') return processResult('');
          if (args[0] !== 'inspect') throw new Error('Unexpected container observation command');
          if (state === 'absent') return processResult('', 1);
          if (state === 'malformed') return processResult('{');
          const unlimited = state === 'unlimited';
          return { ...processResult([{ Id: containerId,
            Config: { Labels: { 'happier.managed-machine': resource.managedMachineId, 'happier.image-review': resource.reviewedEffectDigest } },
            HostConfig: { ...(runtime === 'docker' ? { NanoCpus: unlimited ? 0 : 2e9 }
              : { CpuQuota: unlimited ? 0 : 200000, CpuPeriod: 100000 }), Memory: unlimited ? 0 : 4 * 1024 ** 3 },
            State: state === 'missing-state' ? {} : { Running: state !== 'stopped', Paused: state === 'suspended' },
            Mounts: [{ Type: 'volume', Name: 'workspace-data', Destination: '/workspace' }],
          }]), stdoutTruncated: state === 'truncated' };
        },
      };
      return createDevcontainerProvider({ exec, docker: { kind: 'managedDependency',
        id: { pluginId: 'happier.devcontainer', localId: runtime } },
        signal: new AbortController().signal, observedAt, environment: {} }).inspect(resource);
    },
  })));

export const CUA_DEVCONTAINER_OBSERVATION_CASES: BundledObservationCase[] = [...localCases, ...byocCases, ...containerCases];
