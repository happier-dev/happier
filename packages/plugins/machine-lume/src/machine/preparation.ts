import { defineProtocolObject, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas,
  projectMachineProvisionerActionFailure, type MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { LumeNativeClient } from './nativeClient.js';
import { createLumeProvider } from './provider.js';
import { LUME_PLUGIN_ID, LUME_PROVISIONER_ID } from './definition.js';
import { LumeLaunchV1Schema, LumePreparedResourceFields, LumePreparedResourceV1Schema, type LumeLaunchV1, type LumeResourceV1 } from './schemas.js';

export const LumePreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(LumeLaunchV1Schema);
export const LumePreparationOperationSchema = LumePreparedResourceV1Schema;
export const LumePreparedArtifactSchema = defineProtocolObject({
  ...LumePreparedResourceFields,
  launch: LumeLaunchV1Schema,
}, { policy: 'closed' });
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({
  input: LumePreparationInputSchema, launch: LumeLaunchV1Schema,
  artifact: LumePreparedArtifactSchema, nativeOperation: LumePreparationOperationSchema,
});
type BuildInput = ProtocolSchemaOutput<typeof LumePreparationInputSchema>;
type Operation = ProtocolSchemaOutput<typeof LumePreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof LumePreparedArtifactSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const contributionRef = { pluginId: LUME_PLUGIN_ID, localId: LUME_PROVISIONER_ID };
const reference = <T>(value: T) => ({ contributionRef, schemaVersion: 1, value });

function nativeCode(result: Readonly<{ kind: string; reason?: string; code?: string;
  nativeCause?: MachineProvisionerNativeCauseV1 }>, fallback: string) {
  if (result.nativeCause && 'localCause' in result.nativeCause) return result.nativeCause.localCause;
  return result.code ?? result.reason ?? fallback;
}
function operationFor(operationId: string, launch: LumeLaunchV1): Operation {
  return LumePreparationOperationSchema.parse({ storage: launch.storage, vmName: `happier-prepared-${operationId}` });
}

/** Guest OS execution boundary: no enrollment or Happier credential material. */
export type LumePreparationBuildExecution = (input: Readonly<{
  resource: LumeResourceV1; cli: BuildInput['cli']; setupScript?: string; signal?: AbortSignal;
}>) => Promise<void>;

// Lume 0.6.1 (3350f504014c85416009a90fcb339fe556ce02fc) clones the
// entire stopped disk. Build a fresh public-image VM without enrollment or
// Happier keys; per-clone trust/key installation belongs to ordinary bootstrap.
export function createLumePreparationClient(options: Readonly<{
  native: LumeNativeClient; observedAt: number; signal?: AbortSignal;
  waitForNativeObservation(): Promise<void>; executeBuild: LumePreparationBuildExecution;
}>) {
  const { native, signal } = options;
  const provider = createLumeProvider({ native, observedAt: options.observedAt, signal });
  function unknown(operation: Operation, code: string) {
    return { kind: 'unknown' as const, code, nativeOperationRef: reference(operation) };
  }
  function failure(error: unknown, operation: Operation, code: string) {
    signal?.throwIfAborted();
    return projectMachineProvisionerActionFailure(error, () => unknown(operation, code));
  }
  return {
    async build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
      const definition = LumePreparationInputSchema.parse(input.input);
      const launch = definition.launch.choices;
      const operation = operationFor(input.operationId, launch);
      try {
        const before = await native.inspect(operation, signal);
        // An interrupted invocation is cleaned by the host's next admission,
        // never pulled over or treated as a successful completed guest build.
        if (before.kind === 'present') return unknown(operation, 'lume_preparation_incomplete');
        if (before.kind !== 'absent') return unknown(operation, nativeCode(before, 'lume_preparation_read_unconfirmed'));
        const acquired = await provider.acquire(launch, `prepared-${input.operationId}`);
        if (acquired.kind === 'rejected') return { kind: 'refused', code: acquired.code };
        if (acquired.kind !== 'bound') return unknown(operation, nativeCode(acquired, 'lume_preparation_acquire_unconfirmed'));
        const resource = acquired.resource.value;
        for (;;) {
          signal?.throwIfAborted();
          const connection = await native.connection(operation, signal);
          if (connection.kind === 'connection') break;
          if (connection.kind !== 'pending') return unknown(operation, nativeCode(connection, 'lume_preparation_connection_unavailable'));
          // Native DHCP/SSH readiness has no push stream. The host owns this
          // active invocation's cadence and cancellation, with no local timer.
          await options.waitForNativeObservation();
        }
        await options.executeBuild({ resource, cli: definition.cli,
          ...(definition.setupScript === undefined ? {} : { setupScript: definition.setupScript }),
          ...(signal === undefined ? {} : { signal }) });
        const stopped = await native.stopPresent(operation, signal);
        if (stopped.kind !== 'stop-accepted') return unknown(operation, nativeCode(stopped, 'lume_preparation_stop_unconfirmed'));
        const after = await native.inspect(operation, signal);
        if (after.kind !== 'present' || after.vendorStatus !== 'stopped') {
          return unknown(operation, nativeCode(after, 'lume_preparation_stop_unconfirmed'));
        }
        return { kind: 'ready', artifact: reference({ ...operation, launch: { ...launch,
          // Prepared clones always complete key-only access. The original
          // cold-launch password preference does not weaken this build flow.
          keepPasswordLogin: false,
          image: { kind: 'prepared', ...operation,
            ...(resource.privateCarrier === undefined ? {} : { privateCarrier: resource.privateCarrier }) },
        } } satisfies Artifact) };
      } catch (error) { return failure(error, operation, 'lume_preparation_build_unconfirmed'); }
    },
    async inspect(input: { nativeOperation: Operation } | { operationId: string; launch: LumeLaunchV1 }): Promise<InspectResult> {
      const operation = 'nativeOperation' in input ? LumePreparationOperationSchema.parse(input.nativeOperation)
        : operationFor(input.operationId, LumeLaunchV1Schema.parse(input.launch));
      try {
        const observed = await native.inspect(operation, signal);
        if (observed.kind === 'absent') return { kind: 'absent' };
        // A stopped disk proves neither CLI nor setup completion. Losing the
        // ready response leaves a visible orphan for cleanup and fresh retry.
        return observed.kind === 'present'
          ? { kind: 'failed', code: 'lume_preparation_incomplete', nativeOperationRef: reference(operation) }
          : unknown(operation, nativeCode(observed, 'lume_preparation_read_unconfirmed'));
      } catch (error) { return failure(error, operation, 'lume_preparation_read_unconfirmed'); }
    },
    async destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
      const artifact = input.artifact && LumePreparedArtifactSchema.parse(input.artifact);
      const operation = LumePreparationOperationSchema.parse(artifact
        ? { storage: artifact.storage, vmName: artifact.vmName } : input.nativeOperation);
      try {
        const removed = await native.destroy(operation, signal);
        if (removed.kind === 'absent') return { kind: 'confirmed' };
        if (removed.kind !== 'delete-accepted') return unknown(operation, nativeCode(removed, 'lume_preparation_delete_unconfirmed'));
        const after = await native.inspect(operation, signal);
        if (after.kind === 'absent') return { kind: 'confirmed' };
        return after.kind === 'present' ? { kind: 'pending', nativeOperationRef: reference(operation) }
          : unknown(operation, nativeCode(after, 'lume_preparation_delete_unconfirmed'));
      } catch (error) { return failure(error, operation, 'lume_preparation_delete_unconfirmed'); }
    },
  };
}
