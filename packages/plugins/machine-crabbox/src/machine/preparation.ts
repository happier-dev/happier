import { readManagedDependencyExecutable } from '@happier-dev/plugin-sdk/managed-services';
import { buildMachineProvisionerPreparationInstallScript } from '@happier-dev/plugin-sdk/machine-provisioners';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { canonicalizePath, isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas,
  projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CrabboxLaunchV1Schema, type CrabboxLaunchV1 } from './schemas.js';
import { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID } from './constants.js';

const closed = { policy: 'closed' } as const;
const operationId = defineProtocolString({ minLength: 1 });
const imageId = defineProtocolString({ pattern: '^sha256:[a-f0-9]{64}$' });
const runtimeImageId = defineProtocolString({ pattern: '^(?:sha256:)?[a-f0-9]{64}$' });
function normalizedImageId(value: string) {
  const id = runtimeImageId.parse(value);
  return id.startsWith('sha256:') ? id : `sha256:${id}`;
}
export const CrabboxPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(CrabboxLaunchV1Schema);
export const CrabboxPreparedArtifactSchema = defineProtocolObject({ operationId, imageId, launch: CrabboxLaunchV1Schema }, closed);
export const CrabboxPreparationOperationSchema = defineProtocolObject({ operationId, imageId: imageId.optional(), launch: CrabboxLaunchV1Schema }, closed);
export const CRABBOX_PREPARATION = defineMachineProvisionerPreparationSchemas({ input: CrabboxPreparationInputSchema,
  launch: CrabboxLaunchV1Schema, artifact: CrabboxPreparedArtifactSchema, nativeOperation: CrabboxPreparationOperationSchema });
type Operation = ProtocolSchemaOutput<typeof CrabboxPreparationOperationSchema>;
type BuildInput = ProtocolSchemaOutput<typeof CrabboxPreparationInputSchema>;
const contributionRef = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_PROVISIONER_ID };
const providerIdentity = `${contributionRef.pluginId}/${contributionRef.localId}`;
const operationLabel = 'happier.prepared-operation';
const providerLabel = 'happier.prepared-provider';
const reference = (value: Operation) => ({ contributionRef, schemaVersion: 1, value });
const name = (operation: Operation) => `happier-crabbox-prepared-${Buffer.from(operation.operationId).toString('hex')}:latest`;
const supported = (launch: CrabboxLaunchV1) => launch.backendId === 'local-container' && launch.transport === 'direct';
export function crabboxPreparationGuest() {
  return process.arch === 'x64' || process.arch === 'arm64'
    ? { target: { os: 'linux' as const, arch: process.arch }, remoteHomeDir: '/opt/happier' } : undefined;
}
function completed(result: PluginProcessResult) {
  return result.termination.requestedBy.kind === 'none' && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
}
function text(result: PluginProcessResult) {
  if (!completed(result) || result.stdoutTruncated) throw new Error('Native image observation unavailable');
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}
const nativeImage = defineProtocolObject({ Id: runtimeImageId, Config: defineProtocolObject({ Labels: defineProtocolObject({
  [operationLabel]: operationId, [providerLabel]: defineProtocolString(),
}, { policy: 'additive-open/drop' }) }, { policy: 'additive-open/drop' }) }, { policy: 'additive-open/drop' });

/** Crabbox v0.72.0 localcontainer/backend.go launches the selected native image
 * with a fresh SSH bootstrap. Build that image in the same Docker/Podman store,
 * never snapshot an enrolled guest, its private key, mounts or repository. */
export function createCrabboxPreparation(context: PluginInvocationContext) {
  async function run(operation: Operation, args: readonly string[], stdin?: Uint8Array) {
    const runtime = operation.launch.backendId === 'local-container' ? operation.launch.localContainerRuntime ?? 'docker' : 'docker';
    const dependency = await readManagedDependencyExecutable(context.services.managedServices.dependencies, runtime, context.signal);
    if (dependency.state !== 'ready')
      throw new Error('Native container runtime unavailable');
    // Match direct.ts native tool discovery: no cloud/SSH/daemon environment
    // is passed to the image builder, nor build args, secret or SSH mounts.
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    return context.services.exec.run({ executable: dependency.executable, args, env, ...(stdin ? { stdin } : {}) }, { signal: context.signal });
  }
  const unknown = (operation: Operation, code = 'native_observation_unavailable') =>
    ({ kind: 'unknown' as const, code, nativeOperationRef: reference(operation) });
  async function inspectNative(operation: Operation) {
    const ids = [...new Set(text(await run(operation, ['image', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `reference=${name(operation)}`]))
      .trim().split(/\r?\n/u).filter(Boolean).map(normalizedImageId))];
    if (!ids.length) return { kind: 'absent' as const };
    if (ids.length !== 1 || operation.imageId && operation.imageId !== ids[0])
      return { kind: 'refused' as const, code: 'resource_mismatch' };
    const raw: unknown = JSON.parse(text(await run(operation, ['image', 'inspect', name(operation)])));
    if (!Array.isArray(raw) || raw.length !== 1) return unknown(operation);
    const parsed = nativeImage.safeParse(raw[0]);
    if (!parsed.success || parsed.data.Config.Labels[operationLabel] !== operation.operationId
      || parsed.data.Config.Labels[providerLabel] !== providerIdentity)
      return { kind: 'refused' as const, code: 'prepared_artifact_not_owned' };
    const id = normalizedImageId(parsed.data.Id);
    if (id !== ids[0]) return unknown(operation, 'resource_mismatch');
    return { kind: 'ready' as const, artifact: { contributionRef, schemaVersion: 1, value: {
      operationId: operation.operationId, imageId: id, launch: { ...operation.launch, nativeImageId: id },
    } } };
  }
  function failure(error: unknown, operation: Operation) {
    return projectMachineProvisionerActionFailure(error, () => unknown(operation));
  }
  return {
    async build(id: string, input: BuildInput) {
      const operation: Operation = { operationId: id, launch: input.launch.choices };
      if (!supported(operation.launch)) return { kind: 'refused' as const, code: 'crabbox_preparation_not_supported' };
      const guest = crabboxPreparationGuest();
      if (!guest) return { kind: 'refused' as const, code: 'guest_architecture_unsupported' };
      // A newline in FROM would turn an image choice into Dockerfile instructions.
      if (/\s/u.test(operation.launch.nativeImageId)) return { kind: 'refused' as const, code: 'invalid_request' };
      let directory: string | undefined;
      try {
        const retained = await inspectNative(operation);
        if (retained.kind !== 'absent') return retained;
        directory = await mkdtemp(join(tmpdir(), 'happier-crabbox-prepare-'));
        directory = await canonicalizePath(directory);
        const copies: string[] = [];
        for (const file of input.cli.files) {
          const target = await canonicalizePath(join(directory, file.path));
          if (target === directory || !isCanonicalAbsolutePathInsideRoot(directory, target) || file.path.includes('\\'))
            return { kind: 'refused' as const, code: 'invalid_request' };
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(file.contentsBase64, 'base64'));
          copies.push('COPY ' + JSON.stringify([file.path, '/tmp/happier-build/' + file.path]));
        }
        const command = ['sh', '-c', 'set -e\nmkdir -p /tmp/happier-build\n'
          + buildMachineProvisionerPreparationInstallScript({ cli: input.cli, stageDirectory: '/tmp/happier-build',
            readableRoot: '/opt/happier', setupScript: input.setupScript })
          + 'cd /\nrm -rf /tmp/happier-build\n'];
        // Native Crabbox starts its SSH bootstrap as root, independent of the
        // base image USER. Only public CLI payload and reviewed Setup are baked.
        const platform = guest.target.arch === 'x64' ? 'amd64' : 'arm64';
        const dockerfile = [`FROM --platform=linux/${platform} ${operation.launch.nativeImageId}`, 'USER root', ...copies, `RUN ${JSON.stringify(command)}`].join('\n') + '\n';
        const built = await run(operation, ['build', '--force-rm', '--tag', name(operation), '--label', `${operationLabel}=${id}`,
          '--label', `${providerLabel}=${providerIdentity}`, '--file', '-', directory], Buffer.from(dockerfile));
        if (!completed(built)) return unknown(operation, 'native_build_failed');
        const observed = await inspectNative(operation);
        return observed.kind === 'ready' || observed.kind === 'unknown' ? observed : unknown(operation, 'native_build_unconfirmed');
      } catch (error) { return failure(error, operation); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    },
    async inspect(operation: Operation) {
      if (!supported(operation.launch)) return unknown(operation, 'crabbox_preparation_not_supported');
      try {
        const observed = await inspectNative(operation);
        if (observed.kind === 'refused') throw new PluginError({ code: observed.code });
        return observed;
      } catch (error) { return failure(error, operation); }
    },
    async destroy(operation: Operation) {
      if (!supported(operation.launch)) return { kind: 'refused' as const, code: 'crabbox_preparation_not_supported' };
      try {
        const observed = await inspectNative(operation);
        if (observed.kind === 'absent') return { kind: 'confirmed' as const };
        if (observed.kind !== 'ready') return observed;
        // Remove only our operation's tag, never force, prune, or delete an
        // image by digest that may now have another person's retained tags.
        if (!completed(await run(operation, ['image', 'rm', '--no-prune', '--', name(operation)]))) return unknown(operation);
        const remaining = await inspectNative(operation);
        return remaining.kind === 'absent' ? { kind: 'confirmed' as const }
          : remaining.kind === 'unknown' ? remaining : { kind: 'pending' as const, nativeOperationRef: reference(operation) };
      } catch (error) { return failure(error, operation); }
    },
  };
}
