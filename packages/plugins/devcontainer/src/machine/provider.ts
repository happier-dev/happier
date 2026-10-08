import { isDeepStrictEqual } from 'node:util';
import { posix, win32 } from 'node:path';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { DevcontainerLaunchSchema, DevcontainerResourceSchema, DevcontainerNativeOperationSchema } from './schemas.js';
import type { DevcontainerLaunch, DevcontainerResource, DevcontainerNativeOperation } from './schemas.js';
import { assertDevcontainerEffectReview, devcontainerComposeProjectName, readDevcontainerNativeEnvironment } from './effectReview.js';

export const DEVCONTAINER_PLUGIN_ID = 'happier.devcontainer';
export const DEVCONTAINER_PROVISIONER_ID = 'devcontainer';
const contributionRef = { pluginId: DEVCONTAINER_PLUGIN_ID, localId: DEVCONTAINER_PROVISIONER_ID };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function code(error: unknown) { return typeof record(error).code === 'string' ? String(record(error).code) : 'provider_unavailable'; }
function completed(result: PluginProcessResult) {
  return result.termination.requestedBy.kind === 'none' && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
}
function output(result: PluginProcessResult) {
  if (!completed(result) || result.stdoutTruncated) fail('native_observation_unavailable');
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}
function json(result: PluginProcessResult): unknown { return JSON.parse(output(result)); }
function flags(launch: DevcontainerLaunch) { return ['--workspace-folder', launch.workspaceFolder, '--config', launch.configPath]; }
function managedFlags(launch: DevcontainerLaunch, managedMachineId: string) {
  return [...flags(launch), '--id-label', `devcontainer.local_folder=${launch.workspaceFolder}`,
    '--id-label', `devcontainer.config_file=${launch.configPath}`, '--id-label', `happier.managed-machine=${managedMachineId}`];
}
function quote(value: string) { return `'${value.replace(/'/gu, `'"'"'`)}'`; }

/** Docker effects exist only behind this provisioner's admitted native roles.
 * Enrollment, credentials, revision and Session custody remain host-owned. */
export function createDevcontainerProvider(input: Readonly<{
  exec: Pick<ExecService, 'run'>; docker: ManagedExecutableRef; devcontainer: ManagedExecutableRef;
  signal: AbortSignal; observedAt: number; environment?: Readonly<Record<string, string>>;
}>) {
  const environment = input.environment ?? readDevcontainerNativeEnvironment();
  const nativeInput = { ...input, environment };
  const run = (executable: ManagedExecutableRef, args: readonly string[], stdin?: Uint8Array, live = false, managedMachineId?: string, workspaceFolder?: string) =>
    input.exec.run({ executable, args, ...(stdin === undefined ? {} : { stdin }), ...(workspaceFolder ? { cwd: workspaceFolder } : {}),
      env: { ...environment, ...(managedMachineId ? { COMPOSE_PROJECT_NAME: devcontainerComposeProjectName(managedMachineId) } : {}) } },
      { signal: input.signal, ...(live ? { outputDelivery: 'invocation' as const } : {}) });
  async function inspectContainer(containerId: string, launch: DevcontainerLaunch, managedMachineId: string) {
    const inspected = await run(input.docker, ['inspect', '--type', 'container', containerId], undefined, false, managedMachineId, launch.workspaceFolder);
    if (!completed(inspected)) {
      // Inspect failure alone is not absence. A successful complete exact-id
      // inventory is the native witness; transport errors remain unavailable.
      const ids = output(await run(input.docker, ['ps', '--all', '--no-trunc', '--filter', `id=${containerId}`, '--format', '{{.ID}}'], undefined, false, managedMachineId, launch.workspaceFolder))
        .trim().split(/\r?\n/u).filter(Boolean);
      if (ids.length === 0) return null;
      fail('native_observation_unavailable');
    }
    const values = json(inspected);
    if (!Array.isArray(values) || values.length !== 1) fail('native_observation_unavailable');
    const native = record(values[0]);
    if (native.Id !== containerId) fail('resource_mismatch');
    return native;
  }
  function storage(native: Record<string, unknown>, workspaceRoot: string) {
    if (!Array.isArray(native.Mounts)) fail('native_observation_unavailable');
    const mounts = native.Mounts.map(record);
    const candidates = mounts.filter(mount => typeof mount.Destination === 'string'
      && (workspaceRoot === mount.Destination || workspaceRoot.startsWith(`${mount.Destination.replace(/\/+$/u, '')}/`)))
      .sort((a, b) => String(b.Destination).length - String(a.Destination).length);
    const mount = candidates[0];
    if (mount && candidates[1]?.Destination === mount.Destination) fail('resource_mismatch');
    const relative = mount ? posix.relative(String(mount.Destination), workspaceRoot) : '';
    const source = mount?.Source;
    if (mount?.Type === 'bind' && (typeof source !== 'string' || (!posix.isAbsolute(source) && !win32.isAbsolute(source)))) {
      fail('native_observation_unavailable');
    }
    if (mount && !['bind', 'volume', 'tmpfs'].includes(String(mount.Type))) fail('native_observation_unavailable');
    return {
      storage: mount?.Type === 'bind' && typeof source === 'string'
        ? { kind: 'bind' as const, hostPath: (win32.isAbsolute(source) && !posix.isAbsolute(source) ? win32 : posix).join(source, relative), childPath: workspaceRoot }
        : { kind: 'child' as const, childPath: workspaceRoot },
      volumes: mounts.filter(mount => mount.Type === 'volume').map(mount => ({ name: mount.Name, childPath: mount.Destination })),
    };
  }
  function assertLabels(native: Record<string, unknown>, launch: DevcontainerLaunch, managedMachineId: string) {
    const labels = record(record(native.Config).Labels);
    if (labels['devcontainer.local_folder'] !== launch.workspaceFolder || labels['devcontainer.config_file'] !== launch.configPath
      || labels['happier.managed-machine'] !== managedMachineId) fail('resource_mismatch');
  }
  async function namespace(launch: DevcontainerLaunch, containerId: string, managedMachineId: string) {
    // The CLI applies its remoteUser, remoteEnv and userEnvProbe. This is private
    // bootstrap IO; regular child commands use the enrolled Machine transport.
    const observed = output(await run(input.devcontainer, ['exec', ...flags(launch), '--container-id', containerId,
      'sh', '-c', 'id -un; pwd -P'], undefined, false, managedMachineId, launch.workspaceFolder));
    const boundary = observed.indexOf('\n');
    if (boundary <= 0 || !observed.endsWith('\n')) fail('child_namespace_unavailable');
    // POSIX paths may contain CR/LF. Only id's first LF and pwd's final LF
    // delimit the two values; all intervening path bytes are significant.
    return { user: observed.slice(0, boundary), workspaceRoot: observed.slice(boundary + 1, -1) };
  }
  async function exact(raw: DevcontainerResource, running = false) {
    const resource = DevcontainerResourceSchema.parse(raw);
    const native = await inspectContainer(resource.containerId, resource, resource.managedMachineId);
    if (!native) fail('native_resource_absent');
    assertLabels(native, resource, resource.managedMachineId);
    // Compare observations through the same declared writer as the retained
    // value; neutral schema objects need not have ordinary object prototypes.
    const actualStorage = DevcontainerResourceSchema.parse({ ...resource, ...storage(native, resource.workspaceRoot) });
    if (!isDeepStrictEqual(actualStorage.storage, resource.storage) || !isDeepStrictEqual(actualStorage.volumes, resource.volumes)) fail('resource_mismatch');
    const state = record(native.State);
    if (typeof state.Running !== 'boolean' || typeof state.Paused !== 'boolean') fail('native_observation_unavailable');
    if (running) {
      if (!state.Running || state.Paused) fail('child_unavailable');
      if (!isDeepStrictEqual(await namespace(resource, resource.containerId, resource.managedMachineId), { user: resource.user, workspaceRoot: resource.workspaceRoot })) fail('resource_mismatch');
    }
    return { resource, running: state.Running && !state.Paused, paused: state.Paused };
  }
  async function observe(launch: DevcontainerLaunch, containerId: string, managedMachineId: string) {
    const native = await inspectContainer(containerId, launch, managedMachineId);
    if (!native || record(native.State).Running !== true || record(native.State).Paused !== false) fail('native_realization_unknown');
    assertLabels(native, launch, managedMachineId);
    const observed = await namespace(launch, containerId, managedMachineId);
    const resource = DevcontainerResourceSchema.parse({ ...launch, managedMachineId, containerId, ...observed, ...storage(native, observed.workspaceRoot) });
    return { kind: 'bound' as const, resource: { contributionRef, schemaVersion: 1, value: resource,
      devcontainerObservation: { nativeResourceId: resource.containerId, user: resource.user,
        workspaceFolder: resource.workspaceRoot, storage: resource.storage },
    } };
  }
  async function inventory(launch: DevcontainerLaunch, managedMachineId: string) {
    return output(await run(input.docker, ['ps', '--all', '--no-trunc',
      '--filter', `label=devcontainer.local_folder=${launch.workspaceFolder}`,
      '--filter', `label=devcontainer.config_file=${launch.configPath}`,
      '--filter', `label=happier.managed-machine=${managedMachineId}`, '--format', '{{.ID}}'], undefined, false, managedMachineId, launch.workspaceFolder))
      .trim().split(/\r?\n/u).filter(Boolean);
  }
  async function realize(launch: DevcontainerLaunch, managedMachineId: string, recoveryReference = launch.configPath) {
    try {
      // Only admitted acquire/rebuild roles reach evaluation of host and child
      // hooks. Discovery and retained-resource inspection never evaluate them.
      const up = record(json(await run(input.devcontainer, ['up', ...managedFlags(launch, managedMachineId)], undefined, false, managedMachineId, launch.workspaceFolder)));
      if (typeof up.containerId === 'string' && /^[a-f0-9]{64}$/u.test(up.containerId)) recoveryReference = up.containerId;
      if (up.outcome !== 'success' || typeof up.containerId !== 'string' || !/^[a-f0-9]{64}$/u.test(up.containerId)
        || typeof up.remoteUser !== 'string' || typeof up.remoteWorkspaceFolder !== 'string') fail('native_realization_unknown');
      return await observe(launch, up.containerId, managedMachineId);
    } catch (error) { return { kind: 'unknown' as const, recovery: { reference: recoveryReference, reason: code(error) } }; }
  }
  return {
    async check() {
      try {
        const version = output(await run(input.devcontainer, ['--version'])).trim();
        output(await run(input.docker, ['version', '--format', '{{.Server.Version}}']));
        return /^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(version) ? { available: true } : { available: false, code: 'devcontainer_version_unavailable' };
      } catch (error) { return { available: false, code: code(error) }; }
    },
    async acquire(rawLaunch: DevcontainerLaunch, managedMachineId: string) {
      if (!managedMachineId) return { kind: 'rejected' as const, code: 'invalid_request' as const };
      const launch = DevcontainerLaunchSchema.parse(rawLaunch);
      try {
        await assertDevcontainerEffectReview(nativeInput, launch, launch.reviewedEffectDigest);
      } catch (error) {
        return { kind: 'rejected' as const, code: code(error) === 'request_conflict' ? 'request_conflict' as const
          : code(error) === 'invalid_request' ? 'invalid_request' as const : 'provider_unavailable' as const };
      }
      const result = await realize(launch, managedMachineId);
      return result.kind === 'bound' ? result : { kind: 'pending' as const, nativeOperationRef: {
        contributionRef, schemaVersion: 1, value: { managedMachineId, launch,
          ...(/^[a-f0-9]{64}$/u.test(result.recovery.reference) ? { nativeResourceId: result.recovery.reference } : {}) },
      } };
    },
    async reconcile(raw: DevcontainerNativeOperation) {
      const operation = DevcontainerNativeOperationSchema.parse(raw);
      const launch = 'launch' in operation ? operation.launch : operation;
      try {
        const matching = await inventory(launch, operation.managedMachineId);
        if (matching.length !== 1 || ('containerId' in operation && matching[0] === operation.containerId)
          || ('launch' in operation && operation.nativeResourceId !== undefined && matching[0] !== operation.nativeResourceId)
          || !/^[a-f0-9]{64}$/u.test(matching[0]!)) fail('native_realization_unknown');
        return await observe(launch, matching[0]!, operation.managedMachineId);
      } catch (error) {
        return 'containerId' in operation
          ? { kind: 'unknown' as const, recovery: { reference: operation.containerId, reason: code(error) } }
          : { kind: 'pending' as const, nativeOperationRef: { contributionRef, schemaVersion: 1, value: operation } };
      }
    },
    async rebuild(raw: DevcontainerResource, reviewedEffectDigest: string) {
      let issued = false;
      try {
        const { resource } = await exact(raw);
        const matching = await inventory(resource, resource.managedMachineId);
        if (matching.length !== 1 || matching[0] !== resource.containerId) fail('resource_mismatch');
        await assertDevcontainerEffectReview(nativeInput, resource, reviewedEffectDigest);
        const replacementLaunch = DevcontainerLaunchSchema.parse({ workspaceFolder: resource.workspaceFolder,
          configPath: resource.configPath, reviewedEffectDigest });
        issued = true;
        // The CLI's remove-existing flag selects by labels (or Compose
        // project/service), so deletion uses the retained exact Docker id.
        // No --volumes: bind sources and external volumes retain their owners.
        if (!completed(await run(input.docker, ['rm', '--force', resource.containerId], undefined, false, resource.managedMachineId, resource.workspaceFolder))) {
          return { kind: 'unknown' as const, recovery: { reference: resource.containerId, reason: 'native_rebuild_unknown' } };
        }
        return await realize(replacementLaunch, resource.managedMachineId, resource.containerId);
      } catch (error) {
        if (!issued) return { kind: 'refused' as const, code: code(error) };
        return { kind: 'unknown' as const, recovery: { reference: raw.containerId, reason: code(error) } };
      }
    },
    async bootstrap(resource: DevcontainerResource) {
      await exact(resource, true);
      return { kind: 'native' as const, transport: { contributionRef, schemaVersion: 1 } };
    },
    async inspect(raw: DevcontainerResource) {
      try {
        const { running, paused } = await exact(raw);
        return { observedAt: input.observedAt, availability: 'present' as const, power: paused ? 'suspended' as const : running ? 'running' as const : 'stopped' as const,
          billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const } };
      } catch (error) { return { observedAt: input.observedAt, availability: code(error) === 'native_resource_absent' ? 'absent' as const : 'unavailable' as const,
        reason: code(error) }; }
    },
    async power(raw: DevcontainerResource, intent: 'start' | 'stop') {
      let issued = false;
      try {
        const { resource } = await exact(raw);
        if (intent === 'start') await assertDevcontainerEffectReview(nativeInput, resource, resource.reviewedEffectDigest);
        issued = true;
        const result = intent === 'stop'
          ? await run(input.docker, ['stop', resource.containerId], undefined, false, resource.managedMachineId, resource.workspaceFolder)
          : await run(input.devcontainer, ['up', ...managedFlags(resource, resource.managedMachineId), '--expect-existing-container'], undefined, false, resource.managedMachineId, resource.workspaceFolder);
        if (!completed(result)) return { kind: 'unknown' as const, code: 'native_power_unknown' };
        if (intent === 'start') {
          const started = record(json(result));
          if (started.outcome !== 'success' || started.containerId !== resource.containerId) fail('resource_mismatch');
        }
        const observed = await exact(resource, intent === 'start');
        return { kind: observed.running === (intent === 'start') ? 'confirmed' as const : 'unknown' as const };
      } catch (error) { return { kind: !issued ? 'refused' as const : 'unknown' as const, code: code(error) }; }
    },
    async destroy(raw: DevcontainerResource) {
      try {
        const { resource } = await exact(raw);
        // No --volumes, Compose down, source cleanup or image deletion. Named
        // volumes and source bytes are outside this exact container deletion.
        if (!completed(await run(input.docker, ['rm', '--force', resource.containerId], undefined, false, resource.managedMachineId, resource.workspaceFolder))) return { kind: 'unknown' as const };
        return { kind: await inspectContainer(resource.containerId, resource, resource.managedMachineId) === null ? 'confirmed' as const : 'unknown' as const };
      } catch (error) {
        if (code(error) === 'native_resource_absent') return { kind: 'confirmed' as const };
        return { kind: code(error) === 'resource_mismatch' ? 'refused' as const : 'unknown' as const, code: code(error) };
      }
    },
    async exec(raw: DevcontainerResource, argv: readonly string[], stdin?: Uint8Array) {
      const { resource } = await exact(raw, true);
      return run(input.devcontainer, ['exec', ...flags(resource), '--container-id', resource.containerId, ...argv], stdin, true, resource.managedMachineId, resource.workspaceFolder);
    },
    async putFile(raw: DevcontainerResource, guestPath: string, bytes: Uint8Array, mode = 0o600) {
      if (!guestPath.startsWith('/') || guestPath.includes('\u0000') || !Number.isInteger(mode) || mode < 0) return { kind: 'refused' as const, code: 'invalid_request' };
      const { resource } = await exact(raw, true);
      const command = `umask 077; cat > ${quote(guestPath)} && chmod ${mode.toString(8)} ${quote(guestPath)}`;
      const written = await run(input.devcontainer, ['exec', ...flags(resource), '--container-id', resource.containerId, 'sh', '-c', command], bytes, false, resource.managedMachineId, resource.workspaceFolder);
      return { kind: completed(written) ? 'confirmed' as const : 'unknown' as const };
    },
  };
}
