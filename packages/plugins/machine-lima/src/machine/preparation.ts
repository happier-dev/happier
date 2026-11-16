import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import { defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { changeLimaPower, deleteLimaInstance, execLimaGuest, putLimaGuestFile, runLimaCommand, type LimaExecutor } from '@happier-dev/plugin-sdk/machine-provisioners/lima';
import { createLimaProvider, inspectLimaPreparation, limaAcquisitionResource, limaPreparationMessage, LIMA_PLUGIN_ID, LIMA_PROVISIONER_ID } from './provider.js';
import { LimaLaunchSchema, type LimaLaunch } from './schemas.js';
import { LimaNativeCommandError } from './nativeExecutor.js';

const closed = { policy: 'closed' } as const;
const operationId = defineProtocolString({ minLength: 1 });
export const LimaPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(LimaLaunchSchema);
export const LimaPreparedArtifactSchema = defineProtocolObject({ operationId, launch: LimaLaunchSchema }, closed);
export const LimaPreparationOperationSchema = defineProtocolObject({ operationId, launch: LimaLaunchSchema }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: LimaPreparationInputSchema,
  launch: LimaLaunchSchema, artifact: LimaPreparedArtifactSchema, nativeOperation: LimaPreparationOperationSchema });
type BuildInput = ProtocolSchemaOutput<typeof LimaPreparationInputSchema>;
type Operation = ProtocolSchemaOutput<typeof LimaPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof LimaPreparedArtifactSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const reference = <T>(value: T) => ({ contributionRef: { pluginId: LIMA_PLUGIN_ID, localId: LIMA_PROVISIONER_ID }, schemaVersion: 1, value });
const nativeError = (code: string) => Object.assign(new Error(code), { code });

/** Lima 2.2.1 clone copies the stopped disk/config; snapshots are experimental
 * and driver-specific. Only a fresh, unenrolled, unmounted build is reused.
 * Native config is marked after setup+stop, so interrupted work is cleanup-only.
 * Contract: lima-vm/lima v2.2.1 cmd/limactl/{clone,edit}.go. */
export function createLimaPreparationClient(executor: LimaExecutor, provider: Pick<ReturnType<typeof createLimaProvider>, 'acquire'>) {
  function failure(error: unknown, operation: Operation, fallback: string) {
    const result = () => ({ kind: 'unknown' as const,
      code: error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : fallback,
      nativeOperationRef: reference(operation) });
    return error instanceof LimaNativeCommandError ? { ...result(), code: error.data.code }
      : projectMachineProvisionerActionFailure(error, result);
  }
  async function inspect(operation: Operation): Promise<InspectResult> {
    try {
      const current = await inspectLimaPreparation(executor, operation.launch, operation.operationId);
      if (!current.native) return { kind: 'absent' };
      if (!current.ready) return { kind: 'failed', code: 'lima_preparation_incomplete', nativeOperationRef: reference(operation) };
      return { kind: 'ready', artifact: reference({ operationId: operation.operationId,
        launch: { ...operation.launch, preparedBase: { operationId: operation.operationId } } }) };
    } catch (error) { return failure(error, operation, 'lima_preparation_read_unconfirmed'); }
  }
  async function build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
    const definition = LimaPreparationInputSchema.parse(input.input);
    const operation = { operationId: input.operationId, launch: definition.launch.choices };
    if (operation.launch.preparedBase) return { kind: 'refused', code: 'lima_preparation_requires_clean_base' };
    try {
      const acquired = await provider.acquire({ managedId: `prepare:${operation.operationId}`, launch: { ...operation.launch, mounts: [] } });
      if (acquired.kind === 'rejected' && acquired.code === 'resource_mismatch') return { kind: 'refused', code: 'lima_preparation_exists' };
      if (acquired.kind !== 'bound') return { kind: 'unknown', code: acquired.kind === 'unknown' ? acquired.recovery.reason : acquired.code,
        nativeOperationRef: reference(operation) };
      const resource = limaAcquisitionResource({ ...operation.launch, mounts: [] }, `prepare:${operation.operationId}`);
      const command = async (argv: readonly string[], input?: string) => {
        const result = await execLimaGuest({ executor, ...resource, argv, ...(input === undefined ? {} : { input }) });
        if (result.exitCode !== 0) throw nativeError('lima_preparation_setup_failed');
      };
      // Supplier files are local build inputs, staged privately in the guest.
      // No mount, credential materialization, enrollment or daemon is involved.
      const directory = '/tmp/happier-preparation';
      await command(['mkdir', '-p', directory]);
      for (const file of definition.cli.files) {
        const path = posix.join(directory, file.path);
        await command(['mkdir', '-p', posix.dirname(path)]);
        const written = await putLimaGuestFile({ executor, ...resource, guestPath: path, bytes: Buffer.from(file.contentsBase64, 'base64') });
        if (written.kind !== 'written') throw nativeError('lima_preparation_upload_unconfirmed');
      }
      // As in Daytona, installation/setup need root for /opt/happier. Keep
      // scripts on private stdin and preserve the supplier's selected CLI path.
      const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      await command(['sudo', '-n', '--', 'sh', '-s'], 'set -eu\ncd ' + quote(directory) + '\nsh -c ' + quote(definition.cli.installScript)
        + '\ntest -x ' + quote(definition.cli.binaryPath) + '\nchmod -R a+rX /opt/happier\nsh -c ' + quote(definition.setupScript ?? '') + '\nrm -rf -- ' + quote(directory) + '\n');
      const stopped = await changeLimaPower({ executor, ...resource, intent: 'stop' });
      if (stopped.status.toLowerCase() !== 'stopped') throw nativeError('lima_preparation_stop_unconfirmed');
      const marked = await runLimaCommand({ executor, store: resource.store, args: ['edit', '--tty=false', '--start=false',
        // Lima rejects unused param keys. Its native message field is preserved
        // by clone and exposed in config by list --all-fields (v2.2.1).
        '--set', `.message = ${JSON.stringify(limaPreparationMessage(operation.operationId))}`, resource.instance] });
      if (marked.exitCode !== 0) throw nativeError('lima_preparation_publish_unconfirmed');
      const result = await inspect(operation);
      return result.kind === 'failed' || result.kind === 'absent'
        ? { kind: 'unknown', code: 'lima_preparation_publish_unconfirmed', nativeOperationRef: reference(operation) } : result;
    } catch (error) { return failure(error, operation, 'lima_preparation_build_unconfirmed'); }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    const operation = LimaPreparationOperationSchema.parse(input.artifact ?? input.nativeOperation);
    try {
      const current = await inspectLimaPreparation(executor, operation.launch, operation.operationId);
      if (!current.native) return { kind: 'confirmed' };
      const deleted = await deleteLimaInstance({ executor, ...current.resource });
      return deleted.kind === 'absent' ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) { return failure(error, operation, 'lima_preparation_delete_unconfirmed'); }
  }
  return { build, destroy, inspect(input: { nativeOperation: Operation } | { operationId: string; launch: LimaLaunch }) {
    return inspect(LimaPreparationOperationSchema.parse('nativeOperation' in input ? input.nativeOperation : input));
  } };
}
