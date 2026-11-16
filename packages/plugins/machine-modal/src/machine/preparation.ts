import type { App, Image, ModalClient, SandboxCreateParams } from 'modal';
import { defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas,
  projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { MODAL_CONTRIBUTION_REF } from './roles.js';
import { MODAL_PREPARATION_HOME, ModalLaunchV1Schema, hasExactModalCpuEncoding } from './schemas.js';

const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
const closed = { policy: 'closed' } as const;
export const ModalPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(ModalLaunchV1Schema);
export const ModalPreparationOperationSchema = defineProtocolObject({ operationId: text, launch: ModalLaunchV1Schema,
  appId: text.optional(), sandboxId: text.optional(), imageId: text.optional() }, closed);
export const ModalPreparedArtifactSchema = defineProtocolObject({ operationId: text, appId: text, sandboxId: text,
  imageId: text, launch: ModalLaunchV1Schema }, closed);
export const MODAL_PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: ModalPreparationInputSchema,
  launch: ModalLaunchV1Schema, artifact: ModalPreparedArtifactSchema, nativeOperation: ModalPreparationOperationSchema });
type OperationValue = ProtocolSchemaOutput<typeof ModalPreparationOperationSchema>;
type Operation = { -readonly [Key in keyof OperationValue]: OperationValue[Key] };
type BuildInput = ProtocolSchemaOutput<typeof ModalPreparationInputSchema>;
type BuildResult = ReturnType<typeof MODAL_PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof MODAL_PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof MODAL_PREPARATION_SCHEMAS.destroyResult.parse>;
type NativeSandbox = Awaited<ReturnType<ModalClient['sandboxes']['create']>>;
type BuildSandbox = Pick<NativeSandbox, 'sandboxId' | 'poll' | 'terminate' | 'experimentalGetExitSnapshot'> & {
  readonly filesystem: Pick<NativeSandbox['filesystem'], 'writeBytes'>;
  readonly stdin: Pick<NativeSandbox['stdin'], 'writeBytes' | 'close'>;
};
export interface ModalPreparationClient {
  readonly apps: Pick<ModalClient['apps'], 'fromName'>;
  readonly images: Pick<ModalClient['images'], 'fromRegistry' | 'fromId' | 'delete'>;
  readonly sandboxes: {
    create(app: App, image: Image, input: SandboxCreateParams): Promise<BuildSandbox>;
    fromId(id: string): Promise<BuildSandbox>;
  };
  listBuilds(appId: string, operationId: string): AsyncIterable<BuildSandbox>;
}

/** modal@0.11.0 (8f5ea792), sandboxList native schema has includeFinished.
 * The convenience list hardcodes false and loses a completed build after a
 * dropped create response. Keep this version-pinned transport adaptation here. */
export function createModalPreparationClient(client: ModalClient): ModalPreparationClient {
  return { apps: client.apps, images: client.images, sandboxes: client.sandboxes,
    async *listBuilds(appId, operationId) {
      let beforeTimestamp: number | undefined;
      for (;;) {
        const request = { appId, includeFinished: true, tags: [{ tagName: 'happier.prepare-id', tagValue: operationId }],
          ...(beforeTimestamp === undefined ? {} : { beforeTimestamp }) };
        const page = await (client.profile.sandboxV2 ? client.cpClient.sandboxListV2(request) : client.cpClient.sandboxList(request));
        if (!page.sandboxes.length) return;
        for (const sandbox of page.sandboxes) yield await client.sandboxes.fromId(sandbox.id);
        beforeTimestamp = page.sandboxes[page.sandboxes.length - 1]!.createdAt;
      }
    } };
}
const ref = <T>(value: T) => ({ contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1, value });
function named(error: unknown, name: string) { return error instanceof Error && error.name === name; }
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
class PreparationIdentityMismatch extends Error {}
function buildPayload(operationId: string, input: BuildInput) {
  const prefix = '/tmp/.happier-preparation-' + encodeURIComponent(operationId);
  const scriptPath = prefix + '.sh';
  const payloadPaths = input.cli.files.map((_, index) => prefix + '-' + index);
  const files = input.cli.files.map((file, index) => 'mkdir -p -- ' + quote(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.')
    + '\nmv -- ' + quote(payloadPaths[index]!) + ' ' + quote(file.path)).join('\n');
  const cleanup = 'rm -rf -- "$stage" ' + [...payloadPaths, scriptPath].map(quote).join(' ');
  const install = 'sh -c "$1" && chmod -R a+rX ' + MODAL_PREPARATION_HOME + ' && sh -c "$2"';
  const script = 'set -eu\nstage=$(mktemp -d)\ntrap ' + quote(cleanup) + ' EXIT\n'
    + '[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]\ncd -- "$stage"\n' + files + '\n'
    + 'sh -c ' + quote('if [ "$(id -u)" = 0 ]; then exec "$@"; else exec sudo -n -- "$@"; fi')
    + ' happier-install sh -c ' + quote(install) + ' happier-cli ' + quote(input.cli.installScript)
    + ' ' + quote(input.setupScript ?? '') + '\n';
  // The main process waits for atomic native file uploads. Only the small
  // script pathname enters stdin/argv; CLI archives never enter exec arguments.
  const command = ['sh', '-c', 'IFS= read -r script && [ "$script" = "$1" ] && exec sh "$script"', 'happier-prepare', scriptPath];
  return { command, scriptPath, script, payloadPaths };
}

/** Native exit snapshots retain image identity on the source Sandbox, including
 * across process restarts. No manual snapshot/publication response gap, enrolled
 * guest, named-image registry, freshness decision or background poller exists.
 * Vendor retention is 30 days: https://modal.com/docs/guide/sandbox-exit-snapshots */
export function createModalPreparationRoles(client: ModalPreparationClient, signal?: AbortSignal) {
  const unknown = (operation: Operation, code: string) => ({ kind: 'unknown' as const, code, nativeOperationRef: ref(operation) });
  const pending = (operation: Operation) => ({ kind: 'pending' as const, nativeOperationRef: ref(operation) });
  const failure = (error: unknown, operation: Operation, code: string) => projectMachineProvisionerActionFailure(error,
    () => error instanceof PreparationIdentityMismatch ? { kind: 'refused' as const, code: 'modal_preparation_identity_mismatch' }
      : unknown(operation, code));
  async function locate(operation: Operation) {
    const app = await client.apps.fromName(operation.launch.appReference.trim(), { createIfMissing: false });
    if (operation.appId !== undefined && operation.appId !== app.appId) throw new PreparationIdentityMismatch();
    operation.appId = app.appId;
    // A retained ID alone does not prove this App/operation owns the source.
    // Use the same native scoped inventory for retained and lost-response paths.
    let found: BuildSandbox | undefined;
    for await (const sandbox of client.listBuilds(app.appId, operation.operationId)) {
      if (found || operation.sandboxId !== undefined && operation.sandboxId !== sandbox.sandboxId) throw new PreparationIdentityMismatch();
      found = sandbox;
    }
    if (found) operation.sandboxId = found.sandboxId;
    return found;
  }
  async function observe(operation: Operation, sandbox: BuildSandbox): Promise<Exclude<InspectResult, { kind: 'absent' }>> {
    const exit = await sandbox.poll();
    if (exit === null) return pending(operation);
    if (exit !== 0) return { kind: 'failed', code: 'modal_preparation_setup_failed', nativeOperationRef: ref(operation) };
    try {
      const image = await sandbox.experimentalGetExitSnapshot({ timeoutMs: 0 });
      operation.imageId = image.imageId;
      await client.images.fromId(image.imageId);
      return { kind: 'ready', artifact: ref({ ...operation, appId: operation.appId!, sandboxId: sandbox.sandboxId,
        imageId: image.imageId, launch: { ...operation.launch, preparedImageId: image.imageId } }) };
    } catch (error) {
      if (named(error, 'TimeoutError')) return pending(operation);
      if (named(error, 'SnapshotCreationError') || named(error, 'NotFoundError')) return { kind: 'failed',
        code: named(error, 'NotFoundError') ? 'modal_preparation_image_absent' : 'modal_preparation_snapshot_failed', nativeOperationRef: ref(operation) };
      throw error;
    }
  }
  return {
    async prepareBuild(raw: unknown): Promise<BuildResult> {
      const { operationId, input } = MODAL_PREPARATION_SCHEMAS.buildInput.parse(raw);
      const launch = input.launch.choices;
      const operation: Operation = { operationId, launch };
      if (!hasExactModalCpuEncoding(launch.resources.cpu)) return { kind: 'refused', code: 'modal_launch_invalid' };
      if (signal?.aborted) return { kind: 'refused', code: 'modal_operation_cancelled' };
      try {
        const app = await client.apps.fromName(launch.appReference.trim(), { createIfMissing: false });
        operation.appId = app.appId;
        signal?.throwIfAborted();
        const payload = buildPayload(operationId, input);
        // Always start from the reviewed registry base, never from a live guest
        // or a prepared image that may contain a different operation's state.
        const sandbox = await client.sandboxes.create(app, client.images.fromRegistry(launch.imageReference.trim()), {
          cpu: launch.resources.cpu, memoryMiB: launch.resources.memoryMb, timeoutMs: launch.timeoutMs,
          command: payload.command, experimentalOptions: { enable_exit_snapshot: true },
          tags: { 'happier.prepare-id': operationId },
        });
        operation.sandboxId = sandbox.sandboxId;
        if (signal?.aborted) return unknown(operation, 'modal_operation_cancelled');
        for (const [index, file] of input.cli.files.entries()) {
          signal?.throwIfAborted();
          await sandbox.filesystem.writeBytes(Buffer.from(file.contentsBase64, 'base64'), payload.payloadPaths[index]!);
        }
        signal?.throwIfAborted();
        await sandbox.filesystem.writeBytes(Buffer.from(payload.script), payload.scriptPath);
        signal?.throwIfAborted();
        await sandbox.stdin.writeBytes(Buffer.from(payload.scriptPath + '\n'));
        await sandbox.stdin.close();
        if (signal?.aborted) return unknown(operation, 'modal_operation_cancelled');
        const result = await observe(operation, sandbox);
        return result.kind === 'failed' ? { ...result, kind: 'unknown' } : result;
      } catch (error) { return failure(error, operation, 'modal_preparation_build_unconfirmed'); }
    },
    async prepareInspect(raw: unknown): Promise<InspectResult> {
      const parsed = MODAL_PREPARATION_SCHEMAS.inspectInput.parse(raw);
      const operation = 'nativeOperation' in parsed ? { ...ModalPreparationOperationSchema.parse(parsed.nativeOperation.value) }
        : { operationId: parsed.operationId, launch: parsed.launch };
      try {
        signal?.throwIfAborted();
        const sandbox = await locate(operation);
        // Missing inventory cannot prove that an uncertain create did not run.
        return sandbox ? await observe(operation, sandbox) : unknown(operation, 'modal_preparation_build_unconfirmed');
      } catch (error) {
        const result = await failure(error, operation, 'modal_preparation_read_unconfirmed');
        return result.kind === 'refused' ? unknown(operation, result.code) : result;
      }
    },
    async prepareDestroy(raw: unknown): Promise<DestroyResult> {
      const parsed = MODAL_PREPARATION_SCHEMAS.destroyInput.parse(raw);
      const operation = { ...ModalPreparationOperationSchema.parse(parsed.artifact?.value ?? parsed.nativeOperation?.value) };
      try {
        signal?.throwIfAborted();
        const sandbox = await locate(operation);
        if (!sandbox) return unknown(operation, 'modal_preparation_build_unconfirmed');
        if (await sandbox.poll() === null) {
          await sandbox.terminate();
          if (await sandbox.poll() === null) return pending(operation);
        }
        {
          try {
            const image = await sandbox.experimentalGetExitSnapshot({ timeoutMs: 0 });
            if (operation.imageId !== undefined && operation.imageId !== image.imageId) throw new PreparationIdentityMismatch();
            operation.imageId = image.imageId;
          }
          catch (error) {
            if (named(error, 'TimeoutError')) return pending(operation);
            if (named(error, 'SnapshotCreationError') && operation.imageId === undefined) return { kind: 'confirmed' };
            throw error;
          }
        }
        try { await client.images.delete(operation.imageId); }
        catch (error) { if (!named(error, 'NotFoundError')) throw error; }
        try { await client.images.fromId(operation.imageId); return pending(operation); }
        catch (error) { if (named(error, 'NotFoundError')) return { kind: 'confirmed' }; throw error; }
      } catch (error) { return failure(error, operation, 'modal_preparation_delete_unconfirmed'); }
    },
  };
}
