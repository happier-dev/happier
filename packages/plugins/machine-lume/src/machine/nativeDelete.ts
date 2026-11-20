import { projectMachineProvisionerGuestCommandFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { LumeNativeResource } from './schemas.js';
import type { LumeNativeMutation } from './nativeClient.js';

/** Mitigation for pinned Lume v0.6.1 (3350f504014c85416009a90fcb339fe556ce02fc):
 * HTTP LumeController.delete stops any cached VM, including an already-stopped
 * VM, and then throws notRunning. Run the same native Delete in a fresh CLI
 * process so its cache is empty. Keep vendor resize/directory guards intact;
 * there is deliberately no HTTP Delete fallback or retry.
 */
export async function deleteLumeNativeVm(input: Readonly<{
  exec: Pick<ExecService, 'run'>; executable: ManagedExecutableRef;
  resource: LumeNativeResource; signal?: AbortSignal;
}>): Promise<LumeNativeMutation> {
  input.signal?.throwIfAborted();
  const process = await input.exec.run({ executable: input.executable,
    args: ['delete', '--force', '--storage', input.resource.storage, '--', input.resource.vmName],
  }, { signal: input.signal });
  const observed = process.termination.observed;
  const exitCode = observed.kind === 'exit' && process.termination.requestedBy.kind === 'none' ? observed.exitCode : null;
  // Delete's awaited exit certifies completion without parsing process output.
  if (exitCode === 0) return { kind: 'delete-accepted', resource: input.resource };
  return { kind: 'unknown', reason: 'native_command_failed', resource: input.resource,
    nativeCause: projectMachineProvisionerGuestCommandFailure({
      command: 'delete', exitCode, stderr: process.stderr, stderrTruncated: process.stderrTruncated,
    }) };
}
