import { sleepWithSignal } from '@happier-dev/plugin-sdk/async';
import { decodeBase64, defineProtocolArray, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { assertMachineProvisionerGuestCommandSucceeded, createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure, type MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createUpstashBoxHttpClient, createUpstashBoxNativeClient, readUpstashBoxIdentity, NativeError, UPSTASH_BOX_API } from './nativeClient.js';
import { UpstashBoxLaunchSchema, reference, type UpstashBoxLaunch, type UpstashBoxResource } from './schemas.js';

const closed = { policy: 'closed' } as const;
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
// Upstash's persisted, writable workspace; the prepared binary path is
// carried independently from the runtime guest's credential home.
export const UPSTASH_BOX_PREPARATION_HOME = '/workspace/home';
export const UpstashBoxPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(UpstashBoxLaunchSchema);
export const UpstashBoxPreparationOperationSchema = defineProtocolObject({ managedId: text, launch: UpstashBoxLaunchSchema,
  sourceBoxId: text.optional(), snapshotId: text.optional() }, closed);
export const UpstashBoxPreparedArtifactSchema = defineProtocolObject({ managedId: text, sourceBoxId: text, snapshotId: text, launch: UpstashBoxLaunchSchema }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: UpstashBoxPreparationInputSchema,
  launch: UpstashBoxLaunchSchema, artifact: UpstashBoxPreparedArtifactSchema, nativeOperation: UpstashBoxPreparationOperationSchema });
type Operation = ProtocolSchemaOutput<typeof UpstashBoxPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof UpstashBoxPreparedArtifactSchema>;
type BuildInput = ProtocolSchemaOutput<typeof UpstashBoxPreparationInputSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const snapshotSchema = defineProtocolObject({ id: text, name: text, box_id: text, status: text }, open);
const snapshotsSchema = defineProtocolObject({ snapshots: defineProtocolArray(snapshotSchema) }, open);
// Native contract: @upstash/box 0.8.0 client.ts and snapshots.
// The paused source remains owned until destruction: operation-id recovery
// needs its name→id lookup because native snapshot listing is box-scoped.
export function createUpstashBoxPreparationClient(request: typeof fetch, signal?: AbortSignal) {
  const http = createUpstashBoxHttpClient(request, signal);
  const native = createUpstashBoxNativeClient(request, signal);
  const name = (operation: Operation) => 'happier-' + operation.managedId;
  const sourcePath = (operation: Operation) => UPSTASH_BOX_API + '/' + encodeURIComponent(operation.sourceBoxId ?? name(operation));
  const snapshotsPath = (operation: Operation) => sourcePath(operation) + '/snapshots';
  const resource = (operation: Operation): UpstashBoxResource => ({ boxId: text.parse(operation.sourceBoxId), name: name(operation), managedId: operation.managedId });
  function failure(error: unknown, operation: Operation, fallback: string, refuse = true) {
    return projectMachineProvisionerActionFailure(error, (): { kind: 'refused'; code: string; nativeCause?: MachineProvisionerNativeCauseV1 } | { kind: 'unknown'; code: string; nativeOperationRef: ReturnType<typeof reference<Operation>>; nativeCause?: MachineProvisionerNativeCauseV1 } => {
      const code = error instanceof NativeError ? error.code : fallback;
      const cause = error instanceof NativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {};
      if (refuse && error instanceof NativeError && (code.endsWith('_identity_mismatch') || error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 409)) return { kind: 'refused', code, ...cause };
      return { kind: 'unknown', code, nativeOperationRef: reference(operation), ...cause };
    });
  }
  async function source(operation: Operation) {
    try {
      const value = readUpstashBoxIdentity(await http(sourcePath(operation)), { name: name(operation), managedId: operation.managedId, boxId: operation.sourceBoxId });
      return value.status === 'deleted' ? null : value;
    } catch (error) { if (error instanceof NativeError && error.status === 404) return null; throw error; }
  }
  async function snapshots(operation: Operation) {
    const result = snapshotsSchema.safeParse(await http(snapshotsPath(operation)));
    if (!result.success) throw new NativeError('upstash_box_snapshot_invalid_response');
    const matches = result.data.snapshots.filter(value => value.name === name(operation) || value.id === operation.snapshotId);
    if (matches.length > 1) throw new NativeError('upstash_box_snapshot_identity_mismatch');
    const value = matches[0];
    if (!value || value.status === 'deleted') return null;
    if (value.name !== name(operation) || value.box_id !== operation.sourceBoxId
      || operation.snapshotId !== undefined && value.id !== operation.snapshotId) throw new NativeError('upstash_box_snapshot_identity_mismatch');
    return value;
  }
  function classify(value: ProtocolSchemaOutput<typeof snapshotSchema>, operation: Operation): Exclude<InspectResult, { kind: 'absent' }> {
    const retained = { ...operation, snapshotId: value.id };
    if (value.status === 'ready') return { kind: 'ready', artifact: reference({ managedId: operation.managedId,
      sourceBoxId: text.parse(operation.sourceBoxId), snapshotId: value.id, launch: { ...operation.launch, snapshotId: value.id } }) };
    if (value.status === 'creating') return { kind: 'pending', nativeOperationRef: reference(retained) };
    return { kind: value.status === 'error' ? 'failed' : 'unknown', code: 'upstash_box_snapshot_' + (value.status === 'error' ? 'error' : 'state_unsupported'), nativeOperationRef: reference(retained) };
  }
  async function exec(operation: Operation, argv: readonly string[]) {
    const result = await native.exec({ resource: resource(operation), argv: [...argv] });
    if (!('termination' in result) || result.termination.observed.kind !== 'exit') throw new NativeError('upstash_box_preparation_exec_failed');
    assertMachineProvisionerGuestCommandSucceeded({ exitCode: result.termination.observed.exitCode,
      stderr: decodeBase64(result.stderrBase64), ...(result.stdoutTruncated || result.stderrTruncated ? { truncated: true } : {}) },
    details => new NativeError('upstash_box_preparation_exec_failed', undefined, details.nativeCause));
    return new TextDecoder().decode(decodeBase64(result.stdoutBase64));
  }
  async function build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
    const definition = UpstashBoxPreparationInputSchema.parse(input.input);
    let operation: Operation = { managedId: 'prepared-' + text.parse(input.operationId), launch: definition.launch.choices };
    let allocated = false;
    try {
      const { snapshotId: _snapshotId, ...base } = definition.launch.choices;
      allocated = true;
      const acquired = await native.acquire(base, operation.managedId);
      if (acquired.kind === 'rejected') return { kind: 'refused', code: acquired.code };
      if (acquired.kind !== 'bound') return { kind: 'unknown', code: 'upstash_box_build_source_unconfirmed', nativeOperationRef: reference(operation) };
      operation = { ...operation, sourceBoxId: acquired.resource.value.boxId };
      let state = await source(operation);
      // Upstash SDK 0.8.0 Box.create follows creating at this cadence. The
      // invocation owns cancellation/deadline; no competing timeout is added.
      while (state?.status === 'creating') { await sleepWithSignal(2000, signal); state = await source(operation); }
      if (!state || !['idle', 'running'].includes(state.status)) throw new NativeError('upstash_box_build_source_unavailable');
      const guest = await exec(operation, ['sh', '-c', 'uname -s; uname -m; printf "%s\\n" "$HOME"']);
      if (!guest.startsWith('Linux\nx86_64\n')) throw new NativeError('upstash_box_guest_unsupported');
      const directory = '/tmp/.happier-preparation-' + encodeURIComponent(input.operationId);
      await exec(operation, ['mkdir', '-p', directory]);
      for (const file of definition.cli.files) {
        const put = await native.putFile({ resource: resource(operation), guestPath: directory + '/' + file.path, bytesBase64: file.contentsBase64, mode: 0o600 });
        if (put.kind !== 'confirmed') throw new NativeError(put.code ?? 'upstash_box_file_unconfirmed');
      }
      // Install as boxuser in its writable workspace. Only the existing setup
      // interpreter requires root; keep the installed CLI owned by its caller.
      await exec(operation, ['sh', '-c', 'set -e\ntrap \'rm -rf -- "$1"\' EXIT\ncd -- "$1"\nsh -c "$2"\n'
        + 'if [ "$(id -u)" = 0 ]; then sh -c "$3"; else sudo -n -- sh -c "$3"; fi\n',
        'happier-build', directory, definition.cli.installScript, definition.setupScript ?? '']);
      const stopped = await native.power(resource(operation), 'stop');
      if (stopped.kind !== 'confirmed') throw new NativeError(stopped.code ?? 'upstash_box_power_unconfirmed');
      const parsed = snapshotSchema.safeParse(await http(snapshotsPath(operation), 'POST', { name: name(operation) }));
      if (!parsed.success) throw new NativeError('upstash_box_snapshot_invalid_response');
      if (parsed.data.name !== name(operation) || parsed.data.box_id !== operation.sourceBoxId) throw new NativeError('upstash_box_snapshot_identity_mismatch');
      const result = classify(parsed.data, operation);
      return result.kind === 'failed' ? { ...result, kind: 'unknown' } : result;
    } catch (error) { return failure(error, operation, 'upstash_box_snapshot_build_unconfirmed', !allocated); }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: UpstashBoxLaunch }): Promise<InspectResult> {
    let operation: Operation = 'nativeOperation' in input ? UpstashBoxPreparationOperationSchema.parse(input.nativeOperation)
      : { managedId: 'prepared-' + text.parse(input.operationId), launch: UpstashBoxLaunchSchema.parse(input.launch) };
    try {
      if (!operation.sourceBoxId) {
        const found = await source(operation);
        if (!found) return { kind: 'absent' };
        operation = { ...operation, sourceBoxId: found.id };
      }
      const value = await snapshots(operation);
      return value ? classify(value, operation) : { kind: 'failed', code: 'upstash_box_preparation_incomplete', nativeOperationRef: reference(operation) };
    } catch (error) {
      const result = await failure(error, operation, 'upstash_box_snapshot_read_unconfirmed', false);
      return result.kind === 'refused' ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation),
        ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) } : result;
    }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    let operation: Operation = input.artifact ? UpstashBoxPreparedArtifactSchema.parse(input.artifact) : UpstashBoxPreparationOperationSchema.parse(input.nativeOperation);
    try {
      const found = await source(operation);
      if (!operation.sourceBoxId) {
        if (!found) return { kind: 'confirmed' };
        operation = { ...operation, sourceBoxId: found.id };
      }
      const value = await snapshots(operation);
      if (value) {
        operation = { ...operation, snapshotId: value.id };
        await http(snapshotsPath(operation) + '/' + encodeURIComponent(value.id), 'DELETE');
        if (await snapshots(operation)) return { kind: 'pending', nativeOperationRef: reference(operation) };
      }
      if (found) await http(sourcePath(operation), 'DELETE');
      return await source(operation) === null ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) { return failure(error, operation, 'upstash_box_snapshot_delete_unconfirmed'); }
  }
  return { build, inspect, destroy };
}
