import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { buildMachineProvisionerPreparationInstallScript, createManagedMachinePresetPreparationBuildInputV1Schema, type ManagedMachinePresetPreparationBuildInputV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { canonicalizePath, isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { DevcontainerReviewQuerySchema, DevcontainerRuntimeSchema } from './schemas.js';
import { DEVCONTAINER_PREPARATION_HOME } from './effectReview.js';
import { devcontainerImageNeedsHostDns, DEVCONTAINER_PLUGIN_ID, DEVCONTAINER_PROVISIONER_ID } from './provider.js';

const closed = { policy: 'closed' } as const;
const operationId = defineProtocolString({ minLength: 1 });
const imageId = defineProtocolString({ pattern: '^sha256:[a-f0-9]{64}$' });
export const DevcontainerPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(DevcontainerReviewQuerySchema);
export const DevcontainerPreparedImageSchema = defineProtocolObject({ operationId, runtime: DevcontainerRuntimeSchema, imageId,
  launch: DevcontainerReviewQuerySchema }, closed);
export const DevcontainerPreparationOperationSchema = defineProtocolObject({ operationId, runtime: DevcontainerRuntimeSchema,
  launch: DevcontainerReviewQuerySchema, imageId: imageId.optional() }, closed);
type PreparationOperation = ProtocolSchemaOutput<typeof DevcontainerPreparationOperationSchema>;
export function resolveDevcontainerPreparationInput(input: ManagedMachinePresetPreparationBuildInputV1) {
  return { launch: DevcontainerReviewQuerySchema.parse(input.launch.choices), cli: input.cli,
    ...(input.setupScript === undefined ? {} : { setupScript: input.setupScript }) };
}
type PreparationInput = ReturnType<typeof resolveDevcontainerPreparationInput>;
export function devcontainerPreparationOperation(id: string, input: Pick<PreparationInput, 'launch'>): PreparationOperation {
  return { operationId: id, runtime: input.launch.runtime ?? 'docker', launch: input.launch };
}
const contributionRef = { pluginId: DEVCONTAINER_PLUGIN_ID, localId: DEVCONTAINER_PROVISIONER_ID };
const operationLabel = 'happier.prepared-operation';
const providerLabel = 'happier.prepared-provider';
const providerIdentity = `${contributionRef.pluginId}/${contributionRef.localId}`;
function nativeName(operation: PreparationOperation) {
  return `happier-prepared-${Buffer.from(operation.operationId).toString('hex')}`;
}
function reference<T extends PreparationOperation>(value: T) { return { contributionRef, schemaVersion: 1, value }; }
function completed(result: PluginProcessResult) {
  return result.termination.requestedBy.kind === 'none' && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
}
function text(result: PluginProcessResult) {
  if (!completed(result) || result.stdoutTruncated) throw new Error('Native image observation unavailable');
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}
function nativeId(value: unknown) {
  if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value)) throw new Error('Invalid native image identity');
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** S1 supplies the credential-free CLI input from Update and original choices.
 * No checkout, live guest, build arguments, secrets or SSH mounts are supplied.
 * Native build owns intermediate cleanup; the preset owner owns operation life. */
export function createDevcontainerPreparation(input: Readonly<{
  exec: Pick<ExecService, 'run'>; docker: ManagedExecutableRef; signal: AbortSignal;
  environment?: Readonly<Record<string, string>>;
}>) {
  const run = (args: readonly string[], stdin?: Uint8Array, live = false) => input.exec.run({ executable: input.docker,
    args, ...(input.environment ? { env: input.environment } : {}), ...(stdin ? { stdin } : {}) },
  { signal: input.signal, ...(live ? { outputDelivery: 'invocation' as const } : {}) });
  const unknown = (operation: PreparationOperation, code = 'native_observation_unavailable') =>
    ({ kind: 'unknown' as const, code, nativeOperationRef: reference(operation) });
  async function inspectNative(operation: PreparationOperation, byName = false) {
    const filter = byName ? `reference=${nativeName(operation)}:latest` : `label=${operationLabel}=${operation.operationId}`;
    const lines = text(await run(['image', 'ls', '--all', '--no-trunc', '--quiet', '--filter', filter])).trim();
    const ids = [...new Set(lines ? lines.split(/\r?\n/u).map(nativeId) : [])];
    if (!ids.length) return { kind: 'absent' as const };
    if (ids.length !== 1 || operation.imageId && ids[0] !== operation.imageId) return {
      kind: 'failed' as const, code: 'resource_mismatch', nativeOperationRef: reference(operation),
    };
    const inspected: unknown = JSON.parse(text(await run(['image', 'inspect', ids[0]!])));
    if (!Array.isArray(inspected) || inspected.length !== 1 || nativeId(record(inspected[0]).Id) !== ids[0])
      return unknown(operation);
    const labels = record(record(record(inspected[0]).Config).Labels);
    if (labels[operationLabel] !== operation.operationId || labels[providerLabel] !== providerIdentity) return {
      kind: 'failed' as const, code: 'prepared_artifact_not_owned', nativeOperationRef: reference(operation),
    };
    if (operation.launch.configuration?.kind !== 'image') return {
      kind: 'failed' as const, code: 'prepared_configuration_unavailable', nativeOperationRef: reference(operation),
    };
    return { kind: 'ready' as const, artifact: reference({ ...operation, imageId: ids[0]!,
      launch: { ...operation.launch, configuration: { ...operation.launch.configuration, image: ids[0]! } } }) };
  }
  return {
    async build(id: string, query: PreparationInput) {
      const operation = devcontainerPreparationOperation(id, query);
      const source = query.launch.configuration;
      // Authored file/inline builds need a qualified clean build context. Do not
      // copy the workspace or turn them into a plain image and lose their hooks.
      if (source?.kind !== 'image') return { kind: 'refused' as const, code: 'prepared_configuration_unavailable' };
      let directory: string | undefined;
      try {
        // Recover an acknowledged image or a lost build reply before another build.
        const retained = await inspectNative(operation);
        if (retained.kind === 'ready' || retained.kind === 'unknown') return retained;
        if (retained.kind === 'failed') return { kind: 'refused' as const, code: retained.code };
        // A user-created tag collision must never be overwritten by preparation.
        const named = await inspectNative(operation, true);
        if (named.kind === 'ready' || named.kind === 'unknown') return named;
        if (named.kind === 'failed') return { kind: 'refused' as const, code: named.code };
        directory = await mkdtemp(join(tmpdir(), 'happier-prepared-image-'));
        directory = await canonicalizePath(directory);
        const dockerfile = [`FROM ${source.image}`];
        for (const file of query.cli.files) {
          const target = await canonicalizePath(join(directory, file.path));
          if (target === directory || !isCanonicalAbsolutePathInsideRoot(directory, target))
            return { kind: 'refused' as const, code: 'invalid_request' };
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(file.contentsBase64, 'base64'));
          dockerfile.push(`COPY ${JSON.stringify([file.path, '/opt/happier-build/' + file.path])}`);
        }
        const contextDirectory = query.cli.files.length ? '/opt/happier-build' : '';
        // Preserve the base USER and WORKDIR. Only installation runs as root;
        // an image without root/passwordless sudo fails visibly and stays cold.
        const command = ['sh', '-c', 'if [ "$(id -u)" = 0 ]; then exec "$@"; else exec sudo -n -- "$@"; fi',
          'happier-prepare', 'sh', '-c', 'set -e\nif [ -n "$1" ]; then trap \'rm -rf -- "$1"\' EXIT; fi\n'
            + buildMachineProvisionerPreparationInstallScript({ cli: query.cli, stageDirectory: contextDirectory || undefined,
              readableRoot: DEVCONTAINER_PREPARATION_HOME, setupScript: query.setupScript }),
            'happier-build', contextDirectory];
        dockerfile.push(`RUN ${JSON.stringify(command)}`);
        // Only the setup owner's classified script is baked. Authored launch
        // setup may require the mounted workspace or credentials and stays cold.
        const hostNetwork = await devcontainerImageNeedsHostDns(source.image, args => run(args));
        const built = await run(['build', '--force-rm', '--tag', nativeName(operation),
          '--label', `${operationLabel}=${id}`, '--label', `${providerLabel}=${providerIdentity}`,
          ...(hostNetwork ? ['--network', 'host'] : []),
          '--file', '-', directory], Buffer.from(dockerfile.join('\n') + '\n'), true);
        if (!completed(built)) return unknown(operation, 'native_build_failed');
        const inspected = await inspectNative(operation);
        if (inspected.kind === 'ready' || inspected.kind === 'unknown') return inspected;
        return unknown(operation, inspected.kind === 'failed' ? inspected.code : 'native_build_unconfirmed');
      } catch { return unknown(operation); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    },
    async inspect(operation: PreparationOperation) {
      try { return await inspectNative(operation); } catch { return unknown(operation); }
    },
    async destroy(operation: PreparationOperation) {
      try {
        const observed = await inspectNative(operation);
        if (observed.kind === 'absent') return { kind: 'confirmed' as const };
        if (observed.kind === 'unknown') return observed;
        if (observed.kind === 'failed') return { kind: 'refused' as const, code: observed.code };
        const owned = observed.artifact.value;
        // No force: running consumers keep their image. No prune: source and
        // untagged parent images are outside this operation's ownership.
        if (!completed(await run(['image', 'rm', '--no-prune', '--', owned.imageId]))) return unknown(owned);
        const remaining = await inspectNative(owned);
        if (remaining.kind === 'absent') return { kind: 'confirmed' as const };
        if (remaining.kind === 'unknown') return remaining;
        return { kind: 'pending' as const, nativeOperationRef: reference(owned) };
      } catch { return unknown(operation); }
    },
  };
}
