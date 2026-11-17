import { decodeBase64, defineProtocolLiteral, defineProtocolUnion, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas,
  assertMachineProvisionerGuestCommandSucceeded, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createFreestyleHttp, createFreestyleNativeClient, FREESTYLE_API, NativeError } from './nativeClient.js';
import { FreestyleLaunchSchema, reference, type FreestyleLaunch, type FreestyleResource } from './schemas.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const FREESTYLE_PREPARATION_HOME = '/opt/happier';
export const FreestylePreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(FreestyleLaunchSchema);
export const FreestylePreparationOperationSchema = defineProtocolObject({ name: text, managedId: text, vmId: text.optional(), snapshotId: text.optional(),
  captureRequested: defineProtocolLiteral(true).optional() }, closed);
export const FreestylePreparedArtifactSchema = defineProtocolObject({ name: text, managedId: text, vmId: text.optional(), snapshotId: text, launch: FreestyleLaunchSchema }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: FreestylePreparationInputSchema,
  launch: FreestyleLaunchSchema, artifact: FreestylePreparedArtifactSchema, nativeOperation: FreestylePreparationOperationSchema });
type Operation = ProtocolSchemaOutput<typeof FreestylePreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof FreestylePreparedArtifactSchema>;
type BuildInput = ProtocolSchemaOutput<typeof FreestylePreparationInputSchema>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const snapshotSchema = defineProtocolObject({ id: text, slug: text, sourceVmId: text.nullable().optional(),
  public: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional() }, { policy: 'additive-open/drop' });
const captureSchema = defineProtocolObject({ snapshotId: text, snapshot: snapshotSchema }, { policy: 'additive-open/drop' });

async function operationFor(operationId: string): Promise<Operation> {
  // Native slugs allow 63 [a-z0-9-] characters. Preserve deterministic recovery
  // for arbitrary host operation IDs without stealing/reassigning an existing slug.
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.parse(operationId)));
  const hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const managedId = 'prepared-' + hash.slice(0, 46);
  return { managedId, name: 'happier-' + managedId };
}

// Freestyle v5 / OpenAPI info 0.1.0, observed 2026-11-15. Capture returns a
// fully materialized private snapshot; build VMs are fresh and never enrolled.
export function createFreestylePreparationClient(request: typeof fetch, signal?: AbortSignal) {
  const http = createFreestyleHttp(request, signal);
  const guest = createFreestyleNativeClient(request, signal);
  const snapshotPath = (operation: Operation) => FREESTYLE_API + '/snapshots/' + encodeURIComponent(operation.snapshotId ?? operation.name);
  function failure(error: unknown, operation: Operation, fallback: string) {
    return projectMachineProvisionerActionFailure(error, (): Extract<BuildResult, { kind: 'refused' | 'unknown' }> => {
      const cause = error instanceof NativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {};
      if (error instanceof NativeError && (error.code.endsWith('_identity_mismatch')
        || error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 409)) {
        return { kind: 'refused', code: error.code, ...cause };
      }
      return { kind: 'unknown', code: error instanceof NativeError ? error.code : fallback, nativeOperationRef: reference(operation), ...cause };
    });
  }
  function snapshot(value: unknown, operation: Operation) {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) throw new NativeError('freestyle_snapshot_invalid_response');
    const native = parsed.data;
    if (native.slug !== operation.name || native.public === true
      || operation.snapshotId !== undefined && native.id !== operation.snapshotId
      || operation.vmId !== undefined && native.sourceVmId != null && native.sourceVmId !== operation.vmId) {
      throw new NativeError('freestyle_snapshot_identity_mismatch');
    }
    return native;
  }
  async function readSnapshot(operation: Operation) {
    try { return snapshot(await http(snapshotPath(operation)), operation); }
    catch (error) { if (error instanceof NativeError && error.status === 404) return null; throw error; }
  }
  async function readBuilder(operation: Operation) {
    try { return await guest.readResource(operation); }
    catch (error) { if (error instanceof NativeError && error.status === 404) return null; throw error; }
  }
  // A failed transport does not settle a POST. The vendor has no cancellation
  // status token; immediate 404s must retain the original effect identity.
  const unresolved = (operation: Operation) => operation.snapshotId === undefined
    && (operation.vmId === undefined || operation.captureRequested === true);
  const unconfirmed = (operation: Operation) => ({ kind: 'unknown' as const,
    code: 'freestyle_preparation_effect_unconfirmed', nativeOperationRef: reference(operation) });
  async function deleteBuilder(operation: Operation, known?: FreestyleResource | null): Promise<Operation | null> {
    const before = known === undefined ? await readBuilder(operation) : known;
    if (before === null) return null;
    const retained = { ...operation, vmId: before.vmId };
    try { await http(FREESTYLE_API + '/vms/' + encodeURIComponent(before.vmId), 'DELETE'); }
    catch (error) { if (!(error instanceof NativeError && error.status === 404)) throw error; }
    return await readBuilder(retained) === null ? null : retained;
  }
  async function finish(native: ProtocolSchemaOutput<typeof snapshotSchema>, operation: Operation, builder?: FreestyleResource | null): Promise<Extract<InspectResult, { kind: 'ready' | 'pending' }>> {
    const vmId = operation.vmId ?? native.sourceVmId;
    const retained = { ...operation, snapshotId: native.id, ...(vmId ? { vmId } : {}) };
    if (await deleteBuilder(retained, builder)) return { kind: 'pending', nativeOperationRef: reference(retained) };
    // sourceVmId may disappear after deleting the builder. The exact private
    // operation-owned slug remains the native snapshot's recovery identity.
    return { kind: 'ready', artifact: reference({ name: retained.name, managedId: retained.managedId,
      ...(vmId ? { vmId } : {}), snapshotId: native.id, launch: { snapshotId: native.id } }) };
  }
  async function build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
    const definition = FreestylePreparationInputSchema.parse(input.input);
    let operation = await operationFor(input.operationId);
    try {
      const builder = await guest.createResource(definition.launch.choices, operation.managedId);
      operation = { ...operation, vmId: builder.vmId };
      const execute = async (argv: string[], code: string) => {
        const result = await guest.exec({ resource: builder, argv, inputBase64: '' });
        if (!('termination' in result) || result.termination.observed.kind !== 'exit') throw new NativeError(code);
        assertMachineProvisionerGuestCommandSucceeded({ exitCode: result.termination.observed.exitCode,
          truncated: result.stderrTruncated, stderr: decodeBase64(result.stderrBase64) },
        details => new NativeError(code, undefined, details.nativeCause));
        return result;
      };
      // preparationGuest supplies Linux/x64 to the canonical CLI supplier.
      // A custom base must match that actual native target before install.
      await execute(['sh', '-c', '[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]'], 'freestyle_preparation_guest_unsupported');
      const directory = '/tmp/.' + operation.name;
      await execute(['mkdir', '-p', directory], 'freestyle_preparation_context_failed');
      for (const file of definition.cli.files) {
        const path = directory + '/' + file.path;
        await execute(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))], 'freestyle_preparation_context_failed');
        const result = await guest.putFile({ resource: builder, guestPath: path, bytesBase64: file.contentsBase64, mode: 0o600 });
        if (result.kind !== 'confirmed') throw new NativeError(result.code ?? 'freestyle_preparation_context_failed');
      }
      // Separate shells preserve setup after an install script that exits 0.
      // The supplier owns both scripts; no credential selection/composition here.
      await execute(['sh', '-c', 'set -e\ncd -- "$1"\nsh -c "$2"\nsh -c "$3"\ncd /\nrm -rf -- "$1"',
        'happier-prepare', directory, definition.cli.installScript, definition.setupScript ?? ''], 'freestyle_preparation_setup_failed');
      operation = { ...operation, captureRequested: true };
      const parsed = captureSchema.safeParse(await http(FREESTYLE_API + '/vms/' + encodeURIComponent(builder.vmId) + '/snapshot', 'POST', { slug: operation.name }));
      if (!parsed.success) throw new NativeError('freestyle_snapshot_invalid_response');
      const captured = parsed.data;
      if (captured.snapshotId !== captured.snapshot.id) throw new NativeError('freestyle_snapshot_identity_mismatch');
      return await finish(snapshot(captured.snapshot, operation), operation, builder);
    } catch (error) {
      // Once a build effect may exist, retain its identity even on a later
      // 4xx/identity refusal so the owning operation can clean it up.
      const result = await failure(error, operation, 'freestyle_snapshot_build_unconfirmed');
      return result.kind === 'refused' && (operation.vmId !== undefined || error instanceof NativeError && error.code.endsWith('_identity_mismatch'))
        ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation),
          ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) } : result;
    }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: FreestyleLaunch }): Promise<InspectResult> {
    // The original host operation was persisted before dispatch. After a lost
    // host result its bare ID cannot distinguish create from capture dispatch.
    let operation: Operation = 'nativeOperation' in input ? FreestylePreparationOperationSchema.parse(input.nativeOperation)
      : { ...await operationFor(input.operationId), captureRequested: true };
    try {
      const builder = await readBuilder(operation);
      if (builder) operation = { ...operation, vmId: builder.vmId };
      const native = await readSnapshot(operation);
      if (native) return await finish(native, operation, builder);
      if (unresolved(operation)) return unconfirmed(operation);
      return builder === null ? { kind: 'absent' } : { kind: 'failed', code: 'freestyle_preparation_interrupted', nativeOperationRef: reference(operation) };
    } catch (error) {
      const result = await failure(error, operation, 'freestyle_snapshot_read_unconfirmed');
      return result.kind === 'refused' ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation),
        ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) } : result;
    }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    const artifact = input.artifact && FreestylePreparedArtifactSchema.parse(input.artifact);
    let operation: Operation = artifact ? { name: artifact.name, managedId: artifact.managedId, vmId: artifact.vmId, snapshotId: artifact.snapshotId }
      : FreestylePreparationOperationSchema.parse(input.nativeOperation);
    try {
      const builder = await readBuilder(operation);
      if (builder) operation = { ...operation, vmId: builder.vmId };
      const native = await readSnapshot(operation);
      if (native) {
        operation = { ...operation, snapshotId: native.id };
        try { await http(snapshotPath(operation), 'DELETE'); }
        catch (error) { if (!(error instanceof NativeError && error.status === 404)) throw error; }
      }
      if (await deleteBuilder(operation, builder)) return { kind: 'pending', nativeOperationRef: reference(operation) };
      if (await readSnapshot(operation) !== null) return { kind: 'pending', nativeOperationRef: reference(operation) };
      return unresolved(operation) ? unconfirmed(operation) : { kind: 'confirmed' };
    } catch (error) { return failure(error, operation, 'freestyle_snapshot_delete_unconfirmed'); }
  }
  return { build, inspect, destroy };
}
