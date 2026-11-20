import { defineProtocolNumber, defineProtocolObject, defineProtocolString, decodeBase64, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { buildMachineProvisionerPreparationInstallScript, quoteMachineProvisionerShellArgument as quote, assertMachineProvisionerGuestCommandSucceeded, createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectMaritimeNativeFailure } from '../machine/nativeFailure.js';
import { createMaritimeSandboxClient, SandboxError } from './native.js';
import { SandboxLaunchSchema, SANDBOX_HOME, sandboxReference, type SandboxLaunch } from './schemas.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const SandboxPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(SandboxLaunchSchema);
export const SandboxPreparedArtifactSchema = defineProtocolObject({ name: text, sourceSandboxId: text.optional(), launch: SandboxLaunchSchema }, closed);
export const SandboxPreparationOperationSchema = defineProtocolObject({ name: text, sourceSandboxId: text.optional(), launch: SandboxLaunchSchema }, closed);
export const SANDBOX_PREPARATION = defineMachineProvisionerPreparationSchemas({ input: SandboxPreparationInputSchema,
  launch: SandboxLaunchSchema, artifact: SandboxPreparedArtifactSchema, nativeOperation: SandboxPreparationOperationSchema });
type Operation = ProtocolSchemaOutput<typeof SandboxPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof SandboxPreparedArtifactSchema>;
type InspectResult = ReturnType<typeof SANDBOX_PREPARATION.inspectResult.parse>;
type BuildResult = ReturnType<typeof SANDBOX_PREPARATION.buildResult.parse>;
type DestroyResult = ReturnType<typeof SANDBOX_PREPARATION.destroyResult.parse>;
const open = { policy: 'additive-open/drop' } as const;
// SDK 0.12.0 SavedSnapshot explicitly documents resources:null for stock
// templates. sourceSandboxId is nullable without a stock-only guarantee.
const resourcesSchema = defineProtocolObject({ vcpu: defineProtocolNumber({ integer: true }),
  memoryMib: defineProtocolNumber({ integer: true }), diskGib: defineProtocolNumber({ integer: true }) }, open);
const snapshotSchema = defineProtocolObject({ name: text, sourceSandboxId: text.nullable(), resources: resourcesSchema.nullable() }, open);

export function createMaritimePreparationClient(request: typeof fetch, signal: AbortSignal, dataFetch: typeof fetch = fetch) {
  const native = createMaritimeSandboxClient(request, signal, 0, dataFetch);
  const operationFor = (operationId: string, launch: SandboxLaunch): Operation => ({ name: 'happier-prepared-' + text.parse(operationId), launch });
  const builderFor = (operation: Operation) => ({ name: operation.name + '-builder', ...(operation.sourceSandboxId === undefined ? {} : { sandboxId: operation.sourceSandboxId }) });
  const path = (operation: Operation) => '/snapshots/' + encodeURIComponent(operation.name);
  function failure(error: unknown, operation: Operation) {
    return projectMaritimeNativeFailure(error, () => ({ kind: 'unknown' as const,
      code: error instanceof SandboxError ? error.code : 'maritime_preparation_unconfirmed',
      ...(error instanceof SandboxError && error.nativeCause ? { nativeCause: error.nativeCause } : {}), nativeOperationRef: sandboxReference(operation) }));
  }
  function snapshot(value: unknown, operation: Operation) {
    const result = snapshotSchema.safeParse(value);
    if (!result.success) throw new SandboxError('maritime_snapshot_invalid_response');
    if (result.data.name !== operation.name || result.data.resources === null
      || operation.sourceSandboxId !== undefined && result.data.sourceSandboxId != null && result.data.sourceSandboxId !== operation.sourceSandboxId) throw new SandboxError('maritime_snapshot_identity_mismatch');
    return { name: result.data.name, ...(result.data.sourceSandboxId == null ? {} : { sourceSandboxId: result.data.sourceSandboxId }) };
  }
  async function read(operation: Operation) {
    const response = await native.api(path(operation));
    return response.status === 404 ? null : snapshot(await native.json(response), operation);
  }
  async function observe(operation: Operation) {
    const saved = await read(operation);
    const builder = await native.read(builderFor(operation));
    if (saved && builder && saved.sourceSandboxId !== undefined && saved.sourceSandboxId !== builder.id) throw new SandboxError('maritime_snapshot_identity_mismatch');
    const sourceSandboxId = operation.sourceSandboxId ?? saved?.sourceSandboxId ?? builder?.id;
    return { saved, builder, retained: { ...operation, ...(sourceSandboxId === undefined ? {} : { sourceSandboxId }) } };
  }
  async function inspectOperation(operation: Operation): Promise<InspectResult> {
    const { saved, builder, retained } = await observe(operation);
    if (!saved) return builder && builder.state !== 'ended'
      ? { kind: 'failed', code: 'maritime_preparation_interrupted', nativeOperationRef: sandboxReference(retained) }
      : { kind: 'absent' };
    if (!await native.remove(builderFor(retained))) return { kind: 'pending', nativeOperationRef: sandboxReference(retained) };
    return { kind: 'ready', artifact: sandboxReference({ name: saved.name,
      ...(retained.sourceSandboxId === undefined ? {} : { sourceSandboxId: retained.sourceSandboxId }), launch: { ...operation.launch, from: operation.name } }) };
  }
  return {
    async build(input: { operationId: string; input: ProtocolSchemaOutput<typeof SandboxPreparationInputSchema> }): Promise<BuildResult> {
      const definition = SandboxPreparationInputSchema.parse(input.input);
      let operation = operationFor(input.operationId, definition.launch.choices);
      try {
        const builder = await native.create(operation.launch, builderFor(operation).name);
        operation = { ...operation, sourceSandboxId: builder.id };
        // forEndUser is an independent optional boolean in SDK 0.12.0, not an
        // invented end-user identity. Vendor excludes automatic Account secrets.
        if (!builder.forEndUser) throw new SandboxError('maritime_builder_secret_exclusion_unconfirmed');
        if (builder.state !== 'running') throw new SandboxError('maritime_builder_not_running');
        await native.bootstrap({ sandboxId: builder.id, name: builderFor(operation).name });
        const directory = '/tmp/' + operation.name;
        for (const file of definition.cli.files) await native.upload(builder, directory + '/' + file.path, decodeBase64(file.contentsBase64));
        const script = 'trap ' + quote('rm -rf -- ' + quote(directory)) + ' EXIT\n'
          + buildMachineProvisionerPreparationInstallScript({ cli: definition.cli,
            stageDirectory: definition.cli.files.length ? directory : undefined, readableRoot: SANDBOX_HOME, setupScript: definition.setupScript });
        // The native base example installs under /home/user. Installation into
        // /opt/happier and the shared setup effect require root, without changing
        // the image's ordinary command user. Images without sudo fail visibly.
        const result = await native.run(builder, ['sh', '-c',
          'if [ "$(id -u)" = 0 ]; then exec "$@"; else exec sudo -n -- "$@"; fi',
          'happier-prepare', 'sh', '-c', script]);
        assertMachineProvisionerGuestCommandSucceeded({ exitCode: result.exitCode }, details => new SandboxError('maritime_preparation_command_failed', undefined, details));
        snapshot(await native.json(await native.api('/sandboxes/' + encodeURIComponent(builder.id) + '/save', 'POST', { name: operation.name })), operation);
        const resultState = await inspectOperation(operation);
        return resultState.kind === 'failed' || resultState.kind === 'absent' ? { kind: 'unknown', code: 'maritime_preparation_unconfirmed', nativeOperationRef: sandboxReference(operation) } : resultState;
      } catch (error) { return failure(error, operation); }
    },
    async inspect(input: { nativeOperation: Operation } | { operationId: string; launch: SandboxLaunch }): Promise<InspectResult> {
      const operation = 'nativeOperation' in input ? SandboxPreparationOperationSchema.parse(input.nativeOperation) : operationFor(input.operationId, input.launch);
      try { return await inspectOperation(operation); } catch (error) { return failure(error, operation); }
    },
    async destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
      const artifact = input.artifact && SandboxPreparedArtifactSchema.parse(input.artifact);
      const operation = artifact ? { name: artifact.name, sourceSandboxId: artifact.sourceSandboxId, launch: artifact.launch }
        : SandboxPreparationOperationSchema.parse(input.nativeOperation);
      try {
        const { saved, retained } = await observe(operation);
        if (saved) await native.api(path(operation), 'DELETE');
        const builderGone = await native.remove(builderFor(retained));
        return await read(retained) === null && builderGone ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: sandboxReference(retained) };
      } catch (error) {
        if (error instanceof SandboxError && error.code === 'maritime_snapshot_identity_mismatch') return { kind: 'refused', code: error.code };
        return failure(error, operation);
      }
    },
  };
}
