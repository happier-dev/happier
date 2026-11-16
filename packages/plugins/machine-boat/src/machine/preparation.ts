import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';
import * as mini from 'zod/mini';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { decodeBase64, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { BoatSavedSnapshotSchema, createBoatNativeClient, createBoatNativeRequest } from './nativeClient.js';
import { BoatLaunchV1Schema, BoatNativeError, isBoatAdmissionRefusalCode, parseBoatValue, type BoatLaunchV1 } from './schemas.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1 });
const sandboxId = defineProtocolString({ pattern: '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$' });
const snapshotName = defineProtocolString({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$' });
export const BOAT_PREPARATION_HOME = '/opt/happier';
// A live fork can contain enrollment material. Native named base images and
// blank guests remain usable, without inspecting or copying signed-in guests.
export const supportsBoatPreparationSource = (source: BoatLaunchV1['source']) => source.kind !== 'fork';
export const BoatPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(BoatLaunchV1Schema);
export const BoatPreparationOperationSchema = defineProtocolObject({ name: snapshotName, managedId: text,
  launch: BoatLaunchV1Schema, sandboxId: sandboxId.optional() }, closed);
export const BoatPreparedArtifactSchema = defineProtocolObject({ name: snapshotName, sourceSandboxId: sandboxId,
  snapshotId: text, managedId: text, launch: BoatLaunchV1Schema }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: BoatPreparationInputSchema,
  launch: BoatLaunchV1Schema, artifact: BoatPreparedArtifactSchema, nativeOperation: BoatPreparationOperationSchema });
type Input = ProtocolSchemaOutput<typeof BoatPreparationInputSchema>;
type Operation = ProtocolSchemaOutput<typeof BoatPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof BoatPreparedArtifactSchema>;
type Inspect = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type Build = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type Destroy = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const reference = <T>(value: T) => ({ contributionRef: { pluginId: 'happier.machine.boat', localId: 'boat' }, schemaVersion: 1, value });
const pending = (value: Operation) => ({ kind: 'pending' as const, nativeOperationRef: reference(value) });
const unknown = (value: Operation, code: string) => ({ kind: 'unknown' as const, code, nativeOperationRef: reference(value) });
const nativeSnapshot = mini.object({ ok: mini.literal(true), snapshot: BoatSavedSnapshotSchema });
const upload = mini.object({ ok: mini.literal(true), url: mini.url(), path: mini.string(), method: mini.literal('PUT') });
const started = mini.object({ ok: mini.literal(true), success: mini.literal(true), processId: mini.number().check(mini.int(), mini.positive()) });
const commandStatus = mini.object({ ok: mini.literal(true), processId: mini.number(), status: mini.enum(['running', 'exited', 'lost']),
  running: mini.boolean(), exitCode: mini.nullable(mini.number()) });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const operationFor = (operationId: string, launch: BoatLaunchV1): Operation => ({
  // Boat's native name ceiling is 63 characters; retain the rest of the identity
  // in the sandbox's existing managed label, shared with acquire recovery.
  name: 'happier-prepared-' + computeSha256HexDigest(text.parse(operationId)).slice(0, 46), managedId: operationId, launch,
});

/** Boat Public API v1, OpenAPI 1.0.0 (2026-11-15). Native names are retained
 * independently of executor lifetime. No pairing, daemon or account material
 * enters a build guest; the ordinary preparation owner supplies CLI/setup. */
export function createBoatPreparationClient(request: typeof fetch, signal: AbortSignal | undefined,
  wait: () => Promise<void>, uploadFetch: typeof fetch = fetch) {
  const options = { fetch: request, signal };
  const native = createBoatNativeClient(options), http = createBoatNativeRequest(options);
  const effect = (path: string, body: unknown) => http(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function pause() { signal?.throwIfAborted(); await wait(); signal?.throwIfAborted(); }
  function failure(error: unknown, operation: Operation, fallback: string) {
    return projectMachineProvisionerActionFailure(error, () => unknown(operation, signal?.aborted || error instanceof DOMException && error.name === 'AbortError'
      ? 'cancelled' : error instanceof BoatNativeError ? error.code : fallback));
  }
  async function locate(operation: Operation): Promise<Operation> {
    if (operation.sandboxId) return operation;
    const found = await native.reconcileAcquire({ kind: 'acquire', idempotencyKey: operation.managedId });
    if (found.kind === 'bound') return { ...operation, sandboxId: found.resource.sandboxId };
    if (found.kind === 'unknown' && found.code === 'native_identity_unavailable') return operation;
    throw new BoatNativeError(found.kind === 'unknown' || found.kind === 'refused' ? found.code : 'boat_builder_identity_unconfirmed');
  }
  async function read(operation: Operation) {
    try {
      const result = parseBoatValue(nativeSnapshot, await http('/saved-snapshots/' + encodeURIComponent(operation.name))).snapshot;
      if (result.name !== operation.name || operation.sandboxId !== undefined && result.sourceSandboxId !== operation.sandboxId) {
        throw new BoatNativeError('boat_snapshot_identity_mismatch');
      }
      return result;
    } catch (error) {
      if (error instanceof BoatNativeError && error.code === 'native_not_found') return null;
      throw error;
    }
  }
  async function inspectOperation(raw: Operation): Promise<Inspect> {
    let operation = raw;
    try {
      operation = await locate(operation);
      const snapshot = await read(operation);
      if (snapshot) {
        operation = { ...operation, sandboxId: snapshot.sourceSandboxId };
        if (snapshot.status === 'failed') return { kind: 'failed', code: 'boat_snapshot_failed', nativeOperationRef: reference(operation) };
        if (snapshot.status === 'saving') return pending(operation);
        if (!snapshot.snapshotId) return unknown(operation, 'native_response_invalid');
        return { kind: 'ready', artifact: reference({ name: operation.name, managedId: operation.managedId,
          sourceSandboxId: snapshot.sourceSandboxId, snapshotId: snapshot.snapshotId,
          launch: { ...operation.launch, source: { kind: 'named-snapshot', name: operation.name } } }) };
      }
      if (!operation.sandboxId) return { kind: 'absent' };
      const guest = await native.inspect({ sandboxId: operation.sandboxId });
      if (guest.kind === 'absent') return { kind: 'absent' };
      if (guest.kind === 'failed') return { kind: 'failed', code: 'boat_builder_failed', nativeOperationRef: reference(operation) };
      return pending(operation);
    } catch (error) { return failure(error, operation, 'boat_snapshot_read_unconfirmed'); }
  }
  async function cleanupGuest(operation: Operation, waitForAbsence = false) {
    if (!operation.sandboxId) return true;
    const resource = { sandboxId: operation.sandboxId };
    if ((await native.inspect(resource)).kind === 'absent') return true;
    const deletion = await native.destroy({ resource });
    // Accepted deletion is insufficient: retain cleanup custody until exact
    // resource absence is observed, including delayed native deletion.
    for (;;) {
      if ((await native.inspect(resource)).kind === 'absent') return true;
      const progress = await native.reconcileDestroy(deletion.operation);
      if (progress.kind === 'failed') throw new BoatNativeError(progress.code);
      if (!waitForAbsence) return false;
      await pause();
    }
  }
  async function build(input: { operationId: string; input: Input }): Promise<Build> {
    const definition = BoatPreparationInputSchema.parse(input.input);
    if (!supportsBoatPreparationSource(definition.launch.choices.source)) return { kind: 'refused', code: 'boat_preparation_source_unsupported' };
    let operation = operationFor(input.operationId, definition.launch.choices);
    try {
      const created = await native.acquire({ launch: operation.launch, idempotencyKey: operation.managedId });
      if (created.kind === 'refused') return { kind: 'refused', code: created.code };
      if (created.kind !== 'bound') return unknown(operation, created.kind === 'unknown' ? created.code : 'boat_builder_create_unconfirmed');
      operation = { ...operation, sandboxId: created.resource.sandboxId };
      for (;;) {
        const observed = await native.inspect(created.resource);
        if (observed.kind === 'present' && observed.power === 'running') break;
        if (observed.kind === 'failed' || observed.kind === 'absent') return unknown(operation, 'boat_builder_failed');
        if (observed.kind !== 'pending') return unknown(operation, 'boat_builder_unavailable');
        await pause();
      }
      const directory = '/tmp/' + operation.name;
      for (const file of definition.cli.files) {
        signal?.throwIfAborted();
        const path = directory + '/' + file.path;
        const target = parseBoatValue(upload, await effect('/sandboxes/' + operation.sandboxId + '/files/upload-url', { path }));
        if (target.path !== path) throw new BoatNativeError('boat_upload_identity_mismatch');
        // Boat's native file body API is limited to 5 MiB. Its signed upload URL
        // accepts raw bytes without a size ceiling or account Authorization.
        const uploaded = await uploadFetch(target.url, { method: 'PUT', signal, redirect: 'error', body: decodeBase64(file.contentsBase64) });
        if (!uploaded.ok) throw new BoatNativeError('boat_upload_failed');
      }
      const script = 'set -eu\n' + (definition.cli.files.length ? 'cd -- ' + quote(directory) + '\n' : '')
        + 'sh -c ' + quote(definition.cli.installScript) + '\nchmod -R a+rX ' + BOAT_PREPARATION_HOME + '\nsh -c ' + quote(definition.setupScript ?? '')
        + '\nrm -rf -- ' + quote(directory) + '\n';
      // Native detached execution has no synchronous 600s command deadline.
      // Only this install effect needs root; setup does not enroll a Machine.
      const command = 'sudo -n sh -c ' + quote(script);
      const process = parseBoatValue(started, await effect('/sandboxes/' + operation.sandboxId + '/commands', { command, detached: true }));
      for (;;) {
        const result = parseBoatValue(commandStatus, await http('/sandboxes/' + operation.sandboxId + '/commands/' + process.processId));
        if (result.processId !== process.processId) throw new BoatNativeError('boat_command_identity_mismatch');
        if (result.status === 'lost') return unknown(operation, 'boat_setup_lost');
        if (result.status === 'exited') {
          if (result.running || result.exitCode !== 0) return unknown(operation, 'boat_setup_failed');
          break;
        }
        await pause();
      }
      const submitted = parseBoatValue(nativeSnapshot, await effect('/saved-snapshots', { name: operation.name, sandboxId: operation.sandboxId }));
      if (submitted.snapshot.name !== operation.name || submitted.snapshot.sourceSandboxId !== operation.sandboxId) throw new BoatNativeError('boat_snapshot_identity_mismatch');
      for (;;) {
        const result = await inspectOperation(operation);
        if (result.kind === 'ready') { await cleanupGuest(operation, true); return result; }
        if (result.kind === 'failed') return unknown(operation, result.code);
        if (result.kind !== 'pending') return result.kind === 'absent' ? unknown(operation, 'boat_snapshot_absent') : result;
        await pause();
      }
    } catch (error) { return failure(error, operation, 'boat_snapshot_build_unconfirmed'); }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: BoatLaunchV1 }): Promise<Inspect> {
    const operation = 'nativeOperation' in input ? BoatPreparationOperationSchema.parse(input.nativeOperation) : operationFor(input.operationId, input.launch);
    const result = await inspectOperation(operation);
    if (result.kind !== 'ready') return result;
    const retained = { ...operation, sandboxId: result.artifact.value.sourceSandboxId };
    try {
      const guest = await native.inspect({ sandboxId: retained.sandboxId });
      // Recovery is read-only. A new admitted Retry deletes these leftovers
      // before rebuilding; a completed source-absent snapshot can be adopted.
      return guest.kind === 'absent' ? result : { kind: 'failed', code: 'boat_builder_cleanup_required', nativeOperationRef: reference(retained) };
    } catch (error) { return failure(error, retained, 'boat_snapshot_read_unconfirmed'); }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<Destroy> {
    const artifact = input.artifact && BoatPreparedArtifactSchema.parse(input.artifact);
    let operation = artifact ? { name: artifact.name, managedId: artifact.managedId, launch: artifact.launch, sandboxId: artifact.sourceSandboxId }
      : BoatPreparationOperationSchema.parse(input.nativeOperation);
    try {
      operation = await locate(operation);
      const before = await read(operation);
      if (before) {
        if (artifact && before.snapshotId !== artifact.snapshotId) throw new BoatNativeError('boat_snapshot_identity_mismatch');
        if (before.status === 'saving') return pending(operation);
        operation = { ...operation, sandboxId: before.sourceSandboxId };
        await http('/saved-snapshots/' + encodeURIComponent(operation.name), { method: 'DELETE' });
        if (await read(operation) !== null) return pending(operation);
      }
      return await cleanupGuest(operation) ? { kind: 'confirmed' } : pending(operation);
    } catch (error) {
      if (error instanceof BoatNativeError && (error.code === 'boat_snapshot_identity_mismatch' || isBoatAdmissionRefusalCode(error.code))) return { kind: 'refused', code: error.code };
      return failure(error, operation, 'boat_snapshot_delete_unconfirmed');
    }
  }
  return { build, inspect, destroy };
}
