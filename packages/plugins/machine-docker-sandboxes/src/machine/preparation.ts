import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createDockerSandboxesNativeClient } from './nativeClient.js';
import { DOCKER_SANDBOXES_PREPARATION_BUILDER_PREFIX as builderPrefix, DOCKER_SANDBOXES_PREPARATION_TEMPLATE_PREFIX as templatePrefix,
  DockerSandboxesPreparationInputSchema, DockerSandboxesPreparedArtifactSchema, DockerSandboxesPreparationOperationSchema } from './schemas.js';

const completed = (result: PluginProcessResult) => result.termination.observed.kind === 'exit'
  && result.termination.observed.exitCode === 0 && result.termination.requestedBy.kind === 'none';

/** Only dedicated builders are accepted; a live Session resource is never input. */
export function createDockerSandboxesPreparation(exec: Pick<ExecService, 'run'>, executable: ManagedExecutableRef,
  contributionRef: { pluginId: string; localId: string }, signal?: AbortSignal) {
  const native = createDockerSandboxesNativeClient(exec, executable);
  const reference = <T extends { operationId: string } | { templateId: string }>(value: T) => ({ contributionRef, schemaVersion: 1, value });
  const unknown = (operationId: string, code: string) => ({ kind: 'unknown' as const, code, nativeOperationRef: reference({ operationId }) });
  const ready = (operationId: string) => ({ kind: 'ready' as const, artifact: reference({ templateId: `${templatePrefix}${operationId}` }) });
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
      const { operationId } = DockerSandboxesPreparationOperationSchema.parse({ operationId: raw.operationId });
      const input = DockerSandboxesPreparationInputSchema.parse(raw.input);
      signal?.throwIfAborted();
      let failureCode = 'docker_sandbox_prepare_inventory_unavailable';
      try {
        const before = await observe(operationId);
        if (!before) return unknown(operationId, 'docker_sandbox_prepare_inventory_unavailable');
        if (before.builderPresent) return unknown(operationId, 'docker_sandbox_prepare_cleanup_required');
        if (before.templatePresent) return ready(operationId);
        const builder = { sandboxName: `${builderPrefix}${operationId}` };
        // No workspace path, mounts, host skills, static MCP servers, environment,
        // enrollment or account/Agent materialization enter the image builder.
        failureCode = 'docker_sandbox_prepare_create_failed';
        if (!completed(await run(['create', '--name', builder.sandboxName, '--template', input.templateId,
          '--skills', 'off', '--static-mcp', 'none', 'shell']))) return unknown(operationId, failureCode);
        failureCode = 'docker_sandbox_prepare_start_failed';
        if (!completed(await run(['run', '--detached', '--name', builder.sandboxName]))) return unknown(operationId, failureCode);
        failureCode = 'docker_sandbox_prepare_setup_failed';
        if (!completed(await native.exec(builder, ['sh', '-eu', '-s'], signal, new TextEncoder().encode(input.setupScript)))) {
          return unknown(operationId, failureCode);
        }
        failureCode = 'docker_sandbox_prepare_stop_failed';
        if (!completed(await run(['stop', builder.sandboxName]))) return unknown(operationId, failureCode);
        failureCode = 'docker_sandbox_prepare_save_failed';
        if (!completed(await run(['template', 'save', builder.sandboxName, `${templatePrefix}${operationId}`]))) {
          return unknown(operationId, failureCode);
        }
        failureCode = 'docker_sandbox_prepare_cleanup_required';
        if (!completed(await run(['rm', '--force', builder.sandboxName]))) return unknown(operationId, 'docker_sandbox_prepare_cleanup_required');
        const after = await observe(operationId);
        return after?.templatePresent && !after.builderPresent ? ready(operationId) : unknown(operationId, 'docker_sandbox_prepare_inventory_unavailable');
      } catch (error) {
        signal?.throwIfAborted();
        return projectMachineProvisionerActionFailure(error, () => unknown(operationId, failureCode));
      }
    },
    async inspect(raw: unknown) {
      const { operationId } = DockerSandboxesPreparationOperationSchema.parse(raw);
      const observed = await observe(operationId);
      if (!observed) return unknown(operationId, 'docker_sandbox_prepare_inventory_unavailable');
      if (observed.builderPresent) return { kind: 'failed' as const, code: 'docker_sandbox_prepare_cleanup_required', nativeOperationRef: reference({ operationId }) };
      return observed.templatePresent ? ready(operationId) : { kind: 'absent' as const };
    },
    async destroy(raw: { artifact?: unknown; nativeOperation?: unknown }) {
      const artifact = raw.artifact === undefined ? undefined : DockerSandboxesPreparedArtifactSchema.parse(raw.artifact);
      const operation = raw.nativeOperation === undefined ? undefined : DockerSandboxesPreparationOperationSchema.parse(raw.nativeOperation);
      const artifactOperationId = artifact?.templateId.slice(templatePrefix.length);
      if ((!operation && !artifact) || (operation && artifact && operation.operationId !== artifactOperationId)) throw new PluginError({ code: 'invalid_request' });
      const operationId = operation?.operationId ?? artifactOperationId!;
      const observed = await observe(operationId);
      if (!observed) return unknown(operationId, 'docker_sandbox_prepare_inventory_unavailable');
      if (!observed.templatePresent && !observed.builderPresent) return { kind: 'confirmed' as const };
      try {
        // Use the exact owned tag, never an image digest, prefix match or reset.
        if (observed.templatePresent && !completed(await run(['template', 'rm', '--force', `${templatePrefix}${operationId}`]))) {
          return unknown(operationId, 'docker_sandbox_prepare_cleanup_required');
        }
        if (observed.builderPresent) await native.delete({ sandboxName: `${builderPrefix}${operationId}` }, signal);
        const after = await observe(operationId);
        return after && !after.templatePresent && !after.builderPresent ? { kind: 'confirmed' as const }
          : unknown(operationId, 'docker_sandbox_prepare_cleanup_required');
      } catch (error) {
        return projectMachineProvisionerActionFailure(error, () => unknown(operationId, 'docker_sandbox_prepare_cleanup_required'));
      }
    },
  };
}
