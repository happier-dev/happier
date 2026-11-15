import { readGuestCliFailureOutput } from '@happier-dev/protocol/ssh/commandFailure';
import { SystemTaskExecutionError } from '../runSystemTask.js';

/** The service install owner already probes availability before writing its unit. */
export async function installRemoteDaemonLifecycle(input: Readonly<{
  preferProcess: boolean;
  installService: () => Promise<void>;
}>): Promise<'service' | 'process'> {
  if (input.preferProcess) return 'process';
  try {
    await input.installService();
    return 'service';
  } catch (error) {
    if (!(error instanceof SystemTaskExecutionError)) throw error;
    const cause = error.details?.kind === 'managedService' && 'cause' in error.details ? error.details.cause
      : readGuestCliFailureOutput(error.message, '');
    // Only the existing preflight refusal proves that no service was installed.
    // Permission, startup and other command failures must retain their cause.
    if (cause?.guestCliCode !== 'service_manager_unavailable'
      || cause.serviceStep !== 'preflight' || cause.serviceStepStatus !== 'unavailable') throw error;
    return 'process';
  }
}
