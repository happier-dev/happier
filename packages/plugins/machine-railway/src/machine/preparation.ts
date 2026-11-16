import { decodeBase64, encodeBase64, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createRailwayNativeClient, NativeError } from './nativeClient.js';
import { RailwayLaunchSchema, RailwayResourceSchema, reference, type RailwayLaunch, type RailwayResource } from './schemas.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const RAILWAY_PREPARATION_HOME = '/opt/happier';
export const RailwayPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(RailwayLaunchSchema);
export const RailwayPreparationOperationSchema = defineProtocolObject({ operationId: text, environmentId: text,
  sandboxId: text.optional(), checkpointId: text.optional(), checkpointKey: text.optional() }, closed);
export const RailwayPreparedArtifactSchema = defineProtocolObject({ operationId: text, environmentId: text,
  checkpointId: text, checkpointKey: text, launch: RailwayLaunchSchema }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: RailwayPreparationInputSchema,
  launch: RailwayLaunchSchema, artifact: RailwayPreparedArtifactSchema, nativeOperation: RailwayPreparationOperationSchema });
type BuildInput = ProtocolSchemaOutput<typeof RailwayPreparationInputSchema>;
type Operation = ProtocolSchemaOutput<typeof RailwayPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof RailwayPreparedArtifactSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;

// Railway SDK 3.17.0 sandbox.graphql: checkpoints have a public restore key and
// a distinct native deletion id. Never delete the shared hash-based recipe cache.
export function createRailwayPreparationClient(request: typeof fetch, signal?: AbortSignal) {
  const native = createRailwayNativeClient(request, signal);
  const prefix = (operationId: string) => 'happier-prepared-' + encodeBase64(new TextEncoder().encode(operationId))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') + '.';
  const resource = (operation: Operation): RailwayResource => RailwayResourceSchema.parse({
    environmentId: operation.environmentId, sandboxId: operation.sandboxId, managedId: operation.operationId,
  });
  const unknown = (operation: Operation, code: string) => ({ kind: 'unknown' as const, code, nativeOperationRef: reference(operation) });
  function failure(error: unknown, operation: Operation, fallback: string) {
    return projectMachineProvisionerActionFailure(error, () => {
      if (error instanceof NativeError && (error.code === 'railway_checkpoint_identity_mismatch'
        || error.status !== undefined && error.status >= 400 && error.status < 500)) return operation.sandboxId ? unknown(operation, error.code) : { kind: 'refused' as const, code: error.code };
      return unknown(operation, error instanceof NativeError ? error.code : fallback);
    });
  }
  async function ownedCheckpoint(operation: Operation) {
    const checkpoints = await native.listCheckpoints(operation.environmentId);
    const matches = checkpoints.filter(checkpoint => checkpoint.key.startsWith(prefix(operation.operationId)));
    if (matches.length > 1) throw new NativeError('railway_checkpoint_identity_mismatch');
    const checkpoint = matches[0];
    if (!checkpoint) return null;
    if (operation.checkpointId !== undefined && checkpoint.id !== operation.checkpointId
      || operation.checkpointKey !== undefined && checkpoint.key !== operation.checkpointKey) throw new NativeError('railway_checkpoint_identity_mismatch');
    let sandboxId: string;
    try { sandboxId = decodeURIComponent(checkpoint.key.slice(prefix(operation.operationId).length)); }
    catch { throw new NativeError('railway_checkpoint_identity_mismatch'); }
    if (!sandboxId.trim() || operation.sandboxId !== undefined && sandboxId !== operation.sandboxId) throw new NativeError('railway_checkpoint_identity_mismatch');
    return { ...operation, sandboxId, checkpointId: checkpoint.id, checkpointKey: checkpoint.key };
  }
  function ready(operation: Operation & { checkpointId: string; checkpointKey: string }): Extract<InspectResult, { kind: 'ready' }> {
    return { kind: 'ready', artifact: reference({ operationId: operation.operationId, environmentId: operation.environmentId,
      checkpointId: operation.checkpointId, checkpointKey: operation.checkpointKey,
      launch: { environmentId: operation.environmentId, checkpoint: operation.checkpointKey } }) };
  }
  async function removeGuest(operation: Operation, waitForNativeObservation?: () => Promise<void>): Promise<boolean> {
    if (!operation.sandboxId) return false;
    const guest = resource(operation);
    const before = await native.inspect(guest);
    if (before.availability === 'absent') return true;
    if (before.availability !== 'present') throw new NativeError('railway_preparation_guest_read_unconfirmed');
    const deleted = await native.destroy({ resource: guest });
    if (deleted.kind === 'unknown' || deleted.kind === 'refused') throw new NativeError(deleted.code ?? 'railway_preparation_guest_delete_unconfirmed');
    let observed = await native.inspect(guest);
    while (observed.availability === 'present' && waitForNativeObservation) {
      await waitForNativeObservation();
      observed = await native.inspect(guest);
    }
    if (observed.availability === 'unavailable') throw new NativeError('railway_preparation_guest_read_unconfirmed');
    return observed.availability === 'absent';
  }
  async function exec(guest: RailwayResource, argv: readonly string[], failureCode: string) {
    const result = await native.exec({ resource: guest, argv: [...argv] });
    if ('kind' in result || result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0
      || result.termination.requestedBy.kind !== 'none') throw new NativeError(failureCode);
    return new TextDecoder().decode(decodeBase64(result.stdoutBase64));
  }
  async function build(input: { operationId: string; input: BuildInput }, waitForNativeObservation: () => Promise<void>): Promise<BuildResult> {
    const definition = RailwayPreparationInputSchema.parse(input.input);
    let operation: Operation = { operationId: text.parse(input.operationId), environmentId: definition.launch.choices.environmentId };
    try {
      let acquisition = await native.acquire(definition.launch.choices, operation.operationId, allocated => {
        operation = { ...operation, sandboxId: allocated.sandboxId };
      });
      while (acquisition.kind === 'pending') {
        const retained = acquisition.nativeOperationRef.value;
        if (retained.kind !== 'acquire' || !retained.sandboxId) return unknown(operation, 'railway_preparation_create_unconfirmed');
        operation = { ...operation, sandboxId: retained.sandboxId };
        await waitForNativeObservation();
        acquisition = await native.recover(retained);
      }
      if (acquisition.kind === 'rejected') return operation.sandboxId ? unknown(operation, acquisition.code) : { kind: 'refused', code: acquisition.code };
      if (acquisition.kind !== 'bound') return unknown(operation, operation.sandboxId && acquisition.kind === 'unknown' ? acquisition.recovery.reason : 'railway_preparation_create_unconfirmed');
      const guest = acquisition.resource.value;
      operation = { ...operation, sandboxId: guest.sandboxId };
      // preparationGuest advertises Linux/x64. Verify the allocated native guest
      // before transferring or running that target's credential-free payload.
      const platform = (await exec(guest, ['sh', '-c', 'uname -s; uname -m'], 'railway_preparation_guest_unconfirmed')).trimEnd();
      if (platform !== 'Linux\nx86_64') throw new NativeError('railway_preparation_guest_unsupported');
      const directory = (await exec(guest, ['sh', '-c', 'umask 077; mktemp -d'], 'railway_preparation_staging_unconfirmed')).trimEnd();
      if (!directory.startsWith('/') || directory.includes('\n')) throw new NativeError('railway_preparation_staging_unconfirmed');
      for (const file of definition.cli.files) {
        const uploaded = await native.putFile({ resource: guest, guestPath: directory + '/' + file.path, bytesBase64: file.contentsBase64, mode: 0o600 });
        if (uploaded.kind !== 'confirmed') throw new NativeError('railway_preparation_upload_unconfirmed');
      }
      // Each script is a separate shell: an installer that exits must not skip
      // Setup. Remove credential-free staging before capturing the disk.
      await exec(guest, ['sh', '-c', 'set -e\ncd -- "$1"\nsh -c "$2"\nsh -c "$3"\ncd /\nrm -rf -- "$1"\n',
        'happier-prepare', directory, definition.cli.installScript, definition.setupScript ?? ''], 'railway_preparation_setup_failed');
      operation = { ...operation, checkpointKey: prefix(operation.operationId) + encodeURIComponent(guest.sandboxId) };
      const checkpoint = await native.createCheckpoint(guest, operation.checkpointKey!);
      operation = { ...operation, checkpointId: checkpoint.id, checkpointKey: checkpoint.key };
      if (!await removeGuest(operation, waitForNativeObservation)) return unknown(operation, 'railway_preparation_guest_delete_unconfirmed');
      return ready({ ...operation, checkpointId: checkpoint.id, checkpointKey: checkpoint.key });
    } catch (error) { return failure(error, operation, 'railway_preparation_build_unconfirmed'); }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: RailwayLaunch }): Promise<InspectResult> {
    let operation: Operation = 'nativeOperation' in input ? RailwayPreparationOperationSchema.parse(input.nativeOperation)
      : { operationId: text.parse(input.operationId), environmentId: RailwayLaunchSchema.parse(input.launch).environmentId };
    try {
      const checkpoint = await ownedCheckpoint(operation);
      if (checkpoint) {
        operation = checkpoint;
        const guest = await native.inspect(resource(checkpoint));
        if (guest.availability === 'absent') return ready(checkpoint);
        return guest.availability === 'present'
          ? { kind: 'failed', code: 'railway_preparation_guest_cleanup_required', nativeOperationRef: reference(checkpoint) }
          : unknown(checkpoint, 'railway_preparation_guest_read_unconfirmed');
      }
      if (!operation.sandboxId) return unknown(operation, 'railway_preparation_create_unconfirmed');
      const guest = await native.inspect(resource(operation));
      if (guest.availability === 'absent') return { kind: 'absent' };
      return guest.availability === 'present' ? { kind: 'failed', code: 'railway_preparation_interrupted', nativeOperationRef: reference(operation) }
        : unknown(operation, 'railway_preparation_guest_read_unconfirmed');
    } catch (error) {
      const result = await failure(error, operation, 'railway_preparation_read_unconfirmed');
      return result.kind === 'refused' ? unknown(operation, result.code) : result;
    }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    const artifact = input.artifact && RailwayPreparedArtifactSchema.parse(input.artifact);
    let operation: Operation = artifact ? { operationId: artifact.operationId, environmentId: artifact.environmentId,
      checkpointId: artifact.checkpointId, checkpointKey: artifact.checkpointKey }
      : RailwayPreparationOperationSchema.parse(input.nativeOperation);
    try {
      const checkpoint = await ownedCheckpoint(operation);
      if (checkpoint) {
        operation = checkpoint;
        await native.deleteCheckpoint(checkpoint.environmentId, checkpoint.checkpointId);
      }
      // A missing named checkpoint does not prove that a lost guest create did
      // not allocate. Without a native guest identity, keep console recovery.
      if (!operation.sandboxId && !artifact) return unknown(operation, 'railway_preparation_create_unconfirmed');
      const guestAbsent = operation.sandboxId ? await removeGuest(operation) : true;
      const checkpointAbsent = await ownedCheckpoint(operation) === null;
      return guestAbsent && checkpointAbsent ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) { return failure(error, operation, 'railway_preparation_delete_unconfirmed'); }
  }
  return { build, inspect, destroy };
}
