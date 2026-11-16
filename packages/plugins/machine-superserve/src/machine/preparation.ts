import { decodeBase64, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { assertMachineProvisionerGuestCommandSucceeded, createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { API_ORIGIN } from '../account.js';
import { createSuperserveNativeClient, superserveSandboxIdentity } from './nativeClient.js';
import { SuperserveLaunchSchema, SuperserveResourceSchema, reference, type SuperserveLaunch, type SuperserveResource } from './schemas.js';
import { createSuperserveHttp, NativeError } from './transport.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const SUPERSERVE_PREPARATION_HOME = '/opt/happier';
export const SuperservePreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(SuperserveLaunchSchema);
export const SuperservePreparationOperationSchema = defineProtocolObject({ name: text, managedId: text,
  seed: SuperserveResourceSchema.optional(), snapshotId: text.optional() }, closed);
export const SuperservePreparedArtifactSchema = defineProtocolObject({ name: text, managedId: text,
  seed: SuperserveResourceSchema, snapshotId: text, launch: SuperserveLaunchSchema }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: SuperservePreparationInputSchema,
  launch: SuperserveLaunchSchema, artifact: SuperservePreparedArtifactSchema, nativeOperation: SuperservePreparationOperationSchema });
type BuildInput = ProtocolSchemaOutput<typeof SuperservePreparationInputSchema>;
type Operation = ProtocolSchemaOutput<typeof SuperservePreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof SuperservePreparedArtifactSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const snapshotSchema = defineProtocolObject({ id: text, sandbox_id: text, name: text, status: text }, { policy: 'additive-open/drop' });
type Snapshot = ProtocolSchemaOutput<typeof snapshotSchema>;
const operationFor = (id: string): Operation => ({ name: 'happier-prepared-' + text.parse(id), managedId: 'prepared-' + id });

// Superserve REST 0.1.0, 2026-11-16: preserve the selected template by preparing
// a fresh, unenrolled seed, then POST /sandboxes/{id}/snapshot. No account env,
// secrets map, Agent credential, pairing or daemon startup is supplied to it.
export function createSuperservePreparationClient(request: typeof fetch, signal?: AbortSignal) {
  const http = createSuperserveHttp(request, signal), native = createSuperserveNativeClient(request, signal);
  function failure(error: unknown, operation: Operation) {
    const nativeError = error instanceof NativeError ? error : undefined;
    return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const,
      code: nativeError?.code ?? 'provider_unavailable', nativeOperationRef: reference(operation),
      ...(nativeError?.nativeCause ? { nativeCause: nativeError.nativeCause } : {}) }));
  }
  function snapshot(value: unknown, operation: Operation): Snapshot {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) throw new NativeError('superserve_invalid_response');
    if (parsed.data.name !== operation.name || !operation.seed
      || superserveSandboxIdentity(parsed.data.sandbox_id) !== superserveSandboxIdentity(operation.seed.sandboxId)
      || operation.snapshotId !== undefined && parsed.data.id !== operation.snapshotId) throw new NativeError('superserve_identity_mismatch');
    return parsed.data;
  }
  async function recoverSeed(operation: Operation): Promise<Operation> {
    if (operation.seed) {
      if (operation.seed.name !== operation.name || operation.seed.managedId !== operation.managedId) throw new NativeError('superserve_identity_mismatch');
      return operation;
    }
    const expected = { kind: 'acquire' as const, name: operation.name, managedId: operation.managedId };
    // The API explicitly accepts status=deleted; saved snapshots outlive their
    // source and the deleted source's scoped snapshot list remains available.
    const seed = await native.findResource(expected) ?? await native.findResource(expected, true);
    return seed ? { ...operation, seed } : operation;
  }
  async function read(operation: Operation): Promise<Snapshot | null> {
    if (!operation.seed) return null;
    if (operation.snapshotId) {
      try { return snapshot((await http(API_ORIGIN + '/snapshots/' + encodeURIComponent(operation.snapshotId))).value, operation); }
      catch (error) { if (error instanceof NativeError && error.status === 404) return null; throw error; }
    }
    const list = (await http(API_ORIGIN + '/sandboxes/' + encodeURIComponent(operation.seed.sandboxId) + '/snapshots')).value;
    if (!Array.isArray(list)) throw new NativeError('superserve_invalid_response');
    // No local pagination cap: omitted native limit returns the scoped full list.
    const matches = list.filter(value => value !== null && typeof value === 'object' && 'name' in value && value.name === operation.name);
    if (matches.length > 1) throw new NativeError('superserve_identity_mismatch');
    return matches.length === 0 ? null : snapshot(matches[0], operation);
  }
  async function retireSeed(seed: SuperserveResource) {
    const before = await native.inspect(seed);
    if (before.availability === 'absent') return true;
    if (before.availability !== 'present') throw new NativeError(before.reason ?? 'provider_unavailable');
    const result = await native.destroy({ resource: seed });
    if (result.kind !== 'confirmed') throw new NativeError('code' in result && result.code ? result.code : 'superserve_delete_unconfirmed');
    const after = await native.inspect(seed);
    if (after.availability === 'unavailable') throw new NativeError(after.reason ?? 'provider_unavailable');
    return after.availability === 'absent';
  }
  function classify(found: Snapshot, operation: Operation): Exclude<InspectResult, { kind: 'absent' }> {
    const retained = { ...operation, snapshotId: found.id };
    if (found.status === 'ready') {
      return { kind: 'ready', artifact: reference({ ...retained, seed: operation.seed!, launch: { snapshot: found.id } }) };
    }
    if (found.status === 'failed') return { kind: 'failed', code: 'superserve_snapshot_failed', nativeOperationRef: reference(retained) };
    if (found.status === 'creating' || found.status === 'deleting') return { kind: 'pending', nativeOperationRef: reference(retained) };
    return { kind: 'unknown', code: 'provider_unavailable', nativeOperationRef: reference(retained) };
  }
  async function build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
    const definition = SuperservePreparationInputSchema.parse(input.input);
    let operation = operationFor(input.operationId);
    // Forks inherit original secret bindings; the build accepts only a fresh
    // template seed, never an arbitrary potentially credential-bearing snapshot.
    if ('snapshot' in definition.launch.choices) return { kind: 'refused', code: 'superserve_preparation_snapshot_base_unsupported' };
    try {
      const acquired = await native.acquire(definition.launch.choices, operation.managedId);
      if (acquired.kind === 'rejected') return { kind: 'refused', code: acquired.code };
      if (acquired.kind !== 'bound') return { kind: 'unknown', code: 'superserve_acquire_unconfirmed', nativeOperationRef: reference(operation) };
      operation = { ...operation, seed: acquired.resource.value };
      const directory = '/tmp/' + operation.name;
      async function exec(argv: string[]) {
        const output = await native.exec({ resource: operation.seed!, argv });
        if (!('termination' in output) || output.termination.observed.kind !== 'exit') throw new NativeError('superserve_preparation_setup_failed');
        assertMachineProvisionerGuestCommandSucceeded({ exitCode: output.termination.observed.exitCode,
          stderr: decodeBase64(output.stderrBase64), truncated: output.stdoutTruncated || output.stderrTruncated },
        details => new NativeError('superserve_preparation_setup_failed', undefined, details.nativeCause));
      }
      await exec(['mkdir', '-p', directory]);
      for (const file of definition.cli.files) {
        const parent = file.path.slice(0, file.path.lastIndexOf('/') + 1);
        if (parent) await exec(['mkdir', '-p', directory + '/' + parent]);
        const written = await native.putFile({ resource: operation.seed!, guestPath: directory + '/' + file.path, bytesBase64: file.contentsBase64 });
        if (written.kind !== 'confirmed') throw new NativeError('code' in written && written.code ? written.code : 'superserve_file_unconfirmed');
      }
      await exec(['sh', '-c', 'set -e\ntrap \'rm -rf -- "$1"\' EXIT\ncd -- "$1"\nsh -c "$2"\nchmod -R a+rX ' + SUPERSERVE_PREPARATION_HOME + '\nsh -c "$3"\n',
        'happier-prepare', directory, definition.cli.installScript, definition.setupScript ?? '']);
      // A running snapshot source continues afterwards. Pause explicitly before
      // capture so retained source storage, rather than active CPU, is billed.
      const paused = await native.power(operation.seed!, 'suspend');
      if (paused.kind !== 'confirmed') throw new NativeError('code' in paused && paused.code ? paused.code : 'superserve_power_unconfirmed');
      const value = (await http(API_ORIGIN + '/sandboxes/' + encodeURIComponent(operation.seed!.sandboxId) + '/snapshot', 'POST',
        { name: operation.name, idempotency_key: operation.managedId })).value;
      const found = snapshot(value, operation);
      operation = { ...operation, snapshotId: found.id };
      const result = classify(found, operation);
      return result.kind === 'failed' ? { ...result, kind: 'unknown' } : result;
    } catch (error) { return failure(error, operation); }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: SuperserveLaunch }): Promise<InspectResult> {
    let operation = 'nativeOperation' in input ? SuperservePreparationOperationSchema.parse(input.nativeOperation) : operationFor(input.operationId);
    try {
      operation = await recoverSeed(operation);
      if (!operation.seed) return { kind: 'absent' };
      const found = await read(operation);
      if (!found) {
        // A seed without a snapshot is an interrupted setup, not a build that
        // can ever become ready by waiting. Keep its cleanup identity.
        if (!operation.snapshotId) return { kind: 'failed', code: 'superserve_preparation_interrupted', nativeOperationRef: reference(operation) };
        const seed = await native.inspect(operation.seed);
        if (seed.availability === 'absent') return { kind: 'absent' };
        if (seed.availability === 'unavailable') throw new NativeError(seed.reason ?? 'provider_unavailable');
        return { kind: 'failed', code: 'superserve_snapshot_absent', nativeOperationRef: reference(operation) };
      }
      operation = { ...operation, snapshotId: found.id };
      return classify(found, operation);
    } catch (error) { return failure(error, operation); }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    let operation: Operation;
    if (input.artifact) {
      const artifact = SuperservePreparedArtifactSchema.parse(input.artifact);
      operation = { name: artifact.name, managedId: artifact.managedId, seed: artifact.seed, snapshotId: artifact.snapshotId };
    } else operation = SuperservePreparationOperationSchema.parse(input.nativeOperation);
    try {
      operation = await recoverSeed(operation);
      if (!operation.seed) return { kind: 'confirmed' };
      const seed = operation.seed;
      const found = await read(operation);
      if (found) {
        operation = { ...operation, snapshotId: found.id };
        if (found.status === 'deleting') return { kind: 'pending', nativeOperationRef: reference(operation) };
        // Native DELETE decides whether an in-flight capture is stale enough
        // to remove; no provider-local age check may make it immortal.
        try { await http(API_ORIGIN + '/snapshots/' + encodeURIComponent(found.id), 'DELETE'); }
        catch (error) {
          if (error instanceof NativeError && error.status === 409 && found.status === 'creating') return { kind: 'pending', nativeOperationRef: reference(operation) };
          if (!(error instanceof NativeError && error.status === 404)) throw error;
        }
        if (await read(operation) !== null) return { kind: 'pending', nativeOperationRef: reference(operation) };
      }
      return await retireSeed(seed) ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) { return failure(error, operation); }
  }
  return { build, inspect, destroy };
}
