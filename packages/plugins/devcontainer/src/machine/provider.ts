import { PluginError, projectPluginFailureText } from '@happier-dev/plugin-sdk';
import { projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { compareMachineHosts, MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1, type MachineProvisionerNativeCauseV1, type MachineProvisionerGuestHomeV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { MachineProvisionerSizeV1Schema, requiresMachineProvisionerEffectReviewV1, type MachineProvisionerSizeV1, type MachineProvisionerResizeResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { isDeepStrictEqual } from 'node:util';
import { posix, win32 } from 'node:path';
import { access } from 'node:fs/promises';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { DevcontainerLaunchSchema, DevcontainerResourceSchema, DevcontainerNativeOperationSchema, DEVCONTAINER_EFFECT_REVIEW_REQUIREMENT } from './schemas.js';
import type { DevcontainerLaunch, DevcontainerResource, DevcontainerNativeOperation, DevcontainerReviewQuery } from './schemas.js';
import { assertDevcontainerEffectReview, devcontainerComposeProjectName, readDevcontainerEffectReview, readDevcontainerNativeEnvironment } from './effectReview.js';
import { devcontainerNativeFlags } from './configuration.js';

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
function imageSource(launch: DevcontainerLaunch) { return launch.configuration?.kind === 'image' ? launch.configuration : undefined; }
function readyPath(managedMachineId: string) { return `/tmp/.${devcontainerComposeProjectName(managedMachineId)}-ready`; }
function nativeLabels(launch: DevcontainerLaunch | undefined, managedMachineId: string) {
  const managed = { 'happier.managed-machine': managedMachineId };
  return !launch ? managed : imageSource(launch) ? { ...managed, 'happier.image-review': launch.reviewedEffectDigest }
    : { 'devcontainer.local_folder': launch.workspaceFolder!, 'devcontainer.config_file': launch.configPath!, ...managed };
}
function managedFlags(launch: DevcontainerLaunch, managedMachineId: string) {
  return [...devcontainerNativeFlags(launch), ...Object.entries(nativeLabels(launch, managedMachineId))
    .flatMap(([key, value]) => ['--id-label', `${key}=${value}`])];
}
function quote(value: string) { return `'${value.replace(/'/gu, `'"'"'`)}'`; }
function mountArgument(fields: readonly string[]) {
  return fields.map(value => /[,"\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',');
}
function commandFailure(result: PluginProcessResult,
  command: Extract<MachineProvisionerNativeCauseV1, { localCause: 'native_command_failed' }>['command'],
  outputMayContainSetup = command === 'up'): Extract<MachineProvisionerNativeCauseV1, { localCause: 'native_command_failed' }> {
  const observed = result.termination.observed;
  const exitCode = observed.kind === 'exit' && result.termination.requestedBy.kind === 'none' ? observed.exitCode : null;
  if (outputMayContainSetup) return { localCause: 'native_command_failed', command, exitCode };
  const stderr = projectPluginFailureText(new Error(new TextDecoder().decode(result.stderr))).trim();
  return { localCause: 'native_command_failed', command, exitCode,
    ...(stderr ? { stderr: stderr.slice(-MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1) } : {}),
    ...(result.stderrTruncated || stderr.length > MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 ? { stderrTruncated: true } : {}) };
}

function failedSetup(result: PluginProcessResult) {
  if (result.stdoutTruncated || result.termination.requestedBy.kind !== 'none'
    || result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 1) return null;
  let outcome: Record<string, unknown>;
  try { outcome = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout))); }
  catch { return null; }
  if (outcome.outcome !== 'error' || typeof outcome.description !== 'string') return null;
  const failure = /^(.*(?:onCreate|updateContent|postCreate|postStart|postAttach)Command from .+) failed\.$/u.exec(outcome.description);
  if (!failure) return null;
  // The Dev Containers CLI reports exit 1 for `up`. The hook's exit code is in
  // the stderr diagnostic paired with its machine-readable failure description.
  const prefix = `${failure[1]} failed with exit code `;
  const lines = new TextDecoder().decode(result.stderr).split(/\r?\n/u);
  let exitCode: number | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.replace(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] /u, '');
    if (!line.startsWith(prefix)) continue;
    const exit = /^(\d+)\./u.exec(line.slice(prefix.length));
    exitCode = exit ? Number(exit[1]) : undefined;
    break;
  }
  return { exitCode: exitCode && Number.isSafeInteger(exitCode) ? exitCode : undefined,
    containerId: typeof outcome.containerId === 'string' && /^[a-f0-9]{64}$/u.test(outcome.containerId) ? outcome.containerId : undefined };
}

/** One diagnosis for image acquire and clean CLI-image builds on Lima. */
export async function devcontainerImageNeedsHostDns(image: string,
  run: (args: readonly string[]) => Promise<PluginProcessResult>,
  current?: Readonly<{ native: Record<string, unknown>; probeBridge: (argv: readonly string[]) => Promise<PluginProcessResult> }>): Promise<boolean> {
  // Lima's boot marker identifies the reproduced VM topology. Probe only here,
  // never impose DNS work on other hosts or an already selected host network.
  try { await access('/run/lima-boot-done'); } catch { return false; }
  if (current) {
    const mode = record(current.native.HostConfig).NetworkMode;
    if (mode !== 'bridge' && mode !== 'default') {
      if (typeof mode !== 'string' || mode === 'host' || mode === 'none' || mode.startsWith('container:')) return false;
      const inspected = await run(['network', 'inspect', mode]);
      if (!completed(inspected) || inspected.stdoutTruncated) return false;
      const networks = json(inspected);
      if (!Array.isArray(networks) || record(networks[0]).Driver !== 'bridge') return false;
    }
  }
  // GitHub is the reproduced failing download origin, not another DNS server.
  // Probes use the image's own resolver; --rm owns their native cleanup.
  const probe = ['sh', '-c', 'getent hosts github.com'];
  const bridge = current ? await current.probeBridge(probe)
    : await run(['run', '--rm', '--network', 'bridge', '--entrypoint', probe[0]!, '--', image, ...probe.slice(1)]);
  // Missing tooling, cancellation and transport failures are not DNS evidence.
  if (bridge.termination.requestedBy.kind !== 'none' || bridge.termination.observed.kind !== 'exit'
    || bridge.termination.observed.exitCode !== 2) return false;
  const host = await run(['run', '--rm', '--network', 'host', '--entrypoint', probe[0]!, '--', image, ...probe.slice(1)]);
  return completed(host) && !host.stdoutTruncated && host.stdout.length > 0;
}

/** Docker effects exist only behind this provisioner's admitted native roles.
 * Enrollment, credentials, revision and Session custody remain host-owned. */
export function createDevcontainerProvider(input: Readonly<{
  exec: Pick<ExecService, 'run' | 'spawn'>; docker: ManagedExecutableRef; devcontainer?: ManagedExecutableRef;
  signal: AbortSignal; observedAt: number; environment?: Readonly<Record<string, string>>;
}>) {
  const environment = input.environment ?? readDevcontainerNativeEnvironment();
  const nativeInput = { ...input, environment };
  const cli = () => input.devcontainer ?? fail('provider_unavailable');
  const request = (executable: ManagedExecutableRef, args: readonly string[], managedMachineId?: string, workspaceFolder?: string) => ({
    executable, args, ...(workspaceFolder ? { cwd: workspaceFolder } : {}),
    env: { ...environment, ...(managedMachineId ? { COMPOSE_PROJECT_NAME: devcontainerComposeProjectName(managedMachineId) } : {}) } });
  const run = (executable: ManagedExecutableRef, args: readonly string[], stdin?: Uint8Array, live = false, managedMachineId?: string, workspaceFolder?: string) =>
    input.exec.run({ ...request(executable, args, managedMachineId, workspaceFolder), ...(stdin === undefined ? {} : { stdin }) },
      { signal: input.signal, ...(live ? { outputDelivery: 'invocation' as const } : {}),
        // Successful native up owns its Docker attachment beyond this invocation.
        // Failed and cancelled launches retain the ordinary Exec cleanup policy.
        ...(args[0] === 'up' ? { descendantDisposition: 'preserve-on-success' as const } : {}) });
  async function bridgeNeedsHostDns(image: string, current?: Readonly<{ resource: DevcontainerResource; native: Record<string, unknown> }>) {
    return devcontainerImageNeedsHostDns(image, args => run(input.docker, args), current ? {
      native: current.native,
      probeBridge: probe => childExec(current.resource, current.resource.containerId, probe, undefined, false, current.resource.managedMachineId),
    } : undefined);
  }
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
  function requireChildStorage(native: Record<string, unknown>) {
    if (!Array.isArray(native.Mounts)) fail('native_observation_unavailable');
    if (native.Mounts.some(mount => record(mount).Type === 'bind')) fail('invalid_request');
  }
  function assertLabels(native: Record<string, unknown>, launch: DevcontainerLaunch, managedMachineId: string) {
    const labels = record(record(native.Config).Labels);
    if (Object.entries(nativeLabels(launch, managedMachineId)).some(([key, value]) => labels[key] !== value)) fail('resource_mismatch');
  }
  const childCommand = (launch: DevcontainerLaunch, containerId: string, argv: readonly string[], interactive: boolean) =>
    imageSource(launch)
      ? { executable: input.docker, args: ['exec', ...(interactive ? ['--interactive'] : []), '--workdir', '/workspace', containerId, ...argv] }
      : { executable: cli(), args: ['exec', ...devcontainerNativeFlags(launch), '--container-id', containerId, ...argv] };
  const childExec = (launch: DevcontainerLaunch, containerId: string, argv: readonly string[], stdin?: Uint8Array, live = false, managedMachineId?: string) => {
    const command = childCommand(launch, containerId, argv, stdin !== undefined);
    return run(command.executable, command.args, stdin, live, managedMachineId, launch.workspaceFolder);
  };
  async function namespace(launch: DevcontainerLaunch, containerId: string, managedMachineId: string) {
    // Even id/pwd applies the configured userEnvProbe and can evaluate shell
    // startup. Keep that IO behind the same reviewed-effects owner as launch.
    if (!imageSource(launch)) await assertDevcontainerEffectReview(nativeInput, launch, launch.reviewedEffectDigest);
    // This is private bootstrap IO; regular child commands use the enrolled
    // Machine transport.
    const observed = output(await childExec(launch, containerId, ['sh', '-c', 'id -un; pwd -P'], undefined, false, managedMachineId));
    const boundary = observed.indexOf('\n');
    if (boundary <= 0 || !observed.endsWith('\n')) fail('child_namespace_unavailable');
    // POSIX paths may contain CR/LF. Only id's first LF and pwd's final LF
    // delimit the two values; all intervening path bytes are significant.
    return { user: observed.slice(0, boundary), workspaceRoot: observed.slice(boundary + 1, -1) };
  }
  async function assertNamespaceCurrent(resource: DevcontainerResource) {
    if (!isDeepStrictEqual(await namespace(resource, resource.containerId, resource.managedMachineId),
      { user: resource.user, workspaceRoot: resource.workspaceRoot })) fail('resource_mismatch');
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
      requireChildStorage(native);
      if (!state.Running || state.Paused) fail('child_unavailable');
      await assertNamespaceCurrent(resource);
    }
    return { resource, native, running: state.Running && !state.Paused, paused: state.Paused };
  }
  async function observe(launch: DevcontainerLaunch, containerId: string, managedMachineId: string, homeOnControllerHost = false) {
    const native = await inspectContainer(containerId, launch, managedMachineId);
    if (!native || record(native.State).Running !== true || record(native.State).Paused !== false) fail('native_realization_unknown');
    assertLabels(native, launch, managedMachineId);
    requireChildStorage(native);
    // Running alone does not mean an image's preparation/setup completed: a
    // detached run can succeed before IO is interrupted, or failed setup cleanup
    // can be unavailable. Only this creation path produces the guest witness.
    if (imageSource(launch) && !completed(await childExec(launch, containerId, ['sh', '-c', 'test -f "$1"', 'sh', readyPath(managedMachineId)], undefined, false, managedMachineId))) fail('native_realization_unknown');
    const observed = await namespace(launch, containerId, managedMachineId);
    const resource = DevcontainerResourceSchema.parse({ ...launch, managedMachineId, containerId, ...observed, ...storage(native, observed.workspaceRoot),
      ...(homeOnControllerHost ? { homeOnControllerHost: true } : {}) });
    return { kind: 'bound' as const, resource: { origin: 'created' as const, contributionRef, schemaVersion: 1, value: resource,
      devcontainerObservation: { nativeResourceId: resource.containerId, user: resource.user,
        workspaceFolder: resource.workspaceRoot, storage: resource.storage },
    } };
  }
  async function inventory(launch: DevcontainerLaunch | undefined, managedMachineId: string) {
    return output(await run(input.docker, ['ps', '--all', '--no-trunc',
      ...Object.entries(nativeLabels(launch, managedMachineId)).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`]),
      '--format', '{{.ID}}'], undefined, false, managedMachineId, launch?.workspaceFolder))
      .trim().split(/\r?\n/u).filter(Boolean);
  }
  async function resolveDestroyResource(operation: DevcontainerNativeOperation) {
    if (!('launch' in operation)) return (await exact(operation)).resource;
    const { launch, managedMachineId, nativeResourceId } = operation;
    const ids = nativeResourceId ? [nativeResourceId] : await inventory(launch, managedMachineId);
    if (ids.length === 0) return null;
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0]!)) fail('resource_mismatch');
    const containerId = ids[0]!;
    const native = await inspectContainer(containerId, launch, managedMachineId);
    if (!native) return null;
    assertLabels(native, launch, managedMachineId);
    return { ...launch, managedMachineId, containerId };
  }
  async function confirmDestroy(resource: NonNullable<Awaited<ReturnType<typeof resolveDestroyResource>>>) {
    // No --volumes, Compose down, source cleanup or image deletion. Named
    // volumes and source bytes are outside this exact container deletion.
    try { await run(input.docker, ['rm', '--force', resource.containerId], undefined, false, resource.managedMachineId, resource.workspaceFolder); }
    catch { /* A missing removal reply still permits the exact absence observation. */ }
    return await inspectContainer(resource.containerId, resource, resource.managedMachineId) === null;
  }
  async function realize(launch: DevcontainerLaunch, managedMachineId: string, recoveryReference = launch.configPath ?? managedMachineId, guestHome?: MachineProvisionerGuestHomeV1) {
    const homeOnControllerHost = compareMachineHosts(guestHome?.hostIdentity?.homeMachineHost, guestHome?.hostIdentity?.controllerMachineHost);
    let nativeCause: MachineProvisionerNativeCauseV1 | undefined;
    let setupCleanupConfirmed = false;
    const settleFailedSetup = async (nativeResourceId?: string): Promise<never> => {
      recoveryReference = nativeResourceId ?? recoveryReference;
      try {
        const resource = await resolveDestroyResource({ launch, managedMachineId, nativeResourceId });
        if (resource) recoveryReference = resource.containerId;
        setupCleanupConfirmed = resource === null || await confirmDestroy(resource);
      } catch { /* Keep the failed acquisition unavailable for enrollment while cleanup is unconfirmed. */ }
      fail('native_setup_failed');
    };
    try {
      // Only admitted acquire/rebuild roles reach evaluation of host and child
      // hooks. Discovery and retained-resource inspection never evaluate them.
      let result: PluginProcessResult;
      const source = imageSource(launch);
      const useHostNetwork = source && (homeOnControllerHost || await bridgeNeedsHostDns(source.image));
      const command = source ? 'run' : 'up';
      try { result = source
        ? await run(input.docker, ['run', '--detach',
          // Image-only input has no authored network. Advanced file/inline/Compose
          // networking stays under its existing effect review and native CLI.
          ...(useHostNetwork ? ['--network', 'host'] : []),
          ...Object.entries(nativeLabels(launch, managedMachineId)).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          '--mount', mountArgument(['type=volume',
            `source=${devcontainerComposeProjectName(managedMachineId)}-workspace`, 'target=/workspace']),
          // Native hosts entries preserve the declared hostname/TLS identity and
          // the controller's split DNS in either native network mode.
          ...(guestHome?.addresses.flatMap(address => ['--add-host', `${new URL(guestHome.origin).hostname}:${address}`]) ?? []),
          '--workdir', '/workspace', '--entrypoint', 'sh', '--', source.image,
          '-c', "trap 'exit 0' TERM INT; while :; do sleep 2147483647 & wait $!; done"], undefined, false, managedMachineId, launch.workspaceFolder)
        : await run(cli(), ['up', ...managedFlags(launch, managedMachineId)], undefined, false, managedMachineId, launch.workspaceFolder); }
      catch (error) { nativeCause = { localCause: 'native_command_failed', command, exitCode: null,
        failureCause: projectActionFailureCauseV1(error, 'exec.run') };
        fail('native_realization_unknown'); }
      if (!completed(result)) {
        const cause = commandFailure(result, command);
        nativeCause = cause;
        const setup = source ? null : failedSetup(result);
        if (setup) {
          if (setup.exitCode !== undefined) nativeCause = { ...cause, exitCode: setup.exitCode };
          return await settleFailedSetup(setup.containerId);
        }
        fail('native_realization_unknown');
      }
      if (result.stdoutTruncated) fail('native_observation_unavailable');
      if (source) {
        const id = output(result).trim();
        if (!/^[a-f0-9]{64}$/u.test(id)) fail('native_realization_unknown');
        recoveryReference = id;
        const prepare = async () => {
          // Docker creates an absent image workspace as root. Give only the
          // volume root to the image's actual user; retain existing file ownership.
          const identity = output(await childExec(launch, id, ['sh', '-c', 'id -u; id -g'], undefined, false, managedMachineId)).trim().split(/\r?\n/u);
          if (identity.length !== 2 || identity.some(value => !/^\d+$/u.test(value))) fail('child_namespace_unavailable');
          const ownership = await run(input.docker, ['exec', '--user', '0', id, 'chown', `${identity[0]}:${identity[1]}`, '/workspace']);
          if (!completed(ownership)) { nativeCause = commandFailure(ownership, command); fail('native_setup_failed'); }
          if (source.setupScript) {
            const setup = await childExec(launch, id, ['sh', '-c', source.setupScript], undefined, false, managedMachineId);
            if (!completed(setup)) { nativeCause = commandFailure(setup, command, true); fail('native_setup_failed'); }
          }
          const ready = await childExec(launch, id, ['sh', '-c', ': > "$1"', 'sh', readyPath(managedMachineId)], undefined, false, managedMachineId);
          if (!completed(ready)) { nativeCause = commandFailure(ready, command); fail('native_setup_failed'); }
        };
        try { await prepare(); }
        catch { return await settleFailedSetup(id); }
        return { outcome: await observe(launch, id, managedMachineId, homeOnControllerHost), homeOnControllerHost };
      }
      const up = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)));
      if (typeof up.containerId === 'string' && /^[a-f0-9]{64}$/u.test(up.containerId)) recoveryReference = up.containerId;
      if (up.outcome !== 'success' || typeof up.containerId !== 'string' || !/^[a-f0-9]{64}$/u.test(up.containerId)
        || typeof up.remoteUser !== 'string' || typeof up.remoteWorkspaceFolder !== 'string') fail('native_realization_unknown');
      return { outcome: await observe(launch, up.containerId, managedMachineId, homeOnControllerHost), homeOnControllerHost };
    } catch (error) { return { homeOnControllerHost, setupCleanupConfirmed, outcome: { kind: 'unknown' as const, recovery: { reference: recoveryReference, reason: code(error) },
      ...(nativeCause ? { nativeCause } : {}) } }; }
  }
  return {
    async check() {
      try {
        output(await run(input.docker, ['version', '--format', '{{.Server.Version}}']));
        if (!input.devcontainer) return { available: true };
        const version = output(await run(input.devcontainer, ['--version'])).trim();
        return /^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(version) ? { available: true } : { available: false, code: 'devcontainer_version_unavailable' };
      } catch (error) { return { available: false, code: code(error) }; }
    },
    async acquire(rawLaunch: DevcontainerReviewQuery & { reviewedEffectDigest?: string }, managedMachineId: string, guestHome?: MachineProvisionerGuestHomeV1) {
      if (!managedMachineId) return { kind: 'rejected' as const, code: 'invalid_request' as const };
      const { reviewedEffectDigest, ...query } = rawLaunch;
      // Image presets fully specify the child setup; image metadata cannot add
      // Dev Containers hooks. Only advanced sources need admitted native review.
      // Still retain locally observed executable facts for exact reconciliation.
      if (requiresMachineProvisionerEffectReviewV1({ effectReview: DEVCONTAINER_EFFECT_REVIEW_REQUIREMENT }, query) && !reviewedEffectDigest) return { kind: 'rejected' as const, code: 'invalid_request' as const };
      let launch: DevcontainerLaunch;
      try {
        launch = (await readDevcontainerEffectReview(nativeInput, query)).launch;
        if (reviewedEffectDigest && launch.reviewedEffectDigest !== reviewedEffectDigest) fail('request_conflict');
      } catch (error) {
        return { kind: 'rejected' as const, code: code(error) === 'request_conflict' ? 'request_conflict' as const
          : code(error) === 'invalid_request' ? 'invalid_request' as const : 'provider_unavailable' as const };
      }
      const { outcome: result, homeOnControllerHost, setupCleanupConfirmed } = await realize(launch, managedMachineId, undefined, guestHome);
      if (result.kind === 'bound') return result;
      const cleanupOnly = result.recovery.reason === 'native_setup_failed';
      const failure = result.nativeCause ? { nativeCause: result.nativeCause } : {};
      if (cleanupOnly && setupCleanupConfirmed) return { kind: 'rejected' as const, code: 'native_setup_failed', ...failure };
      return { kind: 'pending' as const, ...failure, nativeOperationRef: {
        contributionRef, schemaVersion: 1, value: { managedMachineId, launch,
          ...(homeOnControllerHost ? { homeOnControllerHost: true as const } : {}),
          ...(cleanupOnly ? { cleanupOnly: true as const } : {}),
          ...(/^[a-f0-9]{64}$/u.test(result.recovery.reference) ? { nativeResourceId: result.recovery.reference } : {}) },
      } };
    },
    async reconcileAcquisition(managedMachineId: string) {
      try {
        // Lost acknowledgements retain no reviewed launch facts. The managed
        // label alone can prove absence without reviewing or adopting a child.
        if ((await inventory(undefined, managedMachineId)).length !== 0) fail('native_realization_unknown');
        return { kind: 'rejected' as const, code: 'managed_not_found' as const };
      } catch (error) {
        return { kind: 'unknown' as const, recovery: { reference: managedMachineId, reason: code(error) } };
      }
    },
    async reconcile(raw: DevcontainerNativeOperation) {
      const operation = DevcontainerNativeOperationSchema.parse(raw);
      const launch = 'launch' in operation ? operation.launch : operation;
      try {
        if ('launch' in operation && operation.cleanupOnly) {
          if (await resolveDestroyResource(operation) !== null) fail('native_setup_failed');
          return { kind: 'rejected' as const, code: 'managed_not_found' as const };
        }
        const matching = await inventory(launch, operation.managedMachineId);
        if (matching.length !== 1 || ('containerId' in operation && matching[0] === operation.containerId)
          || ('launch' in operation && operation.nativeResourceId !== undefined && matching[0] !== operation.nativeResourceId)
          || !/^[a-f0-9]{64}$/u.test(matching[0]!)) fail('native_realization_unknown');
        return await observe(launch, matching[0]!, operation.managedMachineId, operation.homeOnControllerHost);
      } catch (error) {
        return 'containerId' in operation
          ? { kind: 'unknown' as const, recovery: { reference: operation.containerId, reason: code(error) } }
          : { kind: 'pending' as const, nativeOperationRef: { contributionRef, schemaVersion: 1, value: operation } };
      }
    },
    async rebuild(raw: DevcontainerResource, reviewedEffectDigest: string, guestHome?: MachineProvisionerGuestHomeV1) {
      let issued = false;
      try {
        const { resource } = await exact(raw);
        const matching = await inventory(resource, resource.managedMachineId);
        if (matching.length !== 1 || matching[0] !== resource.containerId) fail('resource_mismatch');
        await assertDevcontainerEffectReview(nativeInput, resource, reviewedEffectDigest);
        const replacementLaunch = DevcontainerLaunchSchema.parse({ ...(resource.workspaceFolder ? { workspaceFolder: resource.workspaceFolder } : {}),
          ...(resource.configPath ? { configPath: resource.configPath } : {}), ...(resource.runtime ? { runtime: resource.runtime } : {}),
          ...(resource.configuration ? { configuration: resource.configuration } : {}), reviewedEffectDigest });
        issued = true;
        // The CLI's remove-existing flag selects by labels (or Compose
        // project/service), so deletion uses the retained exact Docker id.
        // No --volumes: bind sources and external volumes retain their owners.
        if (!completed(await run(input.docker, ['rm', '--force', resource.containerId], undefined, false, resource.managedMachineId, resource.workspaceFolder))) {
          return { kind: 'unknown' as const, recovery: { reference: resource.containerId, reason: 'native_rebuild_unknown' } };
        }
        return (await realize(replacementLaunch, resource.managedMachineId, resource.containerId, guestHome)).outcome;
      } catch (error) {
        if (!issued) return { kind: 'refused' as const, code: code(error) };
        return { kind: 'unknown' as const, recovery: { reference: raw.containerId, reason: code(error) } };
      }
    },
    async bootstrap(resource: DevcontainerResource) {
      const { native } = await exact(resource, true);
      if (!imageSource(resource) && typeof native.Image === 'string' && await bridgeNeedsHostDns(native.Image, { resource, native })) {
        throw new PluginError({ code: 'dns_host_network_required',
          message: 'This container uses bridge networking; DNS on this host is only reachable with host networking. Configure host networking in the devcontainer or Compose source, or provide a DNS resolver reachable from that network.' });
      }
      return { kind: 'native' as const, transport: { contributionRef, schemaVersion: 1 },
        ...(resource.homeOnControllerHost && !imageSource(resource) && record(native.HostConfig).NetworkMode !== 'host'
          ? { homeNetworkHint: 'authored_network' as const } : {}) };
    },
    async inspect(raw: DevcontainerResource) {
      try {
        const { native, running, paused } = await exact(raw);
        const host = record(native.HostConfig);
        // Docker reports --cpus as NanoCpus; Podman can report its equivalent
        // CFS quota/period instead. Zero means unlimited, not a physical size.
        const cpuCores = typeof host.NanoCpus === 'number' && host.NanoCpus > 0 ? host.NanoCpus / 1e9
          : typeof host.CpuQuota === 'number' && host.CpuQuota > 0 && typeof host.CpuPeriod === 'number' && host.CpuPeriod > 0
            ? host.CpuQuota / host.CpuPeriod : undefined;
        const size = MachineProvisionerSizeV1Schema.safeParse({ ...(cpuCores === undefined ? {} : { cpuCores }),
          ...(typeof host.Memory === 'number' && host.Memory > 0 ? { memoryBytes: host.Memory } : {}) });
        return { observedAt: input.observedAt, availability: 'present' as const, power: paused ? 'suspended' as const : running ? 'running' as const : 'stopped' as const,
          storage: 'retained' as const,
          ...(size.success ? { size: size.data } : {}),
          billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const } };
      } catch (error) { return { observedAt: input.observedAt, availability: code(error) === 'native_resource_absent' ? 'absent' as const : 'unavailable' as const,
        reason: code(error) }; }
    },
    async resize(raw: DevcontainerResource, size: MachineProvisionerSizeV1): Promise<MachineProvisionerResizeResultV1> {
      if (size.diskBytes !== undefined) return { kind: 'unsupported', dimension: 'diskBytes', code: 'container_disk_resize_unsupported' };
      let issued = false;
      try {
        const { resource } = await exact(raw);
        issued = true;
        const result = await run(input.docker, ['update',
          ...(size.cpuCores === undefined ? [] : ['--cpus', String(size.cpuCores)]),
          ...(size.memoryBytes === undefined ? [] : ['--memory', String(size.memoryBytes)]), resource.containerId],
        undefined, false, resource.managedMachineId, resource.workspaceFolder);
        return completed(result) ? { kind: 'confirmed' } : { kind: 'unknown', code: 'container_resize_failed', nativeCause: commandFailure(result, 'update') };
      } catch (error) { return { kind: issued ? 'unknown' : 'refused', code: code(error) }; }
    },
    async power(raw: DevcontainerResource, intent: 'start' | 'stop') {
      let issued = false;
      try {
        const { resource, native } = await exact(raw);
        if (intent === 'start') requireChildStorage(native);
        if (intent === 'start' && !imageSource(resource)) await assertDevcontainerEffectReview(nativeInput, resource, resource.reviewedEffectDigest);
        issued = true;
        const result = intent === 'stop'
          ? await run(input.docker, ['stop', resource.containerId], undefined, false, resource.managedMachineId, resource.workspaceFolder)
          : imageSource(resource) ? await run(input.docker, ['start', resource.containerId], undefined, false, resource.managedMachineId, resource.workspaceFolder)
            : await run(cli(), ['up', ...managedFlags(resource, resource.managedMachineId), '--expect-existing-container'], undefined, false, resource.managedMachineId, resource.workspaceFolder);
        if (!completed(result)) return { kind: 'unknown' as const, code: 'native_power_unknown' };
        if (intent === 'start' && !imageSource(resource)) {
          const started = record(json(result));
          if (started.outcome !== 'success' || started.containerId !== resource.containerId) fail('resource_mismatch');
        }
        const observed = await exact(resource, intent === 'start');
        return { kind: observed.running === (intent === 'start') ? 'confirmed' as const : 'unknown' as const };
      } catch (error) { return { kind: !issued ? 'refused' as const : 'unknown' as const, code: code(error) }; }
    },
    async destroy(raw: DevcontainerNativeOperation) {
      try {
        const resource = await resolveDestroyResource(DevcontainerNativeOperationSchema.parse(raw));
        return { kind: resource === null || await confirmDestroy(resource) ? 'confirmed' as const : 'unknown' as const };
      } catch (error) {
        if (code(error) === 'native_resource_absent') return { kind: 'confirmed' as const };
        return { kind: code(error) === 'resource_mismatch' ? 'refused' as const : 'unknown' as const, code: code(error) };
      }
    },
    async exec(raw: DevcontainerResource, argv: readonly string[], stdin?: Uint8Array) {
      const { resource } = await exact(raw, true);
      return childExec(resource, resource.containerId, argv, stdin, true, resource.managedMachineId);
    },
    /** The optional `stream` role: one interactive non-PTY child process carrying the invocation's channel. */
    async stream(raw: DevcontainerResource, argv: readonly string[]) {
      const { resource } = await exact(raw, true);
      const command = childCommand(resource, resource.containerId, argv, true);
      return input.exec.spawn(request(command.executable, command.args, resource.managedMachineId, resource.workspaceFolder),
        { signal: input.signal, outputDelivery: 'invocation' });
    },
    async putFile(raw: DevcontainerResource, guestPath: string, bytes: Uint8Array, mode = 0o600) {
      if (!guestPath.startsWith('/') || guestPath.includes('\u0000') || !Number.isInteger(mode) || mode < 0) return { kind: 'refused' as const, code: 'invalid_request' };
      const { resource } = await exact(raw, true);
      const command = `umask 077; cat > ${quote(guestPath)} && chmod ${mode.toString(8)} ${quote(guestPath)}`;
      const written = await childExec(resource, resource.containerId, ['sh', '-c', command], bytes, false, resource.managedMachineId);
      return { kind: completed(written) ? 'confirmed' as const : 'unknown' as const };
    },
  };
}
