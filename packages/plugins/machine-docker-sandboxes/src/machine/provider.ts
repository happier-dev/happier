import { arch } from 'node:os';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { MachineProvisionerNativeIntentV1, MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { observeMachineProvisionerNativeRead, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createDockerSandboxesNativeClient } from './nativeClient.js';
import { createDockerSandboxesPreparation } from './preparation.js';
import { DockerSandboxesLaunchV1Schema, DockerSandboxesResourceV1Schema, DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS } from './schemas.js';
import type { DockerSandboxesLaunchV1, DockerSandboxesResourceV1 } from './schemas.js';

export const DOCKER_SANDBOXES_PLUGIN_ID = 'happier.machine.docker-sandboxes';
export const DOCKER_SANDBOXES_PROVISIONER_ID = 'docker-sandboxes';
export const DOCKER_SANDBOXES_DEPENDENCY_ID = 'docker-sandboxes-cli';
const contributionRef = { pluginId: DOCKER_SANDBOXES_PLUGIN_ID, localId: DOCKER_SANDBOXES_PROVISIONER_ID };
const billing = { location: 'local', stoppedBilling: 'not-billed' } as const;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function acquisitionResource(launch: DockerSandboxesLaunchV1, managedId: string) {
  return DockerSandboxesResourceV1Schema.safeParse({ sandboxName: `${launch.name}-${managedId}` });
}

export function createDockerSandboxesProvider(exec: Pick<ExecService, 'run'> & Partial<Pick<ExecService, 'spawn'>>, executable: ManagedExecutableRef,
  observedAt: number, signal?: AbortSignal) {
  const native = createDockerSandboxesNativeClient(exec, executable);
  const preparation = createDockerSandboxesPreparation(exec, executable, contributionRef, signal);
  const pending = (resource: DockerSandboxesResourceV1, nativeCause?: MachineProvisionerNativeCauseV1) => ({ kind: 'pending' as const,
    nativeOperationRef: { contributionRef, schemaVersion: 1, value: resource }, ...(nativeCause ? { nativeCause } : {}) });
  async function requirePresent(raw: DockerSandboxesResourceV1) {
    const resource = DockerSandboxesResourceV1Schema.parse(raw);
    const observation = await native.inspect(resource, signal);
    if (!('presence' in observation)) fail(observation.code);
    if (observation.presence !== 'present') fail(observation.presence === 'absent'
      ? 'docker_sandbox_absent' : 'docker_sandbox_presence_unknown');
    return resource;
  }
  return {
    buildPreparation: preparation.build,
    inspectPreparation: preparation.inspect,
    destroyPreparation: preparation.destroy,
    async stream(resource: DockerSandboxesResourceV1, argv: readonly string[]) {
      return native.stream(resource, argv, signal);
    },
    async check() {
      const probe = await native.probe(signal);
      if (probe.status !== 'available') return { available: false, code: 'docker_sandbox_unavailable' };
      const catalog = await native.templates(signal);
      return catalog.status === 'available' ? { available: true } : { available: false, code: 'docker_sandbox_options_unavailable' };
    },
    async options() {
      const catalog = await native.templates(signal);
      if (catalog.status !== 'available') fail('docker_sandbox_options_unavailable');
      // Local sbx uses the host runtime's CPU platform, including on macOS and
      // Windows; every local guest is Linux. No guest allocation is discovery.
      // https://docs.docker.com/ai/sandboxes/cloud/local-vs-cloud/
      const hostArch = arch();
      const preparationGuest = hostArch === 'x64' || hostArch === 'arm64'
        ? { target: { os: 'linux', arch: hostArch }, remoteHomeDir: '/home/agent' } as const : undefined;
      return { base: { launch: { name: 'happier' }, guestPlatform: 'linux' as const,
        ...(preparationGuest ? { nativeFacts: { preparationGuest } } : {}) }, dimensions: { size: [], location: [], network: [], duration: [],
        image: catalog.templateIds.map(templateId => ({ id: templateId, title: templateId, guestPlatform: 'linux' as const,
          assignments: [{ path: 'templateId', value: templateId }], nativeFacts: { image: { id: templateId, title: templateId } } })) } };
    },
    async acquire(raw: DockerSandboxesLaunchV1, managedId?: string) {
      const launch = DockerSandboxesLaunchV1Schema.safeParse(raw);
      // The host's durable id is a naming tag only; private admitted-row custody
      // remains the authority. Missing tags cannot allocate a disposable name.
      const selected = managedId === undefined || !launch.success ? undefined : acquisitionResource(launch.data, managedId);
      if (!launch.success || !selected?.success || signal?.aborted) return { kind: 'rejected' as const, code: 'invalid_request' as const };
      const resource = selected.data;
      const templates = await native.templates(signal);
      if (templates.status !== 'available') return { kind: 'rejected' as const, code: 'provider_unavailable' as const };
      if (!templates.templateIds.includes(launch.data.templateId)) return { kind: 'rejected' as const, code: 'provider_unavailable' as const,
        nativeCause: { localCause: 'native_options_changed' as const } };
      const acquired = await native.create({ ...launch.data, name: resource.sandboxName }, signal);
      if (acquired.status !== 'allocated') {
        return acquired.status === 'refused' ? { kind: 'rejected' as const, code: 'invalid_request' as const }
          : pending(resource, acquired.nativeCause);
      }
      // Detached mode is native sbx state, not a host keeper. A mere create or
      // foreground process exit does not establish retained guest lifetime.
      const started = await native.start(resource, signal);
      if (started.status !== 'start-accepted') return pending(resource, 'nativeCause' in started ? started.nativeCause : undefined);
      if (await native.power(resource, signal) !== 'running') return pending(resource);
      return { kind: 'bound' as const, resource: { origin: 'created' as const, contributionRef, schemaVersion: 1, value: resource } };
    },
    async reconcile(input: unknown) {
      const parsed = DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.input.parse(input);
      const selected = 'nativeOperation' in parsed ? { success: true as const, data: parsed.nativeOperation }
        : acquisitionResource(parsed.correlation.launch, parsed.correlation.managedId);
      if (!selected.success) return { kind: 'unknown' as const, recovery: {
        reference: 'correlation' in parsed ? parsed.correlation.managedId : 'docker-sandbox', reason: 'invalid_request',
      } };
      const resource = selected.data;
      const observed = await native.inspect(resource, signal);
      if ('presence' in observed && observed.presence === 'absent') return { kind: 'rejected' as const, code: 'managed_not_found' as const };
      return 'presence' in observed && observed.presence === 'present'
        ? { kind: 'bound' as const, resource: { origin: 'created' as const, contributionRef, schemaVersion: 1, value: resource } }
        : pending(resource);
    },
    async bootstrap(resource: DockerSandboxesResourceV1) {
      DockerSandboxesResourceV1Schema.parse(resource);
      return { kind: 'native' as const, transport: { contributionRef, schemaVersion: 1 } };
    },
    async inspect(resource: DockerSandboxesResourceV1) {
      const observation = await native.inspect(resource, signal);
      if (!('presence' in observation) || observation.presence === 'unknown') {
        return observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: 'docker_sandbox_presence_unknown', billing });
      }
      // One complete native inventory supplies presence and power together.
      return observeMachineProvisionerNativeRead(observedAt, { kind: observation.presence, billing,
        power: observation.presence === 'present' ? observation.power : 'unknown' as const,
        storage: observation.presence === 'present' ? 'retained' as const : 'lost' as const });
    },
    async power(resource: DockerSandboxesResourceV1, intent: MachineProvisionerNativeIntentV1) {
      if (intent !== 'start' && intent !== 'stop') return { kind: 'refused' as const, code: 'docker_sandbox_intent_unsupported' };
      // Start checks presence at the native owner before its create-capable run.
      try { if (intent === 'stop') await requirePresent(resource); }
      catch (error) {
        return projectMachineProvisionerActionFailure(error, () => ({
          kind: 'refused' as const,
          code: error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'invalid_request',
        }));
      }
      const outcome = intent === 'start' ? await native.start(resource, signal) : await native.stop(resource, signal);
      if (outcome.status === 'refused') return { kind: 'refused' as const, code: outcome.code };
      const observed = await native.power(resource, signal);
      return { kind: observed === (intent === 'start' ? 'running' : 'stopped') ? 'confirmed' as const : 'unknown' as const };
    },
    async destroy(input: unknown) {
      const parsed = DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.destroyInput.parse(input);
      const resource = 'resource' in parsed ? parsed.resource : parsed.nativeOperation;
      const outcome = await native.delete(resource, signal);
      if (outcome.status === 'refused') return { kind: 'refused' as const, code: outcome.code };
      const observed = await native.inspect(resource, signal);
      return { kind: 'presence' in observed && observed.presence === 'absent' ? 'confirmed' as const : 'unknown' as const };
    },
    async exec(resource: DockerSandboxesResourceV1, argv: readonly string[], input?: Uint8Array) {
      return native.exec(resource, argv, signal, input);
    },
    async putFile(resource: DockerSandboxesResourceV1, guestPath: string, bytes: Uint8Array, mode = 0o600) {
      if (!guestPath.startsWith('/') || /[\0\r\n]/u.test(guestPath) || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
        return { kind: 'refused' as const, code: 'invalid_request' };
      }
      try {
        const result = await native.exec(resource, ['sh', '-c',
          'umask 077; cat > "$1" && chmod "$2" "$1"', 'happier-put-file', guestPath, mode.toString(8)], signal, bytes);
        return { kind: result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
          && result.termination.requestedBy.kind === 'none' ? 'confirmed' as const : 'unknown' as const };
      } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const })); }
    },
  };
}
