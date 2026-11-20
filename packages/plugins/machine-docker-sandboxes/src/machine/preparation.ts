import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { buildMachineProvisionerPreparationInstallScript, projectMachineProvisionerActionFailure, quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createDockerSandboxesNativeClient } from './nativeClient.js';
import { DOCKER_SANDBOXES_PREPARATION_BUILDER_PREFIX as builderPrefix, DOCKER_SANDBOXES_PREPARATION_TEMPLATE_PREFIX as templatePrefix,
  DockerSandboxesPreparationInputSchema, DockerSandboxesPreparedArtifactSchema, DockerSandboxesPreparationOperationSchema } from './schemas.js';

type Operation = ProtocolSchemaOutput<typeof DockerSandboxesPreparationOperationSchema>;
type Launch = Operation['launch'];

const completed = (result: PluginProcessResult) => result.termination.observed.kind === 'exit'
  && result.termination.observed.exitCode === 0 && result.termination.requestedBy.kind === 'none';

/** Only dedicated builders are accepted; a live Session resource is never input. */
export function createDockerSandboxesPreparation(exec: Pick<ExecService, 'run'>, executable: ManagedExecutableRef,
  contributionRef: { pluginId: string; localId: string }, signal?: AbortSignal) {
  const native = createDockerSandboxesNativeClient(exec, executable);
  const reference = <T>(value: T) => ({ contributionRef, schemaVersion: 1, value });
  const unknown = (operation: Operation, code: string) => ({ kind: 'unknown' as const, code, nativeOperationRef: reference(operation) });
  const ready = (operation: Operation) => {
    const templateId = `${templatePrefix}${operation.operationId}`;
    return { kind: 'ready' as const, artifact: reference({ templateId, launch: { ...operation.launch, templateId } }) };
  };
  const run = (args: readonly string[]) => {
    signal?.throwIfAborted();
    return exec.run({ executable, args }, { signal });
  };
  async function observe(operationId: string) {
    const templates = await native.templates(signal);
    if (templates.status !== 'available') return undefined;
    const builder = await native.inspect({ sandboxName: `${builderPrefix}${operationId}` }, signal);
    if (!('presence' in builder) || builder.presence === 'unknown') return undefined;
    return { templatePresent: templates.templateIds.includes(`${templatePrefix}${operationId}`), builderPresent: builder.presence === 'present' };
  }
  return {
    async build(raw: { operationId: string; input: unknown }) {
      const input = DockerSandboxesPreparationInputSchema.parse(raw.input);
      const operation = DockerSandboxesPreparationOperationSchema.parse({ operationId: raw.operationId, launch: input.launch.choices });
      const { operationId } = operation;
      signal?.throwIfAborted();
      let failureCode = 'docker_sandbox_prepare_inventory_unavailable';
      try {
        const before = await observe(operationId);
        if (!before) return unknown(operation, 'docker_sandbox_prepare_inventory_unavailable');
        if (before.builderPresent) return unknown(operation, 'docker_sandbox_prepare_cleanup_required');
        if (before.templatePresent) return ready(operation);
        const builder = { sandboxName: `${builderPrefix}${operationId}` };
        // No workspace path, mounts, host skills, static MCP servers, environment,
        // enrollment or account/Agent materialization enter the image builder.
        failureCode = 'docker_sandbox_prepare_create_failed';
        if ((await native.create({ name: builder.sandboxName, templateId: input.launch.choices.templateId }, signal,
          { hostIntegrations: 'disabled' })).status !== 'allocated') return unknown(operation, failureCode);
        failureCode = 'docker_sandbox_prepare_start_failed';
        if ((await native.start(builder, signal)).status !== 'start-accepted') return unknown(operation, failureCode);
        failureCode = 'docker_sandbox_prepare_setup_failed';
        const directory = `/tmp/${builder.sandboxName}`;
        if (!completed(await native.exec(builder, ['mkdir', '-p', '--', directory], signal))) return unknown(operation, failureCode);
        for (const file of input.cli.files) {
          const guestPath = posix.join(directory, file.path);
          if (!completed(await native.exec(builder, ['sh', '-eu', '-c',
            'mkdir -p -- "$1"; umask 077; cat > "$2"', 'happier-prepare-file', posix.dirname(guestPath), guestPath],
            signal, Buffer.from(file.contentsBase64, 'base64')))) return unknown(operation, failureCode);
        }
        // The canonical supplier's script expects its public payload files in
        // the working directory. No provider credential acquisition occurs here.
        const script = buildMachineProvisionerPreparationInstallScript({ cli: input.cli, stageDirectory: directory, setupScript: input.setupScript })
          + 'rm -rf -- ' + quote(directory) + '\n';
        if (!completed(await native.exec(builder, ['sh', '-eu', '-s'], signal, new TextEncoder().encode(script)))) {
          return unknown(operation, failureCode);
        }
        failureCode = 'docker_sandbox_prepare_stop_failed';
        if (!completed(await run(['stop', builder.sandboxName]))) return unknown(operation, failureCode);
        failureCode = 'docker_sandbox_prepare_save_failed';
        if (!completed(await run(['template', 'save', builder.sandboxName, `${templatePrefix}${operationId}`]))) {
          return unknown(operation, failureCode);
        }
        failureCode = 'docker_sandbox_prepare_cleanup_required';
        if (!completed(await run(['rm', '--force', builder.sandboxName]))) return unknown(operation, 'docker_sandbox_prepare_cleanup_required');
        const after = await observe(operationId);
        return after?.templatePresent && !after.builderPresent ? ready(operation) : unknown(operation, 'docker_sandbox_prepare_inventory_unavailable');
      } catch (error) {
        signal?.throwIfAborted();
        return projectMachineProvisionerActionFailure(error, () => unknown(operation, failureCode));
      }
    },
    async inspect(raw: { nativeOperation: Operation } | { operationId: string; launch: Launch }) {
      const operation = DockerSandboxesPreparationOperationSchema.parse('nativeOperation' in raw ? raw.nativeOperation : raw);
      const { operationId } = operation;
      const observed = await observe(operationId);
      if (!observed) return unknown(operation, 'docker_sandbox_prepare_inventory_unavailable');
      if (observed.builderPresent) return { kind: 'failed' as const, code: 'docker_sandbox_prepare_cleanup_required', nativeOperationRef: reference(operation) };
      return observed.templatePresent ? ready(operation) : { kind: 'absent' as const };
    },
    async destroy(raw: { artifact?: unknown; nativeOperation?: unknown }) {
      const artifact = raw.artifact === undefined ? undefined : DockerSandboxesPreparedArtifactSchema.parse(raw.artifact);
      const retainedOperation = raw.nativeOperation === undefined ? undefined : DockerSandboxesPreparationOperationSchema.parse(raw.nativeOperation);
      const artifactOperationId = artifact?.templateId.slice(templatePrefix.length);
      if ((!retainedOperation && !artifact) || (retainedOperation && artifact && retainedOperation.operationId !== artifactOperationId)) throw new PluginError({ code: 'invalid_request' });
      const operation = retainedOperation ?? { operationId: artifactOperationId!, launch: artifact!.launch };
      const { operationId } = operation;
      const observed = await observe(operationId);
      if (!observed) return unknown(operation, 'docker_sandbox_prepare_inventory_unavailable');
      if (!observed.templatePresent && !observed.builderPresent) return { kind: 'confirmed' as const };
      try {
        // Use the exact owned tag, never an image digest, prefix match or reset.
        if (observed.templatePresent && !completed(await run(['template', 'rm', '--force', `${templatePrefix}${operationId}`]))) {
          return unknown(operation, 'docker_sandbox_prepare_cleanup_required');
        }
        if (observed.builderPresent) await native.delete({ sandboxName: `${builderPrefix}${operationId}` }, signal);
        const after = await observe(operationId);
        return after && !after.templatePresent && !after.builderPresent ? { kind: 'confirmed' as const }
          : unknown(operation, 'docker_sandbox_prepare_cleanup_required');
      } catch (error) {
        return projectMachineProvisionerActionFailure(error, () => unknown(operation, 'docker_sandbox_prepare_cleanup_required'));
      }
    },
  };
}
