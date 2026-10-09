import { posix, win32 } from 'node:path';
import * as z from 'zod/mini';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type {
  MachineProvisionerAcquireResultV1, MachineProvisionerBootstrapCarrierV1,
  MachineProvisionerObservationV1, MachineProvisionerPowerResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID } from './constants.js';
import { CrabboxLaunchV1Schema, CrabboxResourceV1Schema, CRABBOX_NATIVE_VERSION, type CrabboxLaunchV1, type CrabboxResourceV1 } from './schemas.js';
import { crabboxLeaseId, crabboxErrorCode } from './provider.js';

export const CRABBOX_DEPENDENCY_ID = 'crabbox-cli';
const contributionRef = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_PROVISIONER_ID };
const statusSchema = z.object({ id: z.string(), provider: z.string(), target: z.string(), state: z.string(), serverId: z.string(),
  sshHost: z.optional(z.string()), sshPort: z.optional(z.string()), sshUser: z.optional(z.string()),
  expiresAt: z.optional(z.string()), ready: z.boolean(), hasHost: z.boolean() });
type DirectResource = Extract<CrabboxResourceV1, { backendId: 'local-container' }>;
function failure(code: string) { return Object.assign(new Error('Crabbox native observation unavailable'), { code }); }
function reference(resource: CrabboxResourceV1) { return { contributionRef, schemaVersion: 1, value: resource }; }
function pending(resource: CrabboxResourceV1): MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1> {
  return { kind: 'pending', nativeOperationRef: reference(resource) };
}
function completed(result: PluginProcessResult) {
  return result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
    && result.termination.requestedBy.kind === 'none';
}

// Primary native contract: openclaw/crabbox b4673cca965cf9811ecd7c6b85ab481083e2b012
// (v0.71.0), cli/{run,lease,lease_ssh_root,repo,inspect}.go and
// providers/localcontainer/{fixed_lease,backend}.go. Warmup retains a fixed
// native intent without run's repository sync/hydration. Native claims remain
// the sole retry/delete authority; CD8 temporarily delivers only the host key.
export async function createCrabboxDirectProvider(context: PluginInvocationContext) {
  const dependency = await context.services.managedServices.dependencies.status(CRABBOX_DEPENDENCY_ID, { signal: context.signal });
  if ((dependency.state !== 'ready' && dependency.state !== 'updateAvailable') || !dependency.executable
    || dependency.version.replace(/^v/, '') !== CRABBOX_NATIVE_VERSION) throw failure('provider_unavailable');
  const executable = dependency.executable;

  async function withNative<T>(resource: DirectResource, effect: (run: (args: readonly string[]) => Promise<PluginProcessResult>) => Promise<T>) {
    const relativePath = `native/crabbox/testboxes/${resource.leaseId}/id_ed25519`;
    return context.services.machineProvisioners.withBootstrapCredentialFile({ relativePath }, async credential => {
      const paths = win32.isAbsolute(credential.path) && !posix.isAbsolute(credential.path) ? win32 : posix;
      const stateRoot = paths.dirname(paths.dirname(paths.dirname(paths.dirname(credential.path))));
      // Do not derive a second file tree from an unexpected host delivery.
      if (!paths.isAbsolute(credential.path) || credential.path !== paths.join(stateRoot, 'crabbox', 'testboxes', resource.leaseId, 'id_ed25519')) {
        throw failure('credential_unavailable');
      }
      // The public Exec owner replaces the environment. Native runtime/tool
      // discovery needs the OS executable search path (and Windows system
      // directory), not daemon Crabbox configuration or cloud credentials.
      const toolEnvironment = Object.fromEntries(['PATH', 'Path', 'SystemRoot'].flatMap(key => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      }));
      const env = { ...toolEnvironment, XDG_STATE_HOME: stateRoot, CRABBOX_CONFIG: paths.join(stateRoot, 'happier-isolated.yaml'),
        GIT_CEILING_DIRECTORIES: paths.dirname(stateRoot) };
      return effect(args => context.services.exec.run({ executable, args, cwd: stateRoot, env }, { signal: context.signal }));
    });
  }

  function identity(raw: CrabboxResourceV1): DirectResource {
    const resource = CrabboxResourceV1Schema.parse(raw);
    if (resource.transport !== 'direct' || resource.backendId !== 'local-container') throw failure('provider_unavailable');
    return resource;
  }
  function command(resource: DirectResource, verb: 'inspect' | 'stop') {
    return [verb, '--provider', resource.backendId, '--id', resource.leaseId,
      ...(resource.localContainerRuntime ? ['--local-container-runtime', resource.localContainerRuntime] : []),
      ...(verb === 'inspect' ? ['--json'] : [])];
  }
  async function observe(resource: DirectResource, run: (args: readonly string[]) => Promise<PluginProcessResult>) {
    const result = await run(command(resource, 'inspect'));
    if (!completed(result) || result.stdoutTruncated) throw failure('native_transport_unknown');
    const parsed = statusSchema.safeParse(JSON.parse(new TextDecoder().decode(result.stdout)) as unknown);
    if (!parsed.success) throw failure('native_observation_invalid');
    const status = parsed.data;
    if (status.id !== resource.leaseId || status.provider !== resource.backendId || status.target !== 'linux'
      || (resource.nativeInstanceId && resource.nativeInstanceId !== status.serverId)) throw failure('resource_mismatch');
    // Missing containers and pending native intents are not a physical binding.
    // Pinned localcontainer/backend.go isFullContainerID requires 64 hex
    // characters. DisplayID's preallocation "0" is not a physical binding.
    if (!/^[a-fA-F0-9]{64}$/.test(status.serverId) || ['missing', 'released'].includes(status.state)) throw failure('native_pending');
    return status;
  }

  return {
    async acquire(input: { launch: CrabboxLaunchV1; managedId?: string; bootstrapPublicKey?: string }): Promise<MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1>> {
      const parsed = CrabboxLaunchV1Schema.safeParse(input.launch);
      if (!parsed.success || !input.managedId?.trim() || !input.bootstrapPublicKey) return { kind: 'rejected', code: 'invalid_request' };
      const launch = parsed.data;
      if (launch.backendId !== 'local-container') return { kind: 'rejected', code: 'provider_unavailable' };
      const resource: DirectResource = { backendId: launch.backendId, transport: 'direct', namespace: launch.namespace,
        leaseId: crabboxLeaseId(input.managedId), ...(launch.localContainerRuntime ? { localContainerRuntime: launch.localContainerRuntime } : {}) };
      let submitted = false;
      try {
        return await withNative(resource, async run => {
          submitted = true;
          const result = await run(['warmup', '--provider', launch.backendId, '--target', launch.target, '--lease-id', resource.leaseId, '--keep',
            '--ttl', `${launch.ttlSeconds}s`, '--idle-timeout', `${launch.idleTimeoutSeconds}s`, '--local-container-image', launch.nativeImageId,
            ...(launch.localContainerRuntime ? ['--local-container-runtime', launch.localContainerRuntime] : []),
            ...(launch.localContainerCpus === undefined ? [] : ['--local-container-cpus', String(launch.localContainerCpus)]),
            ...(launch.localContainerMemory ? ['--local-container-memory', launch.localContainerMemory] : [])]);
          if (!completed(result)) return pending(resource);
          const status = await observe(resource, run);
          return { kind: 'bound', resource: reference({ ...resource, nativeInstanceId: status.serverId }) };
        });
      } catch { return submitted ? pending(resource) : { kind: 'rejected', code: 'credential_unavailable' }; }
    },
    async reconcile(raw: CrabboxResourceV1): Promise<MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1>> {
      const resource = identity(raw);
      try {
        return await withNative(resource, async run => {
          const status = await observe(resource, run);
          return { kind: 'bound', resource: reference({ ...resource, nativeInstanceId: status.serverId }) };
        });
      } catch (error) { return crabboxErrorCode(error) === 'resource_mismatch' ? { kind: 'rejected', code: 'resource_mismatch' } : pending(resource); }
    },
    async bootstrap(input: { resource: CrabboxResourceV1; credentialRef?: { kind: 'shared_resource'; resourceId: string } }): Promise<MachineProvisionerBootstrapCarrierV1> {
      const resource = identity(input.resource);
      if (!input.credentialRef) throw failure('credential_unavailable');
      const status = await withNative(resource, run => observe(resource, run));
      if (!status.ready || !status.hasHost || !status.sshHost || !status.sshUser || !status.sshPort || !/^\d+$/.test(status.sshPort)) throw failure('native_pending');
      const port = Number(status.sshPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('native_observation_invalid');
      return resolveMachineProvisionerSshBootstrap({ exec: context.services.exec,
        connection: { address: status.sshHost, port, user: status.sshUser }, credentialRef: input.credentialRef, signal: context.signal });
    },
    async inspect(raw: CrabboxResourceV1): Promise<MachineProvisionerObservationV1> {
      try {
        const resource = identity(raw);
        const status = await withNative(resource, run => observe(resource, run));
        const expiry = status.expiresAt ? Date.parse(status.expiresAt) : NaN;
        return { observedAt: context.invokedAtMs, availability: 'present', power: status.state === 'ready' ? 'running' : 'unknown',
          storage: 'unknown', billing: { location: 'local', stoppedBilling: 'unknown' },
          ...(Number.isFinite(expiry) ? { nativeExpiry: expiry } : {}) };
      } catch (error) { return { observedAt: context.invokedAtMs, availability: 'unavailable', reason: crabboxErrorCode(error) }; }
    },
    async destroy(raw: CrabboxResourceV1): Promise<MachineProvisionerPowerResultV1> {
      try {
        const resource = identity(raw);
        return await withNative(resource, async run => {
          await observe(resource, run);
          const stopped = await run(command(resource, 'stop'));
          // Native local-container ReleaseLease awaits exact docker/podman
          // rm -f, sidecar cleanup and the released native claim write.
          return completed(stopped) ? { kind: 'confirmed' } : { kind: 'unknown', code: 'native_transport_unknown' };
        });
      } catch (error) {
        const code = crabboxErrorCode(error);
        return { kind: code === 'resource_mismatch' ? 'refused' : 'unknown', code };
      }
    },
  };
}
