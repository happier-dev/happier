import { defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { DAYTONA_API, NativeError as SnapshotError, requireDaytonaHttpSuccess } from './nativeClient.js';
import { DaytonaLaunchSchema, reference, type DaytonaLaunch } from './schemas.js';
import { createDaytonaContextFile, signDaytonaStoragePut } from './buildContext.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const DAYTONA_PREPARATION_HOME = '/opt/happier';
export const DaytonaPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(DaytonaLaunchSchema);
export const DaytonaPreparedArtifactSchema = defineProtocolObject({ snapshotId: text, name: text, organizationId: text, launch: DaytonaLaunchSchema }, closed);
export const DaytonaPreparationOperationSchema = defineProtocolObject({ name: text, organizationId: text.optional(), snapshotId: text.optional() }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({
  input: DaytonaPreparationInputSchema, launch: DaytonaLaunchSchema, artifact: DaytonaPreparedArtifactSchema, nativeOperation: DaytonaPreparationOperationSchema,
});
type BuildInput = ProtocolSchemaOutput<typeof DaytonaPreparationInputSchema>;
type Artifact = ProtocolSchemaOutput<typeof DaytonaPreparedArtifactSchema>;
type Operation = ProtocolSchemaOutput<typeof DaytonaPreparationOperationSchema>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const nativeSnapshotSchema = defineProtocolObject({ id: text, name: text, organizationId: text, state: text }, { policy: 'additive-open/drop' });
const currentKeySchema = defineProtocolObject({ organizationId: text }, { policy: 'additive-open/drop' });
const baseSnapshotSchema = defineProtocolObject({ id: text, name: text, state: text, sandboxClass: text.optional(),
  ref: text.optional() }, { policy: 'additive-open/drop' });
const storageAccessSchema = defineProtocolObject({ accessKey: text, secret: text, sessionToken: text.optional(),
  storageUrl: text, organizationId: text, bucket: text, region: text }, { policy: 'additive-open/drop' });

// Daytona v0.231, OpenAPI 1.0 (2026-11-15): POST /snapshots cold-builds
// Dockerfile content. No live/enrolled sandbox or vendor logs enter this role.
export function createDaytonaPreparationClient(request: typeof fetch, signal?: AbortSignal, options: { storageFetch?: typeof fetch } = {}) {
  const path = (operation: Operation) => DAYTONA_API + '/snapshots/' + encodeURIComponent(operation.snapshotId ?? operation.name);
  async function http(url: string, method = 'GET', body?: unknown) {
    signal?.throwIfAborted();
    const response = await request(url, { method, signal, redirect: 'error', headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!(method === 'DELETE' && response.status === 404)) requireDaytonaHttpSuccess(response);
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    try { return await response.json() as unknown; }
    catch { throw new SnapshotError('daytona_snapshot_invalid_response'); }
  }
  async function organization(operation: Operation) {
    const parsed = currentKeySchema.safeParse(await json(await http(DAYTONA_API + '/api-keys/current')));
    if (!parsed.success) throw new SnapshotError('daytona_snapshot_invalid_response');
    if (operation.organizationId !== undefined && operation.organizationId !== parsed.data.organizationId) throw new SnapshotError('daytona_snapshot_identity_mismatch');
    return parsed.data.organizationId;
  }
  function snapshot(value: unknown, expected: Operation, organizationId: string) {
    const parsed = nativeSnapshotSchema.safeParse(value);
    if (!parsed.success) throw new SnapshotError('daytona_snapshot_invalid_response');
    const native = parsed.data;
    if (native.name !== expected.name || native.organizationId !== organizationId
      || expected.snapshotId !== undefined && native.id !== expected.snapshotId) throw new SnapshotError('daytona_snapshot_identity_mismatch');
    return native;
  }
  function classify(native: ProtocolSchemaOutput<typeof nativeSnapshotSchema>): Exclude<InspectResult, { kind: 'absent' }> {
    const value = { snapshotId: native.id, name: native.name, organizationId: native.organizationId };
    switch (native.state) {
      case 'active': return { kind: 'ready', artifact: reference({ ...value, launch: { snapshot: native.id } }) };
      // Activation is not implemented by this adapter. Inactive settles rather
      // than waiting forever for an advancing event with no producer.
      case 'inactive':
      case 'error':
      case 'build_failed': return { kind: 'failed', code: 'daytona_snapshot_' + native.state, nativeOperationRef: reference(value) };
      case 'building':
      case 'pending':
      case 'pulling':
      case 'snapshotting':
      case 'removing': return { kind: 'pending', nativeOperationRef: reference(value) };
      default: return { kind: 'unknown', code: 'daytona_snapshot_state_unsupported', nativeOperationRef: reference(value) };
    }
  }
  function failure(error: unknown, operation: Operation, fallback: string) {
    return projectMachineProvisionerActionFailure(error, (): { kind: 'refused'; code: string }
      | { kind: 'unknown'; code: string; nativeOperationRef: ReturnType<typeof reference<Operation>> } => {
      if (error instanceof SnapshotError && (error.code === 'daytona_snapshot_identity_mismatch'
        || error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 409)) {
        return { kind: 'refused', code: error.code };
      }
      return { kind: 'unknown', code: error instanceof SnapshotError ? error.code : fallback, nativeOperationRef: reference(operation) };
    });
  }
  async function read(operation: Operation, organizationId: string) {
    try { return snapshot(await json(await http(path(operation))), operation, organizationId); }
    catch (error) {
      if (error instanceof SnapshotError && error.status === 404) return null;
      throw error;
    }
  }
  async function uploadContext(files: BuildInput['cli']['files'], organizationId: string) {
    if (!files.length) return [];
    // SDK 0.231.1 Snapshot.processImageContext obtains temporary S3 credentials
    // from this API. The account bearer remains on the Daytona API boundary.
    const parsed = storageAccessSchema.safeParse(await json(await http(DAYTONA_API + '/object-storage/push-access')));
    if (!parsed.success) throw new SnapshotError('daytona_snapshot_invalid_response');
    const access = parsed.data;
    if (access.organizationId !== organizationId) throw new SnapshotError('daytona_snapshot_identity_mismatch');
    const hashes: string[] = [];
    for (const file of files) {
      signal?.throwIfAborted();
      const context = createDaytonaContextFile(file);
      const url = new URL(access.storageUrl);
      url.pathname = url.pathname.replace(/\/$/, '') + '/' + [access.bucket, organizationId, context.hash, 'context.tar'].map(encodeURIComponent).join('/');
      const headers = signDaytonaStoragePut({ url, body: context.bytes, credentials: access, at: new Date(),
        headers: { 'content-type': 'application/x-tar' } });
      const response = await (options.storageFetch ?? fetch)(url, { method: 'PUT', signal, redirect: 'error', headers, body: context.bytes });
      if (!response.ok) throw new SnapshotError('daytona_snapshot_context_upload_unavailable', response.status);
      hashes.push(context.hash);
    }
    return hashes;
  }
  async function build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
    const definition = DaytonaPreparationInputSchema.parse(input.input);
    let operation: Operation = { name: 'happier-prepared-' + text.parse(input.operationId) };
    try {
      const organizationId = await organization(operation);
      operation = { ...operation, organizationId };
      const launch = definition.launch.choices;
      const base = baseSnapshotSchema.parse(await json(await http(DAYTONA_API + '/snapshots/' + encodeURIComponent(launch.snapshot))));
      if (base.id !== launch.snapshot && base.name !== launch.snapshot) return { kind: 'refused', code: 'daytona_snapshot_identity_mismatch' };
      if (base.sandboxClass !== 'container') return { kind: 'refused', code: 'daytona_snapshot_base_unsupported' };
      if (base.state !== 'active') return { kind: 'refused', code: 'daytona_snapshot_base_unavailable' };
      // SnapshotDto.ref is an OCI image reference (v0.231 OpenAPI's example is
      // daytonaio/sandbox:latest). It preserves the selected snapshot's layers.
      const image = base.ref;
      if (!image || /\s/.test(image)) return { kind: 'refused', code: 'daytona_snapshot_base_unsupported' };
      const contextHashes = await uploadContext(definition.cli.files, organizationId);
      const contextDirectory = contextHashes.length ? '/tmp/.happier-preparation-' + encodeURIComponent(input.operationId) : '';
      const copies = definition.cli.files.map(file => 'COPY ' + JSON.stringify([file.path, contextDirectory + '/' + file.path]) + '\n').join('');
      // Keep the inherited image USER. Only this build effect needs root; an
      // image without root/passwordless sudo fails visibly and remains cold.
      const command = ['sh', '-c', 'if [ "$(id -u)" = 0 ]; then exec "$@"; else exec sudo -n -- "$@"; fi',
        'happier-prepare', 'sh', '-c', 'set -e\nif [ -n "$1" ]; then trap \'rm -rf -- "$1"\' EXIT; cd -- "$1"; fi\nsh -c "$2"\nchmod -R a+rX ' + DAYTONA_PREPARATION_HOME + '\nsh -c "$3"\n',
        'happier-build', contextDirectory, definition.cli.installScript, definition.setupScript ?? ''];
      // Request the stage platform advertised by preparationGuest, including
      // multi-platform base refs: https://docs.docker.com/reference/dockerfile/#from
      const dockerfileContent = 'FROM --platform=linux/amd64 ' + image + '\n' + copies + 'RUN ' + JSON.stringify(command) + '\n';
      const response = await http(DAYTONA_API + '/snapshots', 'POST', { name: operation.name,
        buildInfo: { dockerfileContent, ...(contextHashes.length ? { contextHashes } : {}) } });
      const result = classify(snapshot(await json(response), operation, organizationId));
      // A terminal native build response can still own a billed resource. Keep
      // its reference so the operation owner can inspect/clean it, never drop it.
      return result.kind === 'failed' ? { ...result, kind: 'unknown' } : result;
    } catch (error) {
      // A mismatching POST response does not establish that the attempted build
      // failed to allocate. Recovery still reads the retained expected name.
      if (error instanceof SnapshotError && error.code === 'daytona_snapshot_identity_mismatch') {
        return { kind: 'unknown', code: error.code, nativeOperationRef: reference(operation) };
      }
      return failure(error, operation, 'daytona_snapshot_build_unconfirmed');
    }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: DaytonaLaunch }): Promise<InspectResult> {
    const operation = 'nativeOperation' in input ? DaytonaPreparationOperationSchema.parse(input.nativeOperation)
      : { name: 'happier-prepared-' + text.parse(input.operationId) };
    try {
      const native = await read(operation, await organization(operation));
      return native === null ? { kind: 'absent' } : classify(native);
    } catch (error) {
      const result = await failure(error, operation, 'daytona_snapshot_read_unconfirmed');
      return result.kind === 'refused' ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation) } : result;
    }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    const artifact = input.artifact && DaytonaPreparedArtifactSchema.parse(input.artifact);
    const operation: Operation = artifact ? { snapshotId: artifact.snapshotId, name: artifact.name, organizationId: artifact.organizationId }
      : DaytonaPreparationOperationSchema.parse(input.nativeOperation);
    let retained: Operation = operation;
    try {
      const organizationId = await organization(operation);
      const before = await read(operation, organizationId);
      if (before === null) return { kind: 'confirmed' };
      retained = { snapshotId: before.id, name: before.name, organizationId: before.organizationId };
      if (before.state === 'removing') return { kind: 'pending', nativeOperationRef: reference(retained) };
      // DELETE can return an empty 200 body. Its acceptance does not prove the
      // resource is gone; only a subsequent GET returning 404 confirms cleanup.
      await http(path(retained), 'DELETE');
      return await read(retained, organizationId) === null ? { kind: 'confirmed' }
        : { kind: 'pending', nativeOperationRef: reference(retained) };
    } catch (error) { return failure(error, retained, 'daytona_snapshot_delete_unconfirmed'); }
  }
  return { build, inspect, destroy };
}
