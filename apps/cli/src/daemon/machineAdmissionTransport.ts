import type { CliActionMachineAdmissionTransport } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

/** A local process has no authority to substitute Account admission for this socket. */
export class MachineAdmissionTransportUnavailableError extends Error {
  readonly code = 'machine_admission_transport_unavailable';

  constructor() {
    super('Protected Session input requires the authenticated daemon Machine admission transport. Run this operation through the daemon public Action endpoint, or use the host Session input admission bridge. No input was admitted; retry with the same input identity after the transport is available.');
    this.name = 'MachineAdmissionTransportUnavailableError';
  }
}

let currentTransport: Readonly<{
  serverId: string;
  transport: CliActionMachineAdmissionTransport;
  clientActionExecute?: ActionExecutorDeps['clientActionExecute'];
}> | null = null;

/** The daemon installs its current Machine socket once for process-local Action ingress. */
export function installDaemonMachineAdmissionTransport(
  binding: Readonly<{ serverId: string; transport: CliActionMachineAdmissionTransport; clientActionExecute?: ActionExecutorDeps['clientActionExecute'] }>,
): () => void {
  if (currentTransport) throw new Error('daemon_machine_admission_transport_already_installed');
  currentTransport = binding;
  return () => {
    if (currentTransport === binding) currentTransport = null;
  };
}

export function getDaemonMachineAdmissionTransport(serverId: string): CliActionMachineAdmissionTransport | null {
  return currentTransport?.serverId === serverId ? currentTransport.transport : null;
}

export function getDaemonClientActionExecutor(serverId: string): ActionExecutorDeps['clientActionExecute'] {
  return currentTransport?.serverId === serverId ? currentTransport.clientActionExecute : undefined;
}
