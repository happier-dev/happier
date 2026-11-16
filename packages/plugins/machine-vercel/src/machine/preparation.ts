import { decodeBase64, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';
import { caughtNativeFailure, fail, nativeFailureResult, type VercelNativeFailure } from './nativeFailure.js';
import { createVercelNativeClient } from './nativeClient.js';
import { reference, VercelAcquisitionSchema, VercelLaunchSchema, type VercelLaunch, type VercelResource, type VercelScope } from './schemas.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const VERCEL_PREPARATION_HOME = '/opt/happier';
export const VercelPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(VercelLaunchSchema);
export const VercelPreparationOperationSchema = defineProtocolObject({ acquisition: VercelAcquisitionSchema, launch: VercelLaunchSchema, snapshotId: text.optional() }, closed);
export const VercelPreparedArtifactSchema = defineProtocolObject({ acquisition: VercelAcquisitionSchema, launch: VercelLaunchSchema, snapshotId: text }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: VercelPreparationInputSchema,
  launch: VercelLaunchSchema, artifact: VercelPreparedArtifactSchema, nativeOperation: VercelPreparationOperationSchema });
type Operation = ProtocolSchemaOutput<typeof VercelPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof VercelPreparedArtifactSchema>;
type BuildInput = ProtocolSchemaOutput<typeof VercelPreparationInputSchema>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
// Vercel OpenAPI, retrieved 2026-11-16: v4 nonpersistent named base; v2
// manual session snapshot (stops the session), snapshot read/delete and source.
// A base that stops during setup cannot produce an automatic usable snapshot.
export function createVercelPreparationClient(scope: VercelScope, request: typeof fetch, signal?: AbortSignal, observedAt = Date.now()) {
  const native = createVercelNativeClient(scope, request, signal, observedAt);
  const io = native.preparation;
  const unknown = (operation: Operation, failure: string | VercelNativeFailure): InspectResult & { kind: 'unknown' } => ({
    ...nativeFailureResult(typeof failure === 'string' ? { kind: 'unknown', code: failure } : failure),
    kind: 'unknown', nativeOperationRef: reference(operation),
  });
  function initial(operationId: string, launch: VercelLaunch): Operation {
    return { launch, acquisition: VercelAcquisitionSchema.parse({ kind: 'acquire', ...scope,
      name: 'happier-prepared-' + operationId, managedId: 'prepared-' + operationId }) };
  }
  function failure(error: unknown, operation: Operation, fallback: string) {
    return unknown(operation, caughtNativeFailure(error, fallback));
  }
  function resource(operation: Operation): VercelResource | null {
    const { acquisition } = operation;
    return acquisition.createdAt === undefined ? null : { ...acquisition, createdAt: acquisition.createdAt };
  }
  function classify(operation: Operation, snapshot: { id: string; status: 'created' | 'deleted' | 'failed'; expiresAt?: number }): Extract<InspectResult, { kind: 'ready' | 'failed' }> {
    const retained = { ...operation, snapshotId: snapshot.id };
    if (snapshot.status !== 'created' || snapshot.expiresAt !== undefined && snapshot.expiresAt <= observedAt) {
      return { kind: 'failed', code: 'vercel_snapshot_' + (snapshot.status === 'created' ? 'expired' : snapshot.status), nativeOperationRef: reference(retained) };
    }
    return { kind: 'ready', artifact: reference({ ...retained, launch: { ...operation.launch, snapshotId: snapshot.id } }) };
  }
  async function build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
    const definition = VercelPreparationInputSchema.parse(input.input);
    let operation = initial(input.operationId, definition.launch.choices);
    try {
      // Preparation always starts from the selected clean image, never an
      // enrolled Session or a previously supplied restore snapshot.
      const { snapshotId: _snapshot, ...coldLaunch } = operation.launch;
      const acquired = await native.acquire(coldLaunch, operation.acquisition.managedId, { persistent: false });
      if (acquired.kind === 'rejected') return { ...nativeFailureResult({ ...acquired, kind: 'refused' }), kind: 'refused' };
      if (acquired.kind !== 'bound') return unknown(operation, { ...acquired, kind: 'unknown', code: 'vercel_preparation_create_unconfirmed' });
      const base = acquired.resource.value;
      operation = { ...operation, acquisition: { ...operation.acquisition, createdAt: base.createdAt } };
      const current = await io.read(base);
      if (current.kind !== 'present') return unknown(operation, current.kind === 'absent'
        ? { ...current, kind: 'unknown', code: 'vercel_resource_absent' } : current);
      if (current.value.sandbox.persistent || current.value.sandbox.status !== 'running') return unknown(operation, 'vercel_preparation_base_unavailable');
      await io.guestHome(current.value);
      const directory = '/tmp/happier-prepared-' + encodeURIComponent(input.operationId);
      const mkdir = await io.execute(current.value, ['mkdir', '-p', directory,
        ...definition.cli.files.map(file => directory + '/' + file.path.slice(0, Math.max(0, file.path.lastIndexOf('/')))).filter(path => !path.endsWith('/'))]);
      if (mkdir.exitCode !== 0) fail('vercel_preparation_stage_failed');
      for (const file of definition.cli.files) await io.put(current.value, directory + '/' + file.path, decodeBase64(file.contentsBase64));
      const script = 'set -e\ncd -- "$1"\ntrap \'rm -rf -- "$1"\' EXIT\nsh -c "$2"\nchmod -R a+rX ' + VERCEL_PREPARATION_HOME + '\n';
      const installed = await io.execute(current.value, ['sh', '-c', 'if [ "$(id -u)" = 0 ]; then exec "$@"; else exec sudo -n -- "$@"; fi',
        'happier-prepare', 'sh', '-c', script, 'happier-build', directory, definition.cli.installScript]);
      if (installed.exitCode !== 0) fail('vercel_preparation_cli_install_failed');
      // The composed Setup command runs the root-only typed effect interpreter.
      // Elevate this build effect without changing the restored image's user.
      if (definition.setupScript) {
        const setup = await io.execute(current.value, ['sh', '-c', 'if [ "$(id -u)" = 0 ]; then exec "$@"; else exec sudo -n -- "$@"; fi',
          'happier-prepare', 'sh', '-c', definition.setupScript]);
        if (setup.exitCode !== 0) fail('vercel_preparation_setup_failed');
      }
      signal?.throwIfAborted();
      const snapshot = await io.capture(current.value, operation.launch.snapshotExpirationMs);
      if (snapshot.kind !== 'present') return unknown(operation, snapshot.kind === 'absent'
        ? { ...snapshot, kind: 'unknown', code: 'vercel_snapshot_unconfirmed' } : snapshot);
      const result = classify(operation, snapshot.value);
      return result.kind === 'failed' ? { ...result, kind: 'unknown' } : result;
    } catch (error) { return failure(error, operation, 'vercel_preparation_build_unconfirmed'); }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: VercelLaunch }): Promise<InspectResult> {
    let operation = 'nativeOperation' in input ? VercelPreparationOperationSchema.parse(input.nativeOperation) : initial(input.operationId, input.launch);
    try {
      const base = await io.read(operation.acquisition);
      if (base.kind !== 'present' && base.kind !== 'absent') return unknown(operation, base);
      if (base.kind === 'present') {
        operation = { ...operation, acquisition: { ...operation.acquisition, createdAt: base.value.sandbox.createdAt } };
        if (base.value.sandbox.persistent) return unknown(operation, 'vercel_preparation_base_unavailable');
      }
      const owned = resource(operation);
      if (!owned) {
        const leftovers = await io.snapshots({ ...operation.acquisition, createdAt: 0 });
        if (leftovers.kind !== 'present') return unknown(operation, leftovers);
        return base.kind === 'absent' && leftovers.ids.length === 0
          ? { kind: 'absent' } : unknown(operation, 'vercel_cleanup_unqualified');
      }
      if (!operation.snapshotId) {
        const snapshots = await io.snapshots(owned);
        if (snapshots.kind !== 'present') return unknown(operation, snapshots);
        if (snapshots.ids.length === 0) return base.kind === 'absent' ? { kind: 'absent' }
          : { kind: 'failed', code: 'vercel_preparation_incomplete', nativeOperationRef: reference(operation) };
        if (snapshots.ids.length !== 1) return unknown(operation, 'vercel_cleanup_unqualified');
        operation = { ...operation, snapshotId: snapshots.ids[0] };
      }
      const snapshot = await io.readOwnedSnapshot(owned, operation.snapshotId!);
      return snapshot.kind === 'present' ? classify(operation, snapshot.value) : snapshot.kind === 'absent'
        ? { ...nativeFailureResult({ ...snapshot, kind: 'unknown', code: 'vercel_snapshot_deleted' }), kind: 'failed', nativeOperationRef: reference(operation) }
        : unknown(operation, snapshot);
    } catch (error) { return failure(error, operation, 'vercel_preparation_read_unconfirmed'); }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    let operation = input.artifact ? VercelPreparedArtifactSchema.parse(input.artifact) : VercelPreparationOperationSchema.parse(input.nativeOperation);
    try {
      let base = await io.read(operation.acquisition);
      if (base.kind !== 'present' && base.kind !== 'absent') return base.kind === 'refused'
        ? { ...nativeFailureResult(base), kind: 'refused' } : unknown(operation, base);
      if (base.kind === 'present') {
        operation = { ...operation, acquisition: { ...operation.acquisition, createdAt: base.value.sandbox.createdAt } };
        if (base.value.sandbox.persistent) return { kind: 'refused', code: 'vercel_preparation_base_unavailable' };
      }
      const owned = resource(operation);
      if (!owned) {
        const leftovers = await io.snapshots({ ...operation.acquisition, createdAt: 0 });
        if (leftovers.kind !== 'present') return unknown(operation, leftovers);
        return base.kind === 'absent' && leftovers.ids.length === 0
          ? { kind: 'confirmed' } : unknown(operation, 'vercel_cleanup_unqualified');
      }
      const snapshots = await io.snapshots(owned);
      if (snapshots.kind !== 'present') return unknown(operation, snapshots);
      const ids = [...new Set([...snapshots.ids, ...(operation.snapshotId ? [operation.snapshotId] : [])])];
      // These are operation-owned manual snapshots. Ordinary Machine deletion
      // retains its existing shared-source/orphan policy at native.destroy.
      for (const id of ids) {
        const snapshot = await io.readOwnedSnapshot(owned, id);
        if (snapshot.kind === 'absent' || snapshot.kind === 'present' && snapshot.value.status === 'deleted') continue;
        if (snapshot.kind !== 'present') return unknown(operation, snapshot);
        operation = { ...operation, snapshotId: id };
        const deleted = await io.http('/v2/sandboxes/snapshots/' + encodeURIComponent(id), 'DELETE');
        if (deleted.kind !== 'ok' && deleted.kind !== 'absent') return unknown(operation, deleted);
        const after = await io.readSnapshot(id);
        if (after.kind === 'present' && after.value.status !== 'deleted') return { kind: 'pending', nativeOperationRef: reference(operation) };
        if (after.kind !== 'present' && after.kind !== 'absent') return unknown(operation, after);
      }
      if (base.kind === 'present') {
        const deleted = await io.http('/v2/sandboxes/' + encodeURIComponent(owned.name), 'DELETE', undefined, { projectId: scope.projectId, deleteOrphanSnapshots: 'false' });
        if (deleted.kind !== 'ok' && deleted.kind !== 'absent') return unknown(operation, deleted);
        base = await io.read(owned);
      }
      return base.kind === 'absent' ? { kind: 'confirmed' } : base.kind === 'present'
        ? { kind: 'pending', nativeOperationRef: reference(operation) } : unknown(operation, base);
    } catch (error) { return failure(error, operation, 'vercel_preparation_delete_unconfirmed'); }
  }
  return { build, inspect, destroy };
}
